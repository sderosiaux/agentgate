import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);

  return harness;
}

/**
 * Every operation the plan makes binding. Written out rather than derived from the app, because
 * a list derived from the app would agree with the app even when the app is wrong.
 */
const REQUIRED_OPERATIONS: [string, string][] = [
  ['post', '/api/v1/principals'],
  ['get', '/api/v1/principals'],
  ['post', '/api/v1/agents'],
  ['get', '/api/v1/agents'],
  ['get', '/api/v1/agents/{id}'],
  ['post', '/api/v1/missions'],
  ['get', '/api/v1/missions'],
  ['get', '/api/v1/missions/{id}'],
  ['post', '/api/v1/missions/{id}/expire'],
  ['post', '/api/v1/missions/{id}/tokens'],
  ['post', '/api/v1/credentials'],
  ['get', '/api/v1/credentials'],
  ['get', '/api/v1/approvals'],
  ['post', '/api/v1/approvals/{id}/approve'],
  ['post', '/api/v1/approvals/{id}/deny'],
  ['get', '/api/v1/audit'],
  ['get', '/api/v1/decisions/{requestId}'],
  ['get', '/api/v1/stats/overview'],
];

async function document(harness: Harness): Promise<OpenAPIV3_1.Document> {
  const response = await harness.app.inject({ method: 'GET', url: '/api/docs/json' });

  expect(response.statusCode).toBe(200);

  return JSON.parse(response.body) as OpenAPIV3_1.Document;
}

test('the published document is well formed and describes every management route', async () => {
  const harness = await start();
  const spec = await document(harness);

  expect(spec.openapi).toMatch(/^3\.1/);
  expect(spec.info).toMatchObject({ title: 'AgentGate Management API', version: '0.1.0' });
  expect(spec.components?.securitySchemes).toMatchObject({
    adminToken: { type: 'http', scheme: 'bearer' },
  });
  expect(spec.security).toEqual([{ adminToken: [] }]);

  for (const [method, path] of REQUIRED_OPERATIONS) {
    const operation = spec.paths?.[path]?.[method as 'get'];

    expect({ method, path, described: operation !== undefined }).toEqual({
      method,
      path,
      described: true,
    });
    // An operation with no documented answer is a route a client cannot be written against.
    expect(Object.keys(operation?.responses ?? {}).length).toBeGreaterThan(1);
    expect(operation?.tags?.length).toBeGreaterThan(0);
    expect(operation?.summary).toBeTruthy();
  }
});

test('the document describes nothing that is not a management route', async () => {
  const harness = await start();
  const spec = await document(harness);

  for (const path of Object.keys(spec.paths ?? {})) {
    // The enforcement tree is wired separately and is not this document's subject (D11), and
    // the catch-all that guards route enumeration is not a route anybody calls on purpose.
    expect(path.startsWith('/api/v1/')).toBe(true);
    expect(path).not.toContain('*');
  }

  expect(Object.keys(spec.paths ?? {})).not.toContain('/v1/proxy');
  expect(Object.keys(spec.paths ?? {})).not.toContain('/healthz');
});

test('the request bodies in the document are the schemas the routes actually validate with', async () => {
  const harness = await start();
  const spec = await document(harness);

  const missionBody = (
    spec.paths?.['/api/v1/missions']?.post?.requestBody as OpenAPIV3_1.RequestBodyObject | undefined
  )?.content?.['application/json']?.schema as OpenAPIV3_1.SchemaObject | undefined;

  expect(missionBody?.required).toEqual(
    expect.arrayContaining([
      'principalId',
      'agentId',
      'intent',
      'permissions',
      'network',
      'limits',
      'expiresAt',
    ]),
  );
  // The mission scope documents are described, not left as free-form json: the web UI builds a
  // form from this.
  expect(
    (missionBody?.properties?.['permissions'] as OpenAPIV3_1.SchemaObject | undefined)?.properties,
  ).toHaveProperty('allowedActions');

  const auditQuery = spec.paths?.['/api/v1/audit']?.get?.parameters ?? [];
  const names = auditQuery.map((parameter) => (parameter as OpenAPIV3_1.ParameterObject).name);
  expect(names).toEqual(
    expect.arrayContaining([
      'agentId',
      'principalId',
      'missionId',
      'resource',
      'decision',
      'from',
      'to',
      'limit',
      'cursor',
    ]),
  );
});

test('the document says a credential value goes in and never comes back', async () => {
  const harness = await start();
  const spec = await document(harness);

  const post = spec.paths?.['/api/v1/credentials']?.post;

  const body = (post?.requestBody as OpenAPIV3_1.RequestBodyObject | undefined)?.content?.[
    'application/json'
  ]?.schema as OpenAPIV3_1.SchemaObject | undefined;
  expect(body?.properties).toHaveProperty('value');

  for (const status of Object.keys(post?.responses ?? {})) {
    const response = post?.responses?.[status] as OpenAPIV3_1.ResponseObject | undefined;
    const schema = response?.content?.['application/json']?.schema as
      OpenAPIV3_1.SchemaObject | undefined;

    expect(Object.keys(schema?.properties ?? {})).not.toContain('value');
  }

  const list = (
    spec.paths?.['/api/v1/credentials']?.get?.responses?.['200'] as
      OpenAPIV3_1.ResponseObject | undefined
  )?.content?.['application/json']?.schema as OpenAPIV3_1.SchemaObject | undefined;
  const item = (list?.properties?.['credentials'] as OpenAPIV3_1.ArraySchemaObject | undefined)
    ?.items as OpenAPIV3_1.SchemaObject | undefined;
  expect(Object.keys(item?.properties ?? {})).not.toContain('value');
});

test('the document and its UI are readable without the admin token, and carry no data', async () => {
  const harness = await start();

  // Deliberate: the UI fetches its own definition from the browser before any operator has
  // typed a token, so a guarded document is a document nobody can read. What it publishes is
  // the shape of the API, never a row of it — `management-credentials.test.ts` walks it for a
  // planted secret to prove that.
  for (const url of ['/api/docs/json', '/api/docs']) {
    const response = await harness.app.inject({ method: 'GET', url });

    expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
  }

  const spec = await document(harness);
  const serialised = JSON.stringify(spec);

  expect(serialised).not.toContain('harness-admin-token');
  expect(serialised).not.toContain('harness-upstream-secret-token');
  expect(serialised).not.toContain(harness.missionId);
});
