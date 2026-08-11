import Fastify, { type FastifyInstance } from 'fastify';

export interface EchoedRequest {
  method: string;
  /** The path and query exactly as the upstream received them. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
}

export interface EchoUpstream {
  baseUrl: string;
  /** Every request the upstream saw, in order. */
  received: EchoedRequest[];
  close(): Promise<void>;
}

/**
 * An upstream that answers with what it was sent. `buildMockGithub` proves the credential is
 * usable; this proves what exactly travels — which headers, which url, which body.
 */
export async function startEchoUpstream(): Promise<EchoUpstream> {
  const received: EchoedRequest[] = [];
  const app: FastifyInstance = Fastify();

  // Bodies stay raw strings: the point is to compare bytes, not to parse them. The built-in
  // json parser has to go first, otherwise it claims every `application/json` body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  // An upstream that takes longer than any timeout a test would set.
  app.all('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return { echoed: true };
  });

  // Bytes that are not text: a PNG header, which no utf-8 decoder can carry through.
  app.all('/binary', async (_request, reply) =>
    reply.type('image/png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  );

  app.all('/*', async (request, reply) => {
    received.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: typeof request.body === 'string' ? request.body : null,
    });

    // Reflects what it was sent, in the body and in a safelisted response header. An upstream
    // that hands the injected credential straight back is the case the gateway has to survive:
    // whatever comes back reaches the agent, and the agent must never hold a credential.
    // `bare` drops the scheme, so the reflection is the credential itself rather than the
    // header it travelled in: a scrub that only knew how to match `Bearer <value>` would miss it.
    const bare = String(request.headers.authorization ?? '').replace(/^Bearer /i, '');

    return reply
      .header('set-cookie', 'session=must-not-come-back')
      .header('x-secret-upstream-header', 'must-not-come-back')
      .header('etag', String(request.headers.authorization ?? 'none'))
      .header('link', bare)
      .send({ echoed: true, headers: request.headers, bare });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('echo upstream did not bind a tcp port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: () => app.close(),
  };
}
