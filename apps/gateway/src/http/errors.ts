import { AgentGateError } from '@agentgate/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * What the caller is told when the framework refused the body before any route saw it.
 *
 * Fastify's own wording is not reused: the message for a malformed document is V8's parse
 * error, which quotes the input it choked on — a body that failed to parse is still a body
 * somebody sent, and echoing a fragment of it back is not something this gateway does.
 */
const CONTENT_TYPE_REFUSAL: Record<string, string> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: 'request body is empty, but the content type announces one',
  FST_ERR_CTP_INVALID_JSON_BODY: 'request body is not well formed json',
  FST_ERR_CTP_INVALID_MEDIA_TYPE:
    'content type is not one this API can read: send application/json',
  FST_ERR_CTP_BODY_TOO_LARGE: 'request body is larger than the gateway will read',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'content length does not describe the body that arrived',
};

/**
 * Turns the framework's body-parsing failures into refusals this API can express.
 *
 * Without this every one of them is an unrecognised error and therefore a 500, which is the
 * wrong answer twice over: it blames the gateway for what the caller sent, and it hides a
 * mistyped request among the failures that are worth paging somebody about. A browser `fetch`
 * with a JSON content type and no body — what a button in the web UI sends — is exactly this
 * case. The enforcement path solved the same problem with a parser that never throws; the
 * management tree needs the framework's parser, so it translates instead.
 *
 * Fastify's own `statusCode` is what decides: 400 for a body it could not read, 415 for a media
 * type it has no parser for, 413 for one too large. Getting that from the error rather than
 * from a table here means a code this list does not name still lands on the right status.
 */
function fromContentTypeError(error: unknown): AgentGateError | null {
  const failure = error as { code?: unknown; statusCode?: unknown } | null;

  if (typeof failure?.code !== 'string' || !failure.code.startsWith('FST_ERR_CTP_')) {
    return null;
  }

  const status = typeof failure.statusCode === 'number' ? failure.statusCode : 400;

  return new AgentGateError(
    'agentgate_validation_error',
    status,
    CONTENT_TYPE_REFUSAL[failure.code] ?? 'request body could not be read',
    { cause: error },
  );
}

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
  const failure = error instanceof AgentGateError ? error : (fromContentTypeError(error) ?? error);

  if (failure instanceof AgentGateError) {
    // The original is logged, not the translation: the framework's own message and stack are
    // where the real reason lives, and what the caller is told is deliberately thinner than
    // what an operator can read.
    request.log.warn({ err: error, code: failure.code }, 'request refused');

    return reply.code(failure.httpStatus).send(failure.toBody(requestId));
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
