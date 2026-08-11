import { buildApp } from './app.js';
import { assertBootEnv } from './secrets/index.js';

// Checked before anything is built or bound: a gateway that cannot decrypt its credentials
// has nothing useful to serve, and failing here is far cheaper to diagnose than failing
// on the first proxied request.
try {
  assertBootEnv();
} catch (error) {
  console.error(
    `AgentGate cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildApp({ logger: true });

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
