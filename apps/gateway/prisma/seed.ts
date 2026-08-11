import { pathToFileURL } from 'node:url';
import { createPrismaClient, type PrismaClient } from '../src/db.js';

const MISSION_TTL_MS = 60 * 60 * 1000;

// Plan 04 replaces this with a real AES-256-GCM ciphertext of MOCK_GITHUB_TOKEN.
// The seed is re-runnable, so the placeholder is overwritten on the next run.
const CIPHERTEXT_PLACEHOLDER = Buffer.from('placeholder');

export async function seed(prisma: PrismaClient): Promise<void> {
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
    injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
    ciphertext: CIPHERTEXT_PLACEHOLDER,
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
      ],
      deny: [],
    },
    limits: { maxRequests: 500, maxBytes: 50_000_000, requestsPerMinute: 60 },
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
