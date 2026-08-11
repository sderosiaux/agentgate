import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { decryptSecret } from '../src/secrets/index.js';
import { MASTER_KEY, startHarness, type Harness } from './helpers/gateway.js';

const started: Harness[] = [];
const createdAliases: string[] = [];
/** What the create calls answered, kept so the deep scan covers writes as well as reads. */
const createResponses: string[] = [];

afterEach(async () => {
  for (const harness of started) {
    await harness.prisma.credential.deleteMany({ where: { alias: { in: createdAliases } } });
  }
  createdAliases.length = 0;
  createResponses.length = 0;

  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);

  return harness;
}

/**
 * A value chosen to be findable and to belong to nothing else: if it turns up anywhere in a
 * management response or in the published document, the grep that finds it is unambiguous.
 */
const SENTINEL = `ghp-poisoned-sentinel-${randomUUID().replaceAll('-', '')}`;

function credentialBody(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    provider: 'github',
    logicalHost: 'api.github.com',
    upstreamBaseUrl: 'http://127.0.0.1:3001',
    injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
    value: SENTINEL,
    ...overrides,
  };
}

async function createSentinel(harness: Harness): Promise<string> {
  const alias = `sentinel_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  createdAliases.push(alias);

  const response = await harness.admin('POST', '/api/v1/credentials', {
    body: credentialBody(alias),
  });
  expect(response.statusCode).toBe(201);
  createResponses.push(response.body);

  return alias;
}

test('a credential value is encrypted on the way in and absent from the answer', async () => {
  const harness = await start();
  const alias = await createSentinel(harness);

  const created = (
    await harness.admin('POST', '/api/v1/credentials', { body: credentialBody(`${alias}_2`) })
  ).json();
  createdAliases.push(`${alias}_2`);

  // Everything the caller submitted, except the one field it must never get back.
  expect(created).toMatchObject({
    alias: `${alias}_2`,
    provider: 'github',
    logicalHost: 'api.github.com',
    upstreamBaseUrl: 'http://127.0.0.1:3001',
    injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
    status: 'active',
  });
  expect(Object.keys(created)).not.toContain('value');
  expect(Object.keys(created)).not.toContain('ciphertext');

  // In the database it is ciphertext, and the plaintext is recoverable only with the master key.
  const row = await harness.prisma.credential.findUniqueOrThrow({ where: { alias } });
  const stored = Buffer.from(row.ciphertext);
  expect(stored.toString('utf8')).not.toContain(SENTINEL);
  expect(decryptSecret(MASTER_KEY, stored)).toBe(SENTINEL);
});

test('no management response and no published document carries the credential value', async () => {
  const harness = await start();
  const alias = await createSentinel(harness);

  // Something on the trail, an approval waiting, a mission with usage: the deep scan is only
  // worth anything if the endpoints it walks have something to answer with.
  const token = await harness.mint();
  await harness.proxy(
    { credential: harness.alias, method: 'GET', url: 'https://api.github.com/repos/acme/payments' },
    token,
  );
  const gated = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Fix duplicate charges"}',
    },
    token,
  );
  const requestId = String(gated.headers['x-agentgate-request-id']);

  const document = await harness.app.inject({ method: 'GET', url: '/api/docs/json' });
  expect(document.statusCode).toBe(200);

  // Every GET the document declares, with its path parameters filled in with real ids: a route
  // that leaks would have to be missing from the document to escape this.
  const paths = Object.entries(
    (document.json() as { paths: Record<string, Record<string, unknown>> }).paths,
  ).filter(([, operations]) => 'get' in operations);
  expect(paths.length).toBeGreaterThan(5);

  const scanned: string[] = [document.body, ...createResponses];

  for (const [path] of paths) {
    const url = path
      .replace('/missions/{id}', `/missions/${harness.missionId}`)
      .replace('/agents/{id}', `/agents/${harness.agentId}`)
      .replace('/decisions/{requestId}', `/decisions/${requestId}`);

    const response = await harness.admin('GET', url);

    expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
    scanned.push(response.body);
  }

  // Belt and braces: the credential list and detail-ish routes are in there, and so is the raw
  // JSON of everything else the API will answer.
  expect(scanned.some((body) => body.includes(alias))).toBe(true);
  for (const body of scanned) {
    expect(body).not.toContain(SENTINEL);
  }

  // And nothing wrote it to a log line either.
  expect(harness.logLines.join('\n')).not.toContain(SENTINEL);
});

test('the credential list shows how a secret is injected, not what it is wrapped in', async () => {
  const harness = await start();
  const alias = await createSentinel(harness);

  const listed = (
    (await harness.admin('GET', '/api/v1/credentials')).json()['credentials'] as {
      alias: string;
      injection: Record<string, unknown>;
      status: string;
    }[]
  ).find((credential) => credential.alias === alias);

  expect(listed).toMatchObject({
    provider: 'github',
    logicalHost: 'api.github.com',
    status: 'active',
    injection: { type: 'header', name: 'Authorization' },
  });
  expect(Object.keys(listed?.injection ?? {})).not.toContain('format');
});

test('an injection spec that would corrupt the upstream request is refused at the boundary', async () => {
  const harness = await start();

  const refusals: [string, unknown][] = [
    [
      'a newline in the format, which is request splitting',
      { type: 'header', name: 'Authorization', format: 'Bearer {value}\r\nX-Admin: true' },
    ],
    [
      'a bare line feed in the format',
      { type: 'header', name: 'Authorization', format: 'Bearer {value}\n' },
    ],
    [
      'a header name that is not a header name',
      { type: 'header', name: 'X-Api Key', format: 'Bearer {value}' },
    ],
    ['a header name carrying a colon', { type: 'header', name: 'X-Api-Key: x', format: '{value}' }],
    ['a header name with a newline', { type: 'header', name: 'X-Api\r\nKey', format: '{value}' }],
    [
      'a format that never uses the secret',
      { type: 'header', name: 'Authorization', format: 'Bearer' },
    ],
    [
      'an injection that is not a header at all',
      { type: 'query', name: 'token', format: '{value}' },
    ],
    [
      'an injection with a field nobody implements',
      { type: 'header', name: 'A', format: '{value}', encode: 'base64' },
    ],
  ];

  for (const [what, injection] of refusals) {
    const alias = `bad_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const response = await harness.admin('POST', '/api/v1/credentials', {
      body: credentialBody(alias, { injection }),
    });

    expect({ what, status: response.statusCode }).toEqual({ what, status: 400 });
    expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });
    // Refused means not stored: a row like this would fail at request time, inside undici,
    // hours after whoever wrote it stopped looking.
    expect(await harness.prisma.credential.findUnique({ where: { alias } })).toBeNull();
  }
});

