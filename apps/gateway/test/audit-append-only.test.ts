import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function insertAuditEvent(): Promise<string> {
  const id = `aud_${randomUUID()}`;

  await prisma.auditEvent.create({
    data: {
      id,
      requestId: `req_${randomUUID()}`,
      decision: 'DENY',
      reason: 'append-only guard test',
      latencyMs: 1,
    },
  });

  return id;
}

test('an audit event cannot be updated', async () => {
  const id = await insertAuditEvent();

  await expect(
    prisma.$executeRaw`UPDATE "AuditEvent" SET "decision" = 'ALLOW' WHERE "id" = ${id}`,
  ).rejects.toThrow(/append-only/i);

  const stored = await prisma.auditEvent.findUniqueOrThrow({ where: { id } });
  expect(stored.decision).toBe('DENY');
});

test('an audit event cannot be deleted', async () => {
  const id = await insertAuditEvent();

  await expect(prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${id}`).rejects.toThrow(
    /append-only/i,
  );

  expect(await prisma.auditEvent.findUnique({ where: { id } })).not.toBeNull();
});
