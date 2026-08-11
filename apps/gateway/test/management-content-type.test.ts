import { afterEach, expect, test } from 'vitest';
import { ADMIN_TOKEN, startHarness, type Harness } from './helpers/gateway.js';

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
 * The three routes plan 10 posts to from a button. A browser `fetch` with a JSON content type
 * and nothing to send is the shape that arrives, and it must not be answered with a 500: an
 * operator seeing "the gateway could not answer" after clicking approve has no way to tell a
 * malformed click from a gateway that is actually broken.
 */
function buttonRoutes(harness: Harness): string[] {
  return [
    '/api/v1/approvals/apr_anything/approve',
    `/api/v1/missions/${harness.missionId}/expire`,
    `/api/v1/missions/${harness.missionId}/tokens`,
  ];
}

async function post(
  harness: Harness,
  url: string,
  headers: Record<string, string>,
  payload: string,
) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...headers },
    payload,
  });
}

test('an empty body with a json content type is a bad request, not a broken gateway', async () => {
  const harness = await start();

  for (const url of buttonRoutes(harness)) {
    const response = await post(harness, url, { 'content-type': 'application/json' }, '');

    expect({ url, status: response.statusCode }).toEqual({ url, status: 400 });
    expect(response.json()).toMatchObject({
      error: 'agentgate_validation_error',
      request_id: expect.stringMatching(/^req_/),
    });
  }
});

test('a malformed json body is a bad request', async () => {
  const harness = await start();

  for (const url of buttonRoutes(harness)) {
    const response = await post(
      harness,
      url,
      { 'content-type': 'application/json' },
      '{"decidedBy": ',
    );

    expect({ url, status: response.statusCode }).toEqual({ url, status: 400 });
    expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });
    // The parser's own message quotes the input it choked on; ours does not.
    expect(response.body).not.toContain('decidedBy');
  }
});

test('a content type the gateway cannot parse is a 415, and so is none at all', async () => {
  const harness = await start();

  for (const url of buttonRoutes(harness)) {
    for (const headers of [{ 'content-type': 'application/xml' }, {}]) {
      const response = await post(harness, url, headers, '<decision/>');

      expect({ url, headers, status: response.statusCode }).toEqual({
        url,
        headers,
        status: 415,
      });
      expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });
    }
  }
});

test('a request body that is well formed still reaches the handler', async () => {
  const harness = await start();

  // The control: the same route, the same content type, an actual body. Nothing above may be
  // achieved by refusing every POST.
  const response = await post(
    harness,
    `/api/v1/missions/${harness.missionId}/expire`,
    { 'content-type': 'application/json' },
    '{}',
  );

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id: harness.missionId, status: 'expired' });
});

test('a GET carrying a content type is untouched by any of this', async () => {
  const harness = await start();

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/stats/overview',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
  });

  expect(response.statusCode).toBe(200);
});

test('a body larger than the gateway will read is refused as one', async () => {
  const harness = await start();

  const response = await post(
    harness,
    '/api/v1/principals',
    { 'content-type': 'application/json' },
    JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
  );

  // 413 from the framework or 400 from the schema — either is a refusal the caller can read,
  // and the code follows the status rather than being one blanket answer for both. The two ask
  // the caller for different things: send less, or send it differently.
  expect([400, 413]).toContain(response.statusCode);
  expect(response.json()).toMatchObject({
    error:
      response.statusCode === 413 ? 'agentgate_payload_too_large' : 'agentgate_validation_error',
  });
});
