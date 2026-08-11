import { AgentGateError, type HttpMethod } from '@agentgate/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { handleProxyRequest, type PipelineDeps, type ProxyRequestBody } from './pipeline.js';

/**
 * Pinned to the shared `HttpMethod`: the mission network rules are written with these spellings,
 * so a method this list accepts and that list does not would be a rule nobody can write.
 */
const MethodSchema: z.ZodType<HttpMethod> = z.enum([
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * The agent-facing contract (D1). Strict: a field the gateway does not understand is a request
 * it cannot reason about, and answering it anyway is how an unchecked knob gets shipped.
 */
const ProxyRequestSchema = z.strictObject({
  credential: z.string().min(1),
  method: MethodSchema,
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  approvalId: z.string().optional(),
});

/** A body a 204 or a 304 must not carry, and that `reply.send` would otherwise re-add. */
function hasNoBody(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

export function createProxyRoutes(deps: PipelineDeps): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.post('/v1/proxy', async (request, reply) => {
      const parsed = ProxyRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        // Before the pipeline, so before the audit row: there is no attempt to record yet —
        // the gateway never learned which credential, mission or url was meant.
        throw new AgentGateError(
          'agentgate_validation_error',
          400,
          'proxy request body is not well formed',
          { cause: parsed.error },
        );
      }

      const outcome = await handleProxyRequest(
        deps,
        request.id,
        request.headers.authorization,
        parsed.data as ProxyRequestBody,
      );

      void reply.code(outcome.status).headers(outcome.headers);

      return hasNoBody(outcome.status) ? reply.send() : reply.send(outcome.body);
    });
  };
}
