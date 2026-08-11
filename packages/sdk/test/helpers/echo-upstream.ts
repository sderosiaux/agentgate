import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EchoUpstream {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * An upstream that answers with what it was asked, so a test can see the request as it left the
 * gateway. The mock GitHub cannot do this — it answers with fixtures — and "the header I set
 * arrived" is only observable from the other side of the hop.
 *
 * `/repos/acme/payments/pulls` answers `text/plain`, which is how a body that is not JSON gets
 * in front of `response.json()`.
 */
export async function startEchoUpstream(): Promise<EchoUpstream> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/repos/acme/payments/pulls') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not json at all');

      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        method: request.method,
        path: request.url,
        headers: request.headers,
      }),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
