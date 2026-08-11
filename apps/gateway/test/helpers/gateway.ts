import { randomUUID } from 'node:crypto';
import { createTokenService, type AgentClaims, type TokenService } from '@agentgate/auth';
import { buildMockGithub } from '@agentgate/mock-github';
import { createBuiltinEngine, githubAdapter, type PolicyEngine } from '@agentgate/policy';
import type { MissionLimits, MissionPermissions, NetworkRules } from '@agentgate/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createApprovalService, type ApprovalService } from '../../src/approvals/service.js';
import { createPrismaClient, type PrismaClient } from '../../src/db.js';
import { createAuditRecorder } from '../../src/audit/recorder.js';
import { createLogger } from '../../src/logging.js';
import { createDbSecretStore, encryptSecret, type InjectionSpec } from '../../src/secrets/index.js';

/** Long enough to be registered by the log scrubber, and unmistakable in a grep. */
export const UPSTREAM_TOKEN = 'harness-upstream-secret-token';

/** What the management tree is guarded by for the duration of a test. */
export const ADMIN_TOKEN = 'harness-admin-token';

export const MASTER_KEY = Buffer.alloc(32, 0x5c).toString('base64');

export const DEFAULT_PERMISSIONS: MissionPermissions = {
  resources: ['github:acme/payments'],
  allowedActions: [
    'repo.read',
    'issue.read',
    'pull_request.read',
    'branch.create',
    'pull_request.create',
  ],
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
  requestsPerMinute: 60,
};

const DEFAULT_INJECTION: InjectionSpec = {
  type: 'header',
  name: 'Authorization',
  format: 'Bearer {value}',
};

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

export interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  requestId: string | undefined;
}

export interface HarnessOptions {
  permissions?: MissionPermissions;
  network?: NetworkRules;
  limits?: MissionLimits;
  missionStatus?: string;
  expiresAt?: Date;
  credentialStatus?: string;
  logicalHost?: string;
  injection?: InjectionSpec;
  /** Points the credential somewhere other than the mock GitHub started for this harness. */
  upstreamBaseUrl?: string;
  engine?: PolicyEngine;
  /** What the pipeline reads as "now". Mutable, so a test can move the clock. */
  now?: Date;
}

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
  tokenService: TokenService;
  approvals: ApprovalService;
  principalId: string;
  agentId: string;
  missionId: string;
  alias: string;
  /** Every request the mock GitHub saw, whether it answered it or refused it. */
  upstreamRequests: UpstreamRequest[];
  /** Raw log lines the gateway wrote during the test. */
  logLines: string[];
  clock: { now: Date };
  mint(claims?: Partial<AgentClaims>, expiresAt?: Date): Promise<string>;
  proxy(body: unknown, token: string | undefined): Promise<InjectedResponse>;
  /** The agent-facing read of an approval, with the agent's own token by default. */
  approvalStatus(approvalId: string, token: string): Promise<InjectedResponse>;
  /** A call on the management tree, with the harness admin token unless another is given. */
  admin(
    method: 'GET' | 'POST',
    url: string,
    options?: { body?: unknown; token?: string | undefined },
  ): Promise<InjectedResponse>;
  close(): Promise<void>;
}

/**
 * A gateway wired exactly as `index.ts` wires it, against the test database and an in-process
 * mock GitHub. Every row it creates is its own, so tests never fight over the demo seed.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const principalId = `pri_test_${suffix}`;
  const agentId = `agt_test_${suffix}`;
  const missionId = `mis_test_${suffix}`;
  const alias = `test_cred_${suffix}`;

  const prisma = createPrismaClient();

  const upstreamRequests: UpstreamRequest[] = [];
  const upstream = buildMockGithub({ token: UPSTREAM_TOKEN, logger: false });
  // onResponse rather than onRequest: it also fires for the requests the mock refuses, which is
  // what "the upstream was never reached" has to be measured against.
  upstream.addHook('onResponse', async (request) => {
    upstreamRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      requestId:
        typeof request.headers['x-request-id'] === 'string'
          ? request.headers['x-request-id']
          : undefined,
    });
  });
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock github did not bind a tcp port');
  }
  const upstreamBaseUrl = options.upstreamBaseUrl ?? `http://127.0.0.1:${String(address.port)}`;

  await prisma.principal.create({ data: { id: principalId, name: `Test ${suffix}` } });
  await prisma.agent.create({ data: { id: agentId, principalId, agentType: 'codex' } });

  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  await prisma.mission.create({
    data: {
      id: missionId,
      principalId,
      agentId,
      intent: 'Investigate issue #423 and create a pull request',
      status: options.missionStatus ?? 'active',
      environment: 'development',
      permissions: options.permissions ?? DEFAULT_PERMISSIONS,
      network: options.network ?? DEFAULT_NETWORK,
      limits: options.limits ?? DEFAULT_LIMITS,
      expiresAt,
    },
  });

  await prisma.credential.create({
    data: {
      id: `cred_test_${suffix}`,
      alias,
      provider: 'github',
      logicalHost: options.logicalHost ?? 'api.github.com',
      upstreamBaseUrl,
      injection: options.injection ?? DEFAULT_INJECTION,
      ciphertext: encryptSecret(MASTER_KEY, UPSTREAM_TOKEN),
      status: options.credentialStatus ?? 'active',
    },
  });

  const tokenService = createTokenService(
    process.env['AGENTGATE_JWT_PRIVATE_KEY'],
    process.env['AGENTGATE_JWT_PUBLIC_KEY'] ?? '',
  );

  const logLines: string[] = [];
  const clock = { now: options.now ?? new Date() };
  const approvals = createApprovalService(prisma, () => clock.now);

  const app = buildApp({
    prisma,
    tokenService,
    secretStore: createDbSecretStore(prisma, MASTER_KEY),
    engine: options.engine ?? createBuiltinEngine(),
    adapters: [githubAdapter],
    approvals,
    audit: createAuditRecorder(prisma),
    clock: () => clock.now,
    environment: 'development',
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    logger: createLogger({
      level: 'trace',
      destination: {
        write(line: string) {
          logLines.push(line);
        },
      },
    }),
  });
  await app.ready();

  return {
    app,
    prisma,
    tokenService,
    approvals,
    principalId,
    agentId,
    missionId,
    alias,
    upstreamRequests,
    logLines,
    clock,

    async mint(claims = {}, tokenExpiry = expiresAt) {
      return tokenService.mint(
        {
          agentId,
          principalId,
          agentType: 'codex',
          missionId,
          sessionId: `ses_${suffix}`,
          ...claims,
        },
        tokenExpiry,
      );
    },

    async proxy(body, token) {
      return app.inject({
        method: 'POST',
        url: '/v1/proxy',
        ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
        payload: body as object,
      });
    },

    async approvalStatus(approvalId, token) {
      return app.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: { authorization: `Bearer ${token}` },
      });
    },

    async admin(method, url, adminOptions = {}) {
      const token = 'token' in adminOptions ? adminOptions.token : ADMIN_TOKEN;

      return app.inject({
        method,
        url,
        ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
        ...(adminOptions.body === undefined ? {} : { payload: adminOptions.body as object }),
      });
    },

    async close() {
      await app.close();
      await upstream.close();
      await prisma.approval.deleteMany({ where: { missionId } });
      // Counters are keyed by mission and nothing else deletes them, so a suite that ran a few
      // hundred times would otherwise leave a few hundred dead rows behind. Audit rows stay:
      // the table is append-only by design and refuses a delete anyway.
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
