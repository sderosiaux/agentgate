import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import { seed } from '../prisma/seed.js';

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
  expect(Buffer.from(credential.ciphertext).toString('utf8')).not.toContain('super-secret');
});
