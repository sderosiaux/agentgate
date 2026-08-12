import { randomUUID } from 'node:crypto';
import util from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import { createDbSecretStore, encryptSecret, type SecretStore } from '../src/secrets/index.js';

const MASTER_KEY = Buffer.alloc(32, 0x2a).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 0x3b).toString('base64');

/**
 * Fixture aliases of their own: the store must not depend on whatever the demo seed holds.
 *
 * Scoped per run, the way the gateway harness scopes its mission and agent ids. These used to be
 * three fixed names created in `beforeAll` and deleted in `afterAll`, which works alone and
 * fails the moment a second suite shares the database: one run's teardown deletes the rows the
 * other is still reading, and the failure lands in whichever test happened to be mid-flight.
 */
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const ACTIVE_ALIAS = `test_store_active_${RUN}`;
const REVOKED_ALIAS = `test_store_revoked_${RUN}`;
const DRIFTED_ALIAS = `test_store_drifted_${RUN}`;
const SECRET = 'fixture-token-do-not-log';

let prisma: PrismaClient;
let store: SecretStore;

beforeAll(async () => {
  prisma = createPrismaClient();
  store = createDbSecretStore(prisma, MASTER_KEY);

  const shared = {
    provider: 'github',
    logicalHost: 'api.github.com',
    upstreamBaseUrl: 'http://mock-github:3001',
    injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
    ciphertext: encryptSecret(MASTER_KEY, SECRET),
  };

  for (const [alias, status] of [
    [ACTIVE_ALIAS, 'active'],
    [REVOKED_ALIAS, 'revoked'],
  ] as const) {
    const credential = { ...shared, alias, status };
    await prisma.credential.upsert({
      where: { alias },
      create: { id: `cred_${alias}`, ...credential },
      update: credential,
    });
  }

  // A row whose Json injection column no longer matches the schema: hand-edited, or written
  // by an older version of the seed.
  const drifted = {
    ...shared,
    alias: DRIFTED_ALIAS,
    status: 'active',
    injection: { type: 'header', name: 'Authorization', format: 'Bearer <no placeholder>' },
  };
  await prisma.credential.upsert({
    where: { alias: DRIFTED_ALIAS },
    create: { id: `cred_${DRIFTED_ALIAS}`, ...drifted },
    update: drifted,
  });
});

afterAll(async () => {
  await prisma.credential.deleteMany({
    where: { alias: { in: [ACTIVE_ALIAS, REVOKED_ALIAS, DRIFTED_ALIAS] } },
  });
  await prisma.$disconnect();
});

test('getByAlias resolves the plaintext value and its injection spec', async () => {
  const credential = await store.getByAlias(ACTIVE_ALIAS);

  expect(credential).not.toBeNull();
  expect(credential?.value).toBe(SECRET);
  expect(credential?.injection).toEqual({
    type: 'header',
    name: 'Authorization',
    format: 'Bearer {value}',
  });
  expect(credential?.provider).toBe('github');
  expect(credential?.logicalHost).toBe('api.github.com');
  expect(credential?.upstreamBaseUrl).toBe('http://mock-github:3001');
});

test('an unknown alias resolves to null', async () => {
  await expect(store.getByAlias('no_such_alias')).resolves.toBeNull();
});

test('a credential that is no longer active resolves to null', async () => {
  await expect(store.getByAlias(REVOKED_ALIAS)).resolves.toBeNull();
});

test('a drifted injection column names the alias instead of throwing a raw ZodError', async () => {
  const failure = await store.getByAlias(DRIFTED_ALIAS).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(DRIFTED_ALIAS);
  expect((failure as Error).message).toMatch(/injection spec/i);
  expect((failure as Error).name).toBe('Error');
  // The schema failure is kept for the logs rather than thrown as-is.
  expect((failure as Error).cause).toBeDefined();
});

test('a store holding the wrong master key fails instead of returning garbage', async () => {
  const wrongStore = createDbSecretStore(prisma, OTHER_KEY);

  await expect(wrongStore.getByAlias(ACTIVE_ALIAS)).rejects.toThrow(/could not be decrypted/i);
});

test('creating a store with an unusable master key fails immediately', () => {
  expect(() => createDbSecretStore(prisma, 'nope')).toThrow(/AGENTGATE_MASTER_KEY/);
});

test('JSON.stringify never serialises the value', async () => {
  const credential = await store.getByAlias(ACTIVE_ALIAS);

  const serialised = JSON.stringify(credential);

  expect(serialised).not.toContain(SECRET);
  expect(serialised).toContain(ACTIVE_ALIAS);
  expect(JSON.parse(serialised)).not.toHaveProperty('value');
});

test('util.inspect never shows the value', async () => {
  const credential = await store.getByAlias(ACTIVE_ALIAS);

  expect(util.inspect(credential)).not.toContain(SECRET);
  expect(util.inspect(credential, { depth: null })).not.toContain(SECRET);
});

test('console.log never prints the value', async () => {
  const credential = await store.getByAlias(ACTIVE_ALIAS);

  // console.log renders its arguments through util.format; vitest replaces the stream
  // itself, so the formatter is what there is to assert on.
  const rendered = [
    util.format(credential),
    util.format('%s', credential),
    util.format('%j', credential),
    util.format({ credential }),
  ].join('\n');

  expect(rendered).not.toContain(SECRET);
  expect(rendered).toContain(ACTIVE_ALIAS);
});

test('the value survives neither a spread nor Object.keys', async () => {
  const credential = await store.getByAlias(ACTIVE_ALIAS);

  expect(Object.keys(credential ?? {})).not.toContain('value');
  expect({ ...credential }).not.toHaveProperty('value');
  // …while a direct read still works, which is the whole point of the property.
  expect(credential?.value).toBe(SECRET);
});
