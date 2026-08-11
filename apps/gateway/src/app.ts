import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
