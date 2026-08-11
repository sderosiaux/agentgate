import { createTokenService } from '@agentgate/auth';
import { createBuiltinEngine, createOpaEngine, githubAdapter } from '@agentgate/policy';
import { buildApp } from './app.js';
import { createApprovalService } from './approvals/service.js';
import { createAuditRecorder } from './audit/recorder.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { createPrismaClient } from './db.js';
import { createLogger } from './logging.js';
import { createDbSecretStore } from './secrets/index.js';

/** How long a shutdown may take before the process stops waiting for in-flight requests. */
const CLOSE_TIMEOUT_MS = 10_000;

// Read before anything is built or bound: a gateway that cannot decrypt its credentials or
// verify a token has nothing useful to serve, and failing here is far cheaper to diagnose
// than failing on the first proxied request. This is the only entrypoint that reads the
// environment, so no alternate one can skip the check.
let config: GatewayConfig;
try {
  config = loadGatewayConfig();
} catch (error) {
  console.error(
    `AgentGate cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const logger = createLogger();
const prisma = createPrismaClient(config.databaseUrl);
const clock = (): Date => new Date();

const app = buildApp({
  prisma,
  tokenService: createTokenService(config.jwtPrivateKey, config.jwtPublicKey),
  secretStore: createDbSecretStore(prisma, config.masterKey),
  engine:
    config.policyEngine === 'opa' ? createOpaEngine(config.opaUrl ?? '') : createBuiltinEngine(),
  adapters: [githubAdapter],
  approvals: createApprovalService(prisma, clock),
  audit: createAuditRecorder(prisma),
  clock,
  environment: config.environment,
  adminToken: config.adminToken,
  logger,
});

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      // A second signal is an operator saying they are done waiting.
      logger.warn({ signal }, 'second signal received, exiting now');
      process.exit(1);
    }
    shuttingDown = true;

    // A request stuck on a slow upstream must not keep the process alive forever: the forward
    // has its own timeout, this is the backstop for everything else.
    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'shutdown timed out, exiting anyway');
      process.exit(1);
    }, CLOSE_TIMEOUT_MS);
    forceExit.unref();

    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
