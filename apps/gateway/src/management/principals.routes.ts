import { newId } from '@agentgate/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses, MAX_NAME_LENGTH } from './common.js';
import type { ManagementDeps } from './deps.js';

const PrincipalSchema = z.object({
  id: z.string().describe('pri_xxx'),
  name: z.string(),
});

const CreatePrincipalSchema = z.strictObject({
  name: z.string().min(1).max(MAX_NAME_LENGTH).describe('Who the agent acts for'),
});

/**
 * A principal is the human or team an agent acts on behalf of (SPEC identity model). It carries
 * no permissions of its own — scope lives on the mission — so creating one grants nothing.
 */
export function createPrincipalRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.post(
      '/principals',
      {
        schema: {
          tags: ['principals'],
          summary: 'Create a principal',
          body: CreatePrincipalSchema,
          response: { 201: PrincipalSchema, ...errorResponses(400, 401) },
        },
      },
      async (request, reply) => {
        const principal = await deps.prisma.principal.create({
          data: { id: newId('pri'), name: request.body.name },
        });

        return reply.code(201).send(principal);
      },
    );

    app.get(
      '/principals',
      {
        schema: {
          tags: ['principals'],
          summary: 'List principals',
          response: {
            200: z.object({ principals: z.array(PrincipalSchema) }),
            ...errorResponses(401),
          },
        },
      },
      async () => ({
        // Small by nature — a principal is a team, not a request — so this one list is not
        // paginated. The lists that grow without bound are audit and approvals.
        principals: await deps.prisma.principal.findMany({ orderBy: { id: 'asc' } }),
      }),
    );
  };
}
