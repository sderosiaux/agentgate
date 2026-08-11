import { createHash, timingSafeEqual } from 'node:crypto';
import { AgentGateError } from '@agentgate/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { parseBearer } from '../http/bearer.js';
import { replyWithError } from '../http/errors.js';
import { registerSensitive } from '../logging.js';
import { createAgentRoutes } from './agents.routes.js';
import { createApprovalManagementRoutes } from './approvals.routes.js';
import { createAuditRoutes } from './audit.routes.js';
import { createCredentialRoutes } from './credentials.routes.js';
import type { ManagementDeps } from './deps.js';
import { createMissionRoutes } from './missions.routes.js';
import { registerOpenApi } from './openapi.js';
import { createPrincipalRoutes } from './principals.routes.js';
import { createStatsRoutes } from './stats.routes.js';

export type { ManagementDeps };

/** Everything the management API answers lives under this. Nothing else does. */
export const API_PREFIX = '/api/v1';

/**
 * Compared as digests rather than as strings: `timingSafeEqual` throws on a length mismatch,
 * so comparing the raw values would answer "how long is the admin token" to anyone willing to
 * send a few requests. Two SHA-256 digests are always the same length and always compared in
 * constant time.
 */
function tokenMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}

/**
 * What a caller is told when its input does not fit the schema.
 *
 * Specific, unlike the agent-facing refusals: this API is used by a human writing a mission
 * document by hand, and "body is not well formed" with no field name is a guessing game. The
 * issue messages are zod's own and never quote the submitted value, so a mistyped credential
 * cannot be echoed back out of the gateway.
 */
function validationRefusal(error: {
  validationContext?: string | undefined;
  validation: { instancePath?: string | undefined; message?: string | undefined }[];
}): AgentGateError {
  const where = error.validationContext ?? 'request';
  const issues = error.validation
    .map((issue) => {
      const at = issue.instancePath === undefined || issue.instancePath === '/' ? '' : `${issue.instancePath}: `;

      return `${at}${issue.message ?? 'invalid'}`;
    })
    .join('; ');

  return new AgentGateError(
    'agentgate_validation_error',
    400,
    `${where} is not well formed (${issues})`,
    { cause: error },
  );
}

/**
 * The management tree (D11). Separate plugin, separate wiring, separate credential: nothing in
 * enforcement imports anything from here, so the code that decides whether a request may go
 * through cannot be reached by the code that answers a human's browser.
 */
export function createManagementRoutes(deps: ManagementDeps): FastifyPluginAsync {
  // Taught to the scrubber here rather than at the call site: the tree that holds the admin
  // token is the tree that guarantees no log line can carry it, however it gets there.
  registerSensitive(deps.adminToken);

  return async (app: FastifyInstance): Promise<void> => {
    // Registered above the guard, so the document — and only the document — is readable without
    // a token. See `openapi.ts` for why. Its `onRoute` hook still sees everything below.
    await registerOpenApi(app);

    await app.register(async (guarded: FastifyInstance): Promise<void> => {
      // Zod validates what comes in and serialises what goes out. The serialiser is the second
      // half of "a credential value is never returned": a response schema that does not name a
      // field drops it, so a handler that accidentally selects the ciphertext cannot publish it.
      guarded.setValidatorCompiler(validatorCompiler);
      guarded.setSerializerCompiler(serializerCompiler);

      guarded.setErrorHandler(async (error, request, reply) =>
        replyWithError(
          request,
          reply,
          hasZodFastifySchemaValidationErrors(error) ? validationRefusal(error) : error,
        ),
      );

      // onRequest: before a body is read, before a route handler exists. An unauthenticated
      // caller must not be able to make the gateway parse anything it sent.
      guarded.addHook('onRequest', async (request) => {
        const presented = parseBearer(request.headers.authorization);

        if (presented === undefined || !tokenMatches(deps.adminToken, presented)) {
          // One answer for a missing token and a wrong one: which of the two it was is not
          // something a caller needs, and telling it apart is free reconnaissance.
          request.log.warn({ url: request.url }, 'management request refused');

          throw new AgentGateError('agentgate_invalid_token', 401, 'Admin token is invalid');
        }
      });

      const typed = guarded.withTypeProvider<ZodTypeProvider>();

      for (const routes of [
        createPrincipalRoutes(deps),
        createAgentRoutes(deps),
        createMissionRoutes(deps),
        createCredentialRoutes(deps),
        createApprovalManagementRoutes(deps),
        createAuditRoutes(deps),
        createStatsRoutes(deps),
      ]) {
        await typed.register(routes, { prefix: API_PREFIX });
      }

      // The catch-all, and the reason it is a route rather than a not-found handler: hooks run
      // for routes. Without it, `/api/v1/does-not-exist` fell through to the application-wide
      // 404 without ever meeting the guard above — so an unauthenticated caller got 404 for a
      // path that does not exist and 401 for one that does, and could enumerate the whole
      // management API by the difference. Everything under `/api/v1` needs the token first;
      // only a caller that has it learns which routes are real.
      const enumerationGuard = async (): Promise<never> => {
        throw new AgentGateError('agentgate_not_found', 404, 'no such route');
      };

      guarded.all(API_PREFIX, { schema: { hide: true } }, enumerationGuard);
      guarded.all(`${API_PREFIX}/*`, { schema: { hide: true } }, enumerationGuard);
    });
  };
}
