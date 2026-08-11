import {
  MissionLimitsSchema,
  MissionPermissionsSchema,
  NetworkRulesSchema,
  newId,
} from '@agentgate/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  badRequest,
  conflict,
  errorResponses,
  IdSchema,
  IsoDateTimeSchema,
  MAX_INTENT_LENGTH,
  MAX_NAME_LENGTH,
  notFound,
} from './common.js';
import type { ManagementDeps } from './deps.js';

/**
 * The longest a minted agent token may live, whatever the mission says.
 *
 * A mission is scope; a token is a key to that scope sitting in an agent's environment. Sixty
 * minutes means a leaked token is worth an hour at most even on a mission that runs all day,
 * and re-minting is one management call the SDK already has to be able to make.
 */
export const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;

export const MISSION_STATUSES = ['active', 'expired', 'revoked'] as const;

/**
 * The three scope documents as they are stored. Read back through `z.unknown()` rather than
 * through their own schemas: the columns are Json, nothing in the database guarantees their
 * shape, and a list endpoint that 500s because one old row drifted is a list nobody can use to
 * find the drifted row. They are validated where it matters — on the way in, below.
 */
const StoredDocumentSchema = z.unknown();

const MissionSchema = z.object({
  id: z.string().describe('mis_xxx'),
  principalId: z.string(),
  agentId: z.string(),
  intent: z.string(),
  status: z.string().describe(MISSION_STATUSES.join(' | ')),
  environment: z.string(),
  permissions: StoredDocumentSchema.describe('MissionPermissions, as submitted on create'),
  network: StoredDocumentSchema.describe('NetworkRules, as submitted on create'),
  limits: StoredDocumentSchema.describe('MissionLimits, as submitted on create'),
  expiresAt: z.string(),
  createdAt: z.string(),
});

const MissionDetailSchema = MissionSchema.extend({
  usage: z.object({
    requestCount: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  }),
});

const CreateMissionSchema = z.strictObject({
  principalId: IdSchema,
  agentId: IdSchema,
  intent: z.string().min(1).max(MAX_INTENT_LENGTH),
  // The authoritative schemas, from the package the policy engine reads them with. A mission
  // whose scope the engine could not parse would be denied on every request (D3 step 2), so
  // refusing it here is the difference between a 400 now and a mystery later.
  permissions: MissionPermissionsSchema,
  network: NetworkRulesSchema,
  limits: MissionLimitsSchema,
  expiresAt: IsoDateTimeSchema,
  environment: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
});

const TokenSchema = z.object({
  token: z.string().describe('Ed25519-signed JWT, bound to this one mission (D9)'),
  expiresAt: z.string(),
  sessionId: z.string().describe('ses_xxx'),
});

interface MissionRow {
  id: string;
  principalId: string;
  agentId: string;
  intent: string;
  status: string;
  environment: string;
  permissions: unknown;
  network: unknown;
  limits: unknown;
  expiresAt: Date;
  createdAt: Date;
}

/** The two columns that are not already wire values. */
function toJson<T extends { expiresAt: Date; createdAt: Date }>(
  mission: T,
): Omit<T, 'expiresAt' | 'createdAt'> & { expiresAt: string; createdAt: string } {
  return {
    ...mission,
    expiresAt: mission.expiresAt.toISOString(),
    createdAt: mission.createdAt.toISOString(),
  };
}

