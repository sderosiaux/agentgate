import { AgentGateError } from '@agentgate/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The one way this gateway answers a failed request.
 *
 * Written once and used by both plugin trees: an `AgentGateError` is a refusal the gateway
 * stands behind and says out loud, and anything else is a bug the caller learns nothing about
 * beyond its request id. Two error handlers spelling that out separately is two chances for one
 * of them to start leaking a stack trace.
 */
export async function replyWithError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): Promise<FastifyReply> {
  const requestId = String(request.id);

  if (error instanceof AgentGateError) {
    // Logged with its cause, which is where the real reason lives: what the caller is told is
    // deliberately thinner than what an operator can read.
    request.log.warn({ err: error, code: error.code }, 'request refused');

    return reply.code(error.httpStatus).send(error.toBody(requestId));
  }

  request.log.error({ err: error }, 'request failed');

  return reply
    .code(500)
    .send(
      new AgentGateError('agentgate_upstream_error', 500, 'the gateway could not answer').toBody(
        requestId,
      ),
    );
}
