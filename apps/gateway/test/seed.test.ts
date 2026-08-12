import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import { createDbSecretStore } from '../src/secrets/index.js';
import { seed, validateMissionDocuments } from '../prisma/seed.js';

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function counts(): Promise<Record<string, number>> {
  return {
    principals: await prisma.principal.count(),
    agents: await prisma.agent.count(),
    credentials: await prisma.credential.count(),
    missions: await prisma.mission.count(),
  };
}

test('seeding twice leaves the row counts unchanged', async () => {
  await seed(prisma);
  const afterFirstRun = await counts();

  await seed(prisma);
  const afterSecondRun = await counts();

  expect(afterFirstRun.principals).toBeGreaterThanOrEqual(1);
  expect(afterSecondRun).toEqual(afterFirstRun);
});

test('the demo mission is scoped to the payments repository', async () => {
  await seed(prisma);

  const mission = await prisma.mission.findUniqueOrThrow({ where: { id: 'mis_demo' } });

  expect(mission.permissions).toMatchObject({
    resources: ['github:acme/payments'],
    approvalActions: ['pull_request.create'],
    deniedActions: ['pull_request.merge', 'repository.delete'],
  });
  expect(mission.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

test('the seeded credential exposes an alias, never a plaintext value', async () => {
  await seed(prisma);

  const credential = await prisma.credential.findUniqueOrThrow({ where: { alias: 'github_work' } });

  expect(credential.logicalHost).toBe('api.github.com');
  expect(credential.upstreamBaseUrl).toBe('http://mock-github:3001');
  expect(credential.injection).toEqual({
    type: 'header',
    name: 'Authorization',
    format: 'Bearer {value}',
  });
  // Compared against the configured token rather than a literal: the demo value must not be
  // written down anywhere in the source tree, tests included.
  const demoToken = process.env['MOCK_GITHUB_TOKEN'] ?? '';
  expect(demoToken).not.toBe('');
  for (const encoding of ['utf8', 'latin1'] as const) {
    expect(Buffer.from(credential.ciphertext).toString(encoding)).not.toContain(demoToken);
  }
});

test('the seeded ciphertext decrypts back to the demo token through the store', async () => {
  await seed(prisma);

  const masterKey = process.env['AGENTGATE_MASTER_KEY'];
  const demoToken = process.env['MOCK_GITHUB_TOKEN'];
  expect(masterKey).toBeTruthy();
  expect(demoToken).toBeTruthy();

  const store = createDbSecretStore(prisma, masterKey ?? '');
  const credential = await store.getByAlias('github_work');

  expect(credential?.value).toBe(demoToken);
  expect(credential?.injection.format).toBe('Bearer {value}');
});

test('re-seeding rewrites the ciphertext yet resolves to the same token', async () => {
  await seed(prisma);
  const first = await prisma.credential.findUniqueOrThrow({ where: { alias: 'github_work' } });

  await seed(prisma);
  const second = await prisma.credential.findUniqueOrThrow({ where: { alias: 'github_work' } });

  // A fresh IV per encryption: identical blobs would mean the IV is being reused.
  expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);

  const store = createDbSecretStore(prisma, process.env['AGENTGATE_MASTER_KEY'] ?? '');
  await expect(store.getByAlias('github_work')).resolves.toMatchObject({
    alias: 'github_work',
  });
});

test('the seed refuses to run without the demo token', async () => {
  const saved = process.env['MOCK_GITHUB_TOKEN'];
  delete process.env['MOCK_GITHUB_TOKEN'];

  try {
    await expect(seed(prisma)).rejects.toThrow(/MOCK_GITHUB_TOKEN/);
  } finally {
    // Assigning `undefined` to process.env stores the literal string "undefined", which
    // would leave every later test running against a bogus token.
    if (saved === undefined) {
      delete process.env['MOCK_GITHUB_TOKEN'];
    } else {
      process.env['MOCK_GITHUB_TOKEN'] = saved;
    }
  }
});

test('a mission document that does not match the shared schema is rejected', () => {
  const valid = {
    permissions: {
      resources: ['github:acme/payments'],
      allowedActions: ['repo.read'],
      approvalActions: [],
      deniedActions: [],
      allowedCredentials: ['github_work'],
    },
    network: { allow: [{ host: 'api.github.com', methods: ['GET'] }], deny: [] },
    limits: { maxRequests: 500, maxBytes: 50_000_000, requestsPerMinute: 60 },
  };

  expect(() => validateMissionDocuments(valid)).not.toThrow();

  // Each corruption is one the Json column would happily store.
  expect(() =>
    validateMissionDocuments({
      ...valid,
      permissions: { ...valid.permissions, allowedActions: 'repo.read' },
    }),
  ).toThrow();
  expect(() =>
    validateMissionDocuments({
      ...valid,
      permissions: { ...valid.permissions, deny: ['typo-key'] },
    }),
  ).toThrow();
  expect(() =>
    validateMissionDocuments({
      ...valid,
      network: { allow: [{ host: 'api.github.com', methods: ['get'] }], deny: [] },
    }),
  ).toThrow();
  expect(() =>
    validateMissionDocuments({ ...valid, limits: { ...valid.limits, maxRequests: 0 } }),
  ).toThrow();
});
