import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RawServer {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * An HTTP server that answers however a test tells it to — including not at all.
 *
 * The gateway harness cannot produce these: a gateway that accepts a connection and goes silent,
 * or one that answers an approval with a status this SDK has never heard of, are the failures
 * that happen when something *else* is wrong, and they are exactly the ones an agent alone in a
 * sandbox has to survive.
 */
export async function startRawServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<RawServer> {
  const server: Server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      // Sockets held open by a request nobody answered would keep this from resolving.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Accepts the connection, reads the request, and never answers. */
export async function startSilentServer(): Promise<RawServer> {
  return startRawServer(() => {
    // Deliberately nothing.
  });
}