test('the rest of a credential is bounded too', async () => {
  const harness = await start();

  const refusals: [string, Record<string, unknown>][] = [
    ['an alias with a slash in it', { alias: 'github/work' }],
    ['an upstream that is not http', { upstreamBaseUrl: 'file:///etc/passwd' }],
    ['an upstream that is not a url', { upstreamBaseUrl: 'api.github.com' }],
    ['an empty value', { value: '' }],
    ['a field nobody asked for', { unexpected: true }],
  ];

  for (const [what, overrides] of refusals) {
    const alias = `bad_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const response = await harness.admin('POST', '/api/v1/credentials', {
      body: credentialBody(alias, overrides),
    });

    expect({ what, status: response.statusCode }).toEqual({ what, status: 400 });
  }
});

test('an alias an agent may already be using is not silently overwritten', async () => {
  const harness = await start();
  const alias = await createSentinel(harness);

  const second = await harness.admin('POST', '/api/v1/credentials', {
    body: credentialBody(alias, { value: 'a-different-secret-entirely' }),
  });

  expect(second.statusCode).toBe(409);
  expect(second.json()).toMatchObject({ error: 'agentgate_conflict' });

  // The stored secret is still the first one.
  const row = await harness.prisma.credential.findUniqueOrThrow({ where: { alias } });
  expect(decryptSecret(MASTER_KEY, Buffer.from(row.ciphertext))).toBe(SENTINEL);
});

test('a credential created through the API is one the enforcement path can actually use', async () => {
  const harness = await start();
  const alias = `wired_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  createdAliases.push(alias);

  // Pointed at the same mock GitHub the harness started, with the token it expects.
  const existing = await harness.prisma.credential.findUniqueOrThrow({
    where: { alias: harness.alias },
  });
  const created = await harness.admin('POST', '/api/v1/credentials', {
    body: credentialBody(alias, {
      upstreamBaseUrl: existing.upstreamBaseUrl,
      value: 'harness-upstream-secret-token',
    }),
  });
  expect(created.statusCode).toBe(201);

  const response = await harness.proxy(
    { credential: alias, method: 'GET', url: 'https://api.github.com/repos/acme/payments' },
    await harness.mint(),
  );

  expect(response.statusCode).toBe(200);
  expect(harness.upstreamRequests).toHaveLength(1);
});
