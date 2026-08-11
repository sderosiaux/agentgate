import { buildMockGithub } from './app.js';

const token = process.env['MOCK_GITHUB_TOKEN'];

// Refusing to start beats starting an unguarded copy of the service the whole demo
// is about keeping out of reach.
if (token === undefined || token.length === 0) {
  throw new Error('MOCK_GITHUB_TOKEN is required');
}

const port = Number(process.env['PORT'] ?? 3001);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildMockGithub({ token, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
