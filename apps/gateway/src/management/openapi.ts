import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { createJsonSchemaTransform } from 'fastify-type-provider-zod';

/** Where the document and the browsable UI live. */
export const DOCS_PREFIX = '/api/docs';

/** Everything under it, so the docs do not document themselves. */
const DOCS_SKIP_LIST = [
  DOCS_PREFIX,
  `${DOCS_PREFIX}/`,
  `${DOCS_PREFIX}/json`,
  `${DOCS_PREFIX}/yaml`,
  `${DOCS_PREFIX}/uiConfig`,
  `${DOCS_PREFIX}/initOAuth`,
  `${DOCS_PREFIX}/*`,
  `${DOCS_PREFIX}/static/*`,
];

const DESCRIPTION = `Admin API for AgentGate.

Every route under \`/api/v1\` requires \`Authorization: Bearer $ADMIN_TOKEN\`, including paths
that do not exist — an unauthenticated caller cannot tell a real route from a typo.

Credential values are write-only: \`POST /api/v1/credentials\` takes one, encrypts it, and no
route in this document ever returns one.`;

/**
 * The OpenAPI document, generated from the same zod schemas the routes validate with — so the
 * document cannot drift from what the gateway actually accepts.
 *
 * Served without the admin token, unlike everything it documents. Two reasons, and the tension
 * between them is real: the UI fetches its own definition from the browser before any operator
 * has typed a token, so a guarded document is a document nobody can read; and the shape of a
 * route is not a secret this system depends on — the token is. What must never be here is data,
 * and a test walks the generated document looking for a credential value to prove it is not.
 *
 * The cost is honest: this publishes the route names that `/api/v1` otherwise refuses to
 * confirm. Set against an admin token that is required on every one of them, that is a map of
 * a locked door.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AgentGate Management API',
        description: DESCRIPTION,
        version: '0.1.0',
      },
      servers: [],
      tags: [
        { name: 'principals', description: 'Who an agent acts for' },
        { name: 'agents', description: 'Registered agents' },
        { name: 'missions', description: 'Scope, budget and deadline — and the tokens for them' },
        { name: 'credentials', description: 'Upstream secrets, write-only' },
        { name: 'approvals', description: 'The human in the loop (D7)' },
        { name: 'audit', description: 'The trail, and the decisions in it' },
        { name: 'stats', description: 'Dashboard counters' },
      ],
      components: {
        securitySchemes: {
          adminToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'The ADMIN_TOKEN the gateway was started with',
          },
        },
      },
      security: [{ adminToken: [] }],
    },
    transform: createJsonSchemaTransform({ skipList: DOCS_SKIP_LIST }),
  });

  await app.register(fastifySwaggerUi, { routePrefix: DOCS_PREFIX });
}
