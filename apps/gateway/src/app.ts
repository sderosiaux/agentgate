import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { newId } from '@agentgate/shared';

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  // Request ids are AgentGate ids: the same value is echoed as `request_id` in error
  // bodies and stored on every audit event.
  const app = Fastify({ genReqId: () => newId('req'), ...options });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
