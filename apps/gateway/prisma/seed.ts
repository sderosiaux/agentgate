import { pathToFileURL } from 'node:url';
import {
  MissionLimitsSchema,
  MissionPermissionsSchema,
  NetworkRulesSchema,
  type MissionLimits,
  type MissionPermissions,
  type NetworkRules,
} from '@agentgate/shared';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import { assertMasterKey, encryptSecret, InjectionSpecSchema } from '../src/secrets/index.js';

const MISSION_TTL_MS = 60 * 60 * 1000;

export interface MissionDocuments {
  permissions: MissionPermissions;
  network: NetworkRules;
  limits: MissionLimits;
}

/**
 * Postgres stores the three mission documents as opaque Json, so nothing would stop the seed
 * from writing a shape the gateway cannot read. Parsing them through the shared schemas here
 * is what keeps the seed and `@agentgate/shared` from drifting apart.
 */
export function validateMissionDocuments(documents: {
  permissions: unknown;
  network: unknown;
  limits: unknown;
}): MissionDocuments {
  return {
    permissions: MissionPermissionsSchema.parse(documents.permissions),
    network: NetworkRulesSchema.parse(documents.network),
    limits: MissionLimitsSchema.parse(documents.limits),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set: the seed needs it to write the demo credential`);
  }

  return value;
}

export async function seed(prisma: PrismaClient): Promise<void> {
  const masterKey = requireEnv('AGENTGATE_MASTER_KEY');
  assertMasterKey(masterKey);
  const demoToken = requireEnv('MOCK_GITHUB_TOKEN');

  await prisma.principal.upsert({
    where: { id: 'pri_stephane' },
    create: { id: 'pri_stephane', name: 'Stéphane' },
    update: { name: 'Stéphane' },
  });

  await prisma.agent.upsert({
    where: { id: 'agt_demo' },
    create: { id: 'agt_demo', principalId: 'pri_stephane', agentType: 'codex' },
    update: { principalId: 'pri_stephane', agentType: 'codex' },
  });

  const credential = {
    provider: 'github',
    logicalHost: 'api.github.com',
    upstreamBaseUrl: 'http://mock-github:3001',
    injection: InjectionSpecSchema.parse({
      type: 'header',
      name: 'Authorization',
      format: 'Bearer {value}',
    }),
    // A fresh IV per run means the ciphertext differs every time; the decrypted value does not,
    // which is the only thing the seed promises to keep stable.
    ciphertext: encryptSecret(masterKey, demoToken),
    status: 'active',
  };

  await prisma.credential.upsert({
    where: { alias: 'github_work' },
    create: { id: 'cred_github_work', alias: 'github_work', ...credential },
    update: credential,
  });

  const mission = {
    principalId: 'pri_stephane',
    agentId: 'agt_demo',
    intent: 'Investigate issue #423 and create a pull request',
    status: 'active',
    environment: 'development',
    ...validateMissionDocuments({
      permissions: {
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
      },
      network: {
        allow: [
          { host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET'] },
          { host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] },
          // Routed on purpose, so that what refuses a repository deletion is the mission's
          // `deniedActions` list and not the absence of a route. The two are both a 403 to the
          // caller and a different sentence in the audit trail: "no network rule allows DELETE"
          // says nobody thought about it, "action repository.delete is denied by the mission"
          // says somebody did. SPEC demo case 5 is about the second one.
          { host: 'api.github.com', path: '/repos/acme/payments', methods: ['DELETE'] },
        ],
        deny: [],
      },
      limits: { maxRequests: 500, maxBytes: 50_000_000, requestsPerMinute: 60 },
    }),
    expiresAt: new Date(Date.now() + MISSION_TTL_MS),
  };

  await prisma.mission.upsert({
    where: { id: 'mis_demo' },
    create: { id: 'mis_demo', ...mission },
    update: mission,
  });
}

async function main(): Promise<void> {
  const prisma = createPrismaClient();

  try {
    await seed(prisma);
    console.log('Seed applied: pri_stephane, agt_demo, github_work, mis_demo');
  } finally {
    await prisma.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
