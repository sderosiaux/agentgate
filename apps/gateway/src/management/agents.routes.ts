import { newId } from '@agentgate/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUDIT_DECISIONS } from '../audit/recorder.js';
import { badRequest, errorResponses, IdSchema, notFound } from './common.js';
import type { ManagementDeps } from './deps.js';

/**
 * The agent kinds the demo knows about. An enum rather than free text: `agentType` reaches the
 * policy engine as part of the identity, and a rule written for `claude-code` must not be
 * silently sidestepped by an agent registering itself as `Claude-Code`.
 */
export const AGENT_TYPES = ['codex', 'claude-code', 'ci', 'custom'] as const;

/** How much of the trail an agent's detail page carries with it. */
const RECENT_AUDIT_LIMIT = 10;

const AgentSchema = z.object({
  id: z.string().describe('agt_xxx'),
  principalId: z.string(),
  agentType: z.string(),
  createdAt: z.string().describe('ISO 8601'),
});

const ActiveMissionSchema = z
  .object({
    id: z.string(),
    intent: z.string(),
    status: z.string(),
    expiresAt: z.string(),
  })
  .nullable();

const RecentDecisionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  timestamp: z.string(),
  decision: z.string(),
  reason: z.string(),
  resource: z.string().nullable(),
  action: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
});

const AgentDetailSchema = AgentSchema.extend({
  activeMission: ActiveMissionSchema,
  recentAudit: z.object({
    total: z.number().int().nonnegative(),
    byDecision: z.record(z.string(), z.number().int().nonnegative()),
    events: z.array(RecentDecisionSchema),
  }),
});

const CreateAgentSchema = z.strictObject({
  principalId: IdSchema,
  agentType: z.enum(AGENT_TYPES),
});

export function createAgentRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.post(
      '/agents',
      {
        schema: {
          tags: ['agents'],
          summary: 'Register an agent',
          body: CreateAgentSchema,
          response: { 201: AgentSchema, ...errorResponses(400, 401) },
        },
      },
      async (request, reply) => {
        // Checked rather than left to the foreign key: a constraint violation surfaces as a
        // 500 that says nothing, and "which principal" is the only useful thing to say here.
        const principal = await deps.prisma.principal.findUnique({
          where: { id: request.body.principalId },
          select: { id: true },
        });
        if (principal === null) {
          throw badRequest(`principal ${request.body.principalId} is unknown`);
        }

        const agent = await deps.prisma.agent.create({
          data: {
            id: newId('agt'),
            principalId: request.body.principalId,
            agentType: request.body.agentType,
          },
        });

        return reply.code(201).send({ ...agent, createdAt: agent.createdAt.toISOString() });
      },
    );

    app.get(
      '/agents',
      {
        schema: {
          tags: ['agents'],
          summary: 'List agents',
          querystring: z.strictObject({ principalId: IdSchema.optional() }),
          response: { 200: z.object({ agents: z.array(AgentSchema) }), ...errorResponses(401) },
        },
      },
      async (request) => {
        const agents = await deps.prisma.agent.findMany({
          where: request.query.principalId === undefined ? {} : { principalId: request.query.principalId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });

        return { agents: agents.map((agent) => ({ ...agent, createdAt: agent.createdAt.toISOString() })) };
      },
    );

    app.get(
      '/agents/:id',
      {
        schema: {
          tags: ['agents'],
          summary: 'One agent, with what it is currently allowed to do and what it has done',
          params: z.object({ id: IdSchema }),
          response: { 200: AgentDetailSchema, ...errorResponses(401, 404) },
        },
      },
      async (request) => {
        const agent = await deps.prisma.agent.findUnique({ where: { id: request.params.id } });
        if (agent === null) {
          throw notFound(`agent ${request.params.id}`);
        }

        const now = deps.clock();
        const [activeMission, counts, events] = await Promise.all([
          // "Active" is a fact about the clock as well as the column: a mission whose deadline
          // has passed is not one this agent can still use, whatever the row says.
          deps.prisma.mission.findFirst({
            where: { agentId: agent.id, status: 'active', expiresAt: { gt: now } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, intent: true, status: true, expiresAt: true },
          }),
          deps.prisma.auditEvent.groupBy({
            by: ['decision'],
            where: { agentId: agent.id },
            _count: { _all: true },
          }),
          deps.prisma.auditEvent.findMany({
            where: { agentId: agent.id },
            orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
            take: RECENT_AUDIT_LIMIT,
            select: {
              id: true,
              requestId: true,
              timestamp: true,
              decision: true,
              reason: true,
              resource: true,
              action: true,
              httpStatus: true,
            },
          }),
        ]);

        // Every decision spelled out, including the ones with no rows: a dashboard that hides
        // "denied: 0" and "denied: (missing)" behind the same blank is a dashboard nobody can
        // read.
        const byDecision: Record<string, number> = Object.fromEntries(
          AUDIT_DECISIONS.map((decision) => [decision, 0]),
        );
        for (const row of counts) {
          byDecision[row.decision] = row._count._all;
        }

        return {
          ...agent,
          createdAt: agent.createdAt.toISOString(),
          activeMission:
            activeMission === null
              ? null
              : { ...activeMission, expiresAt: activeMission.expiresAt.toISOString() },
          recentAudit: {
            total: Object.values(byDecision).reduce((sum, count) => sum + count, 0),
            byDecision,
            events: events.map((event) => ({
              ...event,
              timestamp: event.timestamp.toISOString(),
            })),
          },
        };
      },
    );
  };
}
