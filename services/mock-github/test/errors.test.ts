import { expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockGithub } from '../src/app.js';

const TOKEN = 'test-github-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const BOOM = 'kaboom: the fixture exploded';

function buildWithCapturedLogs(): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = [];
  const app = buildMockGithub({
    token: TOKEN,
    logger: {
      level: 'trace',
      stream: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    },
  });

  return { app, lines };
}

test('a throwing route answers the GitHub shape and leaves a trace in the logs', async () => {
  const { app, lines } = buildWithCapturedLogs();
  app.get('/boom', async () => {
    throw new Error(BOOM);
  });
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/boom', headers: auth });
  await app.close();

  expect(response.statusCode).toBe(500);
  // The caller learns nothing about the failure...
  expect(response.json()).toEqual({ message: 'Internal Server Error' });
  expect(response.body).not.toContain('kaboom');
  // ...while whoever runs the service can still debug it.
  const output = lines.join('');
  expect(output).toContain(BOOM);
  expect(output).not.toContain(TOKEN);
});

test('a client error keeps its own status instead of being flattened into a 500', async () => {
  const { app } = buildWithCapturedLogs();
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/repos/acme/payments/pulls',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: '{"title": broken',
  });
  await app.close();

  expect(response.statusCode).toBe(400);
});
