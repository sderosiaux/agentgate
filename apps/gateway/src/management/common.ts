import { AgentGateError } from '@agentgate/shared';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination.js';

// Re-exported so a route file has one place to import from: the zod query fields below and the
// keyset helpers are two halves of the same feature.
export { olderThan, pageOf } from '../pagination.js';

/** Bounds on every identifier a caller may hand this API. Ours are 24 characters. */
export const MAX_ID_LENGTH = 128;

/** Long enough for a human-written name or intent, short enough not to be storage. */
export const MAX_NAME_LENGTH = 200;
export const MAX_INTENT_LENGTH = 2_000;

export const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/** ISO 8601 with a zone, either spelling. A local time is a time nobody can act on. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * The two query parameters every list takes. `limit` is capped rather than trusted: a
 * management API that answers `?limit=1000000` is a way to make the gateway read the whole
 * audit table on demand.
 */
export const PageQueryFields = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: IdSchema.optional(),
};

/** The error body every refusal on this tree carries (`AgentGateError.toBody`). */
export const ErrorBodySchema = z.object({
  error: z.string(),
  decision: z.string().optional(),
  reason: z.string(),
  request_id: z.string(),
});

/**
 * Declared on every route rather than left implicit: the OpenAPI document is what the web UI
 * and the demo are written against, and "what does this answer when it says no" is half of
 * what a client has to handle.
 */
export function errorResponses(...codes: number[]): Record<number, typeof ErrorBodySchema> {
  return Object.fromEntries(codes.map((code) => [code, ErrorBodySchema]));
}

export function notFound(what: string): AgentGateError {
  return new AgentGateError('agentgate_not_found', 404, `${what} is unknown`);
}

/**
 * A request this API understood and will not carry out, because of the state it found.
 *
 * Its own code rather than the validation one: "the alias you sent is not a string" and "the
 * alias you sent already names a credential" are the same status only by accident, and a client
 * that retries the second after fixing nothing is a client the first code told to do that.
 */
export function conflict(reason: string): AgentGateError {
  return new AgentGateError('agentgate_conflict', 409, reason);
}

export function badRequest(reason: string): AgentGateError {
  return new AgentGateError('agentgate_validation_error', 400, reason);
}

/** The `nextCursor` field, on every paginated answer. */
export const NextCursorSchema = z.string().nullable();
