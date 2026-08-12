import { randomUUID } from 'node:crypto';
import { createTokenService } from '@agentgate/auth';
import { buildMockGithub } from '@agentgate/mock-github';
import { createBuiltinEngine, githubAdapter } from '@agentgate/policy';
import type { MissionLimits, MissionPermissions, NetworkRules } from '@agentgate/shared';
import { buildApp } from '@agentgate/gateway/dist/app.js';
import { createApprovalService } from '@agentgate/gateway/dist/approvals/service.js';
import { createAuditRecorder } from '@agentgate/gateway/dist/audit/recorder.js';
import { createPrismaClient } from '@agentgate/gateway/dist/db.js';
import { createLogger } from '@agentgate/gateway/dist/logging.js';
import {
  createDbSecretStore,
  encryptSecret,
  type InjectionSpec,
} from '@agentgate/gateway/dist/secrets/index.js';
import type { AddressInfo } from 'node:net';
import { AgentGate } from '../../src/index.js';

/**
 * A gateway the SDK talks to over a real socket.
 *
 * `app.inject` is how the gateway's own suite drives it, and it is the wrong tool here: the SDK
 * is a `fetch` client, and half of what it does — status mapping, header casing, a body read as
 * text — only exists on the wire. So this harness builds the same app `index.ts` builds, binds
 * it to a loopback port and hands back a client pointed at it.
 *
 * The upstream token below is this harness's own fixture. The SDK never sees it, and neither
 * does anything it hands back: it exists so the in-process mock GitHub has something to demand.
 */
const UPSTREAM_TOKEN = 'sdk-harness-upstream-token';

const ADMIN_TOKEN = 'sdk-harness-admin-token';

const MASTER_KEY = Buffer.alloc(32, 0x3a).toString('base64');

/** The alias is generated per harness, so it is filled in where the mission is written. */
export const DEFAULT_PERMISSIONS: Omit<MissionPermissions, 'allowedCredentials'> = {
  resources: ['github:acme/payments'],
  allowedActions: ['repo.read', 'issue.read', 'pull_request.read', 'pull_request.create'],
  approvalActions: ['pull_request.create'],
  deniedActions: ['pull_request.merge', 'repository.delete'],
};

export const DEFAULT_NETWORK: NetworkRules = {
  allow: [
    { host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET'] },
    { host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] },
  ],
  deny: [],
};

export const DEFAULT_LIMITS: MissionLimits = {
  maxRequests: 500,
  maxBytes: 50_000_000,
  requestsPerMinute: 600,
};

const DEFAULT_INJECTION: InjectionSpec = {
  type: 'header',
  name: 'Authorization',
  format: 'Bearer {value}',
};

export interface HarnessOptions {
  permissions?: Omit<MissionPermissions, 'allowedCredentials'>;
  network?: NetworkRules;
  limits?: MissionLimits;
  /** When the *mission* runs out. The token always has an hour, so the two can be told apart. */
  expiresAt?: Date;
  /** Points the credential somewhere other than the mock GitHub started for this harness. */
  upstreamBaseUrl?: string;
}

export interface Harness {
  gate: AgentGate;
  baseUrl: string;
  alias: string;
  missionId: string;
  token: string;
  /** A call on the management tree, with the harness admin token. */
  admin(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

// Structural rather than `FastifyInstance`: fastify is not a dependency of this package, and an
// agent-side SDK acquiring a server framework to run its tests would be the wrong trade.
function addressOf(app: { server: { address(): string | AddressInfo | null } }): string {
  const address = app.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a tcp port');
  }

  return `http://127.0.0.1:${String(address.port)}`;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const principalId = `pri_sdk_${suffix}`;
  const agentId = `agt_sdk_${suffix}`;
  const missionId = `mis_sdk_${suffix}`;
  const alias = `sdk_cred_${suffix}`;

  const prisma = createPrismaClient();

  const upstream = buildMockGithub({ token: UPSTREAM_TOKEN, logger: false });
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamBaseUrl = options.upstreamBaseUrl ?? addressOf(upstream);

  await prisma.principal.create({ data: { id: principalId, name: `SDK ${suffix}` } });
  await prisma.agent.create({ data: { id: agentId, principalId, agentType: 'codex' } });

  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  await prisma.mission.create({
    data: {
      id: missionId,
      principalId,
      agentId,
      intent: 'Investigate issue #423 and create a pull request',
      status: 'active',
      label: 'development',
      permissions: {
        ...(options.permissions ?? DEFAULT_PERMISSIONS),
        allowedCredentials: [alias],
      } satisfies MissionPermissions,
      network: options.network ?? DEFAULT_NETWORK,
      limits: options.limits ?? DEFAULT_LIMITS,
      expiresAt,
    },
  });

  await prisma.credential.create({
    data: {
      id: `cred_sdk_${suffix}`,
      alias,
      provider: 'github',
      logicalHost: 'api.github.com',
      upstreamBaseUrl,
      injection: DEFAULT_INJECTION,
      ciphertext: encryptSecret(MASTER_KEY, UPSTREAM_TOKEN),
      status: 'active',
    },
  });

  const tokenService = createTokenService(
    process.env['AGENTGATE_JWT_PRIVATE_KEY'],
    process.env['AGENTGATE_JWT_PUBLIC_KEY'] ?? '',
  );

  const app = buildApp({
    prisma,
    tokenService,
    secretStore: createDbSecretStore(prisma, MASTER_KEY),
    engine: createBuiltinEngine(),
    adapters: [githubAdapter],
    approvals: createApprovalService(prisma, () => new Date()),
    audit: createAuditRecorder(prisma),
    clock: () => new Date(),
    environment: 'development',
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    canMintTokens: true,
    logger: createLogger({ level: 'silent' }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = addressOf(app);

  // Deliberately not the mission's deadline: a test about an expired mission needs a token that
  // is still valid, or the gateway would refuse it one step earlier and prove nothing.
  const token = await tokenService.mint(
    { agentId, principalId, agentType: 'codex', missionId, sessionId: `ses_${suffix}` },
    new Date(Date.now() + 60 * 60 * 1000),
  );

  return {
    gate: new AgentGate({ gatewayUrl: baseUrl, token }),
    baseUrl,
    alias,
    missionId,
    token,

    async admin(method, path, body) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        // Every management POST needs a body, even when there is nothing to say: a JSON content
        // type with no payload is a 400 on that tree.
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    },

    async close() {
      await app.close();
      await upstream.close();
      await prisma.approval.deleteMany({ where: { missionId } });
      await prisma.rateWindow.deleteMany({ where: { missionId } });
      await prisma.usageCounter.deleteMany({ where: { missionId } });
      await prisma.mission.deleteMany({ where: { id: missionId } });
      await prisma.credential.deleteMany({ where: { alias } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.principal.deleteMany({ where: { id: principalId } });
      await prisma.$disconnect();
    },
  };
}
