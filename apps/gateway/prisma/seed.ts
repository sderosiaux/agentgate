import { readFileSync } from 'node:fs';
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

/**
 * The demo mission, as a document rather than as code.
 *
 * `scripts/demo-orchestrator.mjs` issues a fresh mission on every `make demo` run and has to
 * grant exactly this scope; it is a host-side script and cannot import anything from here. So
 * the scope lives in one JSON file both of them read, and neither can drift from the other.
 * It sits next to this file because that is what the gateway image copies.
 */
export const DEMO_MISSION_PATH = new URL('demo-mission.json', import.meta.url);

interface DemoMissionDocument {
  intent: string;
  permissions: unknown;
  network: unknown;
  limits: unknown;
}

export function readDemoMission(): DemoMissionDocument {
  const raw = JSON.parse(readFileSync(DEMO_MISSION_PATH, 'utf8')) as DemoMissionDocument;

  // Named field by field: the document also carries a `notes` array explaining why its network
  // rules are wider than its resource scope, and the management API rejects unknown fields.
  return {
    intent: raw.intent,
    permissions: raw.permissions,
    network: raw.network,
    limits: raw.limits,
  };
}

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

  const scope = readDemoMission();
  const mission = {
    principalId: 'pri_stephane',
    agentId: 'agt_demo',
    intent: scope.intent,
    status: 'active',
    label: 'development',
    ...validateMissionDocuments(scope),
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