export function createMissionRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  /** The mission behind a path parameter, or the 404 that says so. */
  async function loadMission(id: string): Promise<MissionRow> {
    const mission = await deps.prisma.mission.findUnique({ where: { id } });

    if (mission === null) {
      throw notFound(`mission ${id}`);
    }

    return mission;
  }

  return async (app): Promise<void> => {
    app.post(
      '/missions',
      {
        schema: {
          tags: ['missions'],
          summary: 'Issue a mission: what one agent may do, for how long',
          body: CreateMissionSchema,
          response: { 201: MissionSchema, ...errorResponses(400, 401) },
        },
      },
      async (request, reply) => {
        const body = request.body;

        const agent = await deps.prisma.agent.findUnique({
          where: { id: body.agentId },
          select: { id: true, principalId: true },
        });
        if (agent === null) {
          throw badRequest(`agent ${body.agentId} is unknown`);
        }
        if (agent.principalId !== body.principalId) {
          // The mission would name an identity pair the token check later refuses on every
          // request (D9): better to be unable to create it than to create a dead one.
          throw badRequest(
            `agent ${body.agentId} does not belong to principal ${body.principalId}`,
          );
        }

        const expiresAt = new Date(body.expiresAt);
        if (expiresAt.getTime() <= deps.clock().getTime()) {
          throw badRequest('expiresAt is in the past: the mission would grant nothing');
        }

        const mission = await deps.prisma.mission.create({
          data: {
            id: newId('mis'),
            principalId: body.principalId,
            agentId: body.agentId,
            intent: body.intent,
            status: 'active',
            environment: body.environment ?? 'development',
            permissions: body.permissions,
            network: body.network,
            limits: body.limits,
            expiresAt,
          },
        });

        return reply.code(201).send(toJson(mission));
      },
    );

    app.get(
      '/missions',
      {
        schema: {
          tags: ['missions'],
          summary: 'List missions',
          querystring: z.strictObject({
            agentId: IdSchema.optional(),
            principalId: IdSchema.optional(),
            status: z.enum(MISSION_STATUSES).optional(),
          }),
          response: { 200: z.object({ missions: z.array(MissionSchema) }), ...errorResponses(401) },
        },
      },
      async (request) => {
        const { agentId, principalId, status } = request.query;

        const missions = await deps.prisma.mission.findMany({
          where: {
            ...(agentId === undefined ? {} : { agentId }),
            ...(principalId === undefined ? {} : { principalId }),
            ...(status === undefined ? {} : { status }),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });

        return { missions: missions.map(toJson) };
      },
    );

    app.get(
      '/missions/:id',
      {
        schema: {
          tags: ['missions'],
          summary: 'One mission, with what it has spent of its budget',
          params: z.object({ id: IdSchema }),
          response: { 200: MissionDetailSchema, ...errorResponses(401, 404) },
        },
      },
      async (request) => {
        const mission = await loadMission(request.params.id);
        const usage = await deps.prisma.usageCounter.findUnique({
          where: { missionId: mission.id },
        });

        return {
          ...toJson(mission),
          usage: {
            // A mission that has made no request has no counter row yet; zero is the honest
            // reading of that, not "unknown". `bytesTotal` is a bigint column — narrowed here
            // because JSON has one number type and no mission budget approaches 2^53 bytes.
            requestCount: usage?.requestCount ?? 0,
            bytesTotal: Number(usage?.bytesTotal ?? 0n),
          },
        };
      },
    );

    app.post(
      '/missions/:id/expire',
      {
        schema: {
          tags: ['missions'],
          summary: 'Force-expire a mission (SPEC demo case 6)',
          params: z.object({ id: IdSchema }),
          response: { 200: MissionSchema, ...errorResponses(401, 404) },
        },
      },
      async (request) => {
        const mission = await loadMission(request.params.id);

        // Idempotent, and deliberately not a 409: "make sure this mission cannot be used" is
        // the request, and a mission that is already expired satisfies it. The deadline is
        // pulled back too, so nothing downstream reads a row that is expired and yet not due.
        const now = deps.clock();
        const expired = await deps.prisma.mission.update({
          where: { id: mission.id },
          data: {
            status: 'expired',
            ...(mission.expiresAt.getTime() > now.getTime() ? { expiresAt: now } : {}),
          },
        });

        return toJson(expired);
      },
    );

    app.post(
      '/missions/:id/tokens',
      {
        schema: {
          tags: ['missions'],
          summary: 'Mint an agent token for this mission',
          params: z.object({ id: IdSchema }),
          response: { 200: TokenSchema, ...errorResponses(401, 404, 409) },
        },
      },
      async (request) => {
        const mission = await loadMission(request.params.id);
        const now = deps.clock();

        if (mission.expiresAt.getTime() <= now.getTime() && mission.status === 'active') {
          // Marked on first notice, exactly as the pipeline does: a mission past its deadline
          // must not keep reading `active` to whoever looks at it next.
          await deps.prisma.mission.update({
            where: { id: mission.id },
            data: { status: 'expired' },
          });

          throw conflict(`mission ${mission.id} has expired`);
        }
        if (mission.status !== 'active') {
          throw conflict(`mission ${mission.id} is ${mission.status}`);
        }

        const agent = await deps.prisma.agent.findUnique({
          where: { id: mission.agentId },
          select: { agentType: true },
        });
        if (agent === null) {
          throw notFound(`agent ${mission.agentId}`);
        }

        // The token never outlives its mission, and never lives longer than an hour either.
        const ceiling = new Date(now.getTime() + MAX_TOKEN_TTL_MS);
        const expiresAt = mission.expiresAt < ceiling ? mission.expiresAt : ceiling;
        const sessionId = newId('ses');

        const token = await deps.tokenService.mint(
          {
            agentId: mission.agentId,
            principalId: mission.principalId,
            agentType: agent.agentType,
            missionId: mission.id,
            sessionId,
          },
          expiresAt,
        );

        return { token, expiresAt: expiresAt.toISOString(), sessionId };
      },
    );
  };
}
