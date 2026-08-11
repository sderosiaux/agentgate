import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from './common.js';
import type { ManagementDeps } from './deps.js';

const OverviewSchema = z.object({
  activeAgents: z.number().int().nonnegative().describe('Agents holding a mission that is live now'),
  activeMissions: z.number().int().nonnegative(),
  requestsToday: z.number().int().nonnegative(),
  allowedToday: z.number().int().nonnegative(),
  deniedToday: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
});

/**
 * The start of the UTC day containing `now`.
 *
 * UTC rather than a local zone, because "today" has to mean the same thing to the gateway, to
 * the trail it is counting and to whoever reads the number from another continent.
 */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function createStatsRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.get(
      '/stats/overview',
      {
        schema: {
          tags: ['stats'],
          summary: 'The six numbers the dashboard opens with',
          response: { 200: OverviewSchema, ...errorResponses(401) },
        },
      },
      async () => {
        const now = deps.clock();
        const since = startOfUtcDay(now);

        // A mission is live when its row says so *and* its deadline has not passed: the status
        // column is only corrected when something touches the mission, so trusting it alone
        // would count missions that expired quietly overnight.
        const live = { status: 'active', expiresAt: { gt: now } } as const;

        const [activeMissions, agents, requestsToday, allowedToday, deniedToday, pendingApprovals] =
          await Promise.all([
            deps.prisma.mission.count({ where: live }),
            // Distinct agents rather than a count of missions: one agent running three missions
            // is one agent.
            deps.prisma.mission.findMany({
              where: live,
              distinct: ['agentId'],
              select: { agentId: true },
            }),
            deps.prisma.auditEvent.count({ where: { timestamp: { gte: since } } }),
            deps.prisma.auditEvent.count({
              where: { timestamp: { gte: since }, decision: 'ALLOW' },
            }),
            deps.prisma.auditEvent.count({ where: { timestamp: { gte: since }, decision: 'DENY' } }),
            deps.prisma.approval.count({ where: { status: 'pending' } }),
          ]);

        return {
          activeAgents: agents.length,
          activeMissions,
          requestsToday,
          allowedToday,
          deniedToday,
          pendingApprovals,
        };
      },
    );
  };
}
