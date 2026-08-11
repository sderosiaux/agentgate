#!/usr/bin/env node
/**
 * Runs the SPEC demo end to end, unattended.
 *
 * The demo agent is deliberately powerless: it holds a mission token and an alias, it cannot
 * approve anything and it cannot expire its own mission. So somebody outside the sandbox has to
 * play the human — that is this script. It brings the stack up, issues a fresh mission, starts
 * the agent, and watches its stdout for the two moments where a person would otherwise click:
 * approving the pull request, and ending the mission.
 *
 *   make demo        compose mode: everything in containers, the agent on an internal network
 *   make demo-host   host mode: local processes, for a machine with no working Docker daemon
 *
 * Host mode cannot prove case 0 (network isolation) and does not pretend to: the agent marks it
 * skipped and says why.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the agent prints when it needs the outside world to do something (see `cases.ts`). */
const APPROVAL_MARKER = 'DEMO_MARKER:APPROVAL_PENDING';
const EXPIRE_MARKER = 'DEMO_MARKER:EXPIRE_MISSION';

/** How long a human is imagined to take. Long enough to read the line, short enough to watch. */
const APPROVAL_DELAY_MS = 2_000;

const MISSION_TTL_MS = 60 * 60 * 1000;

/** The port a host-mode gateway binds. Compose publishes its own on GATEWAY_PORT. */
const HOST_GATEWAY_PORT = 8099;
const HOST_MOCK_GITHUB_PORT = 3001;

/**
 * The mission the demo is about, mirroring the seed: `pull_request.create` needs a human,
 * `repository.delete` is refused outright, and nothing outside `acme/payments` is in scope.
 */
const MISSION_SCOPE = {
  intent: 'Investigate issue #423 and create a pull request',
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
      // Case 5 is about the policy refusing a deletion, not about the network never routing
      // one. Kept identical to the seed (apps/gateway/prisma/seed.ts): a demo run must not be
      // scoped more loosely than the mission the seed hands the same agent.
      { host: 'api.github.com', path: '/repos/acme/payments', methods: ['DELETE'] },
    ],
    deny: [],
  },
  limits: { maxRequests: 500, maxBytes: 50_000_000, requestsPerMinute: 60 },
};

function loadEnvFile() {
  let contents;
  try {
    contents = readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    fail('No .env found — run `make setup` first.');
  }

  for (const line of contents.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    // Never overrides: an operator exporting a value in their shell means it.
    process.env[match[1]] ??= match[2];
  }
}

function fail(message) {
  console.error(`\ndemo: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    fail(`${name} is not set in .env`);
  }
  return value;
}

function log(message) {
  console.log(`demo: ${message}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a command to completion, with its output on ours. Rejects on a non-zero exit. */
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`)),
    );
  });
}

class Management {
  constructor(baseUrl, adminToken) {
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
  }

  async call(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.adminToken}`,
        // Every management POST carries a body, even an empty one: a JSON content type with no
        // payload is a 400 on that tree.
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${String(response.status)} ${text}`);
    }

    return text === '' ? null : JSON.parse(text);
  }

  async waitForHealth(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        const response = await fetch(`${this.baseUrl}/healthz`);
        if (response.ok) {
          return;
        }
      } catch {
        // Not up yet.
      }

      if (Date.now() > deadline) {
        throw new Error(`the gateway at ${this.baseUrl} never became healthy`);
      }

      await sleep(500);
    }
  }
}

/**
 * A principal, an agent, a mission and a token, all new.
 *
 * Fresh every run rather than reusing the seeded mission: the demo expires the mission it is
 * given, so a second run against the same one would start from a mission that is already dead.
 */
async function issueMission(management, credentialAlias) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const principal = await management.call('POST', '/api/v1/principals', {
    name: `Demo run ${stamp}`,
  });
  const agent = await management.call('POST', '/api/v1/agents', {
    principalId: principal.id,
    agentType: 'codex',
  });
  const mission = await management.call('POST', '/api/v1/missions', {
    principalId: principal.id,
    agentId: agent.id,
    ...MISSION_SCOPE,
    expiresAt: new Date(Date.now() + MISSION_TTL_MS).toISOString(),
  });
  const minted = await management.call('POST', `/api/v1/missions/${mission.id}/tokens`, {});

  log(`principal ${principal.id}, agent ${agent.id}, mission ${mission.id}`);
  log(`token expires at ${minted.expiresAt}, credential alias "${credentialAlias}"`);

  return { missionId: mission.id, token: minted.token };
}

/**
 * Watches the agent's stdout and does the two things it cannot do for itself. Nothing here
 * parses a result: the agent decides whether a case passed, and this only plays the human.
 */
function attachMarkerWatcher(child, management, missionId, autoApprove) {
  const pending = [];

  createInterface({ input: child.stdout }).on('line', (line) => {
    console.log(line);

    if (line.includes(APPROVAL_MARKER)) {
      const approvalId = line.slice(line.indexOf(APPROVAL_MARKER) + APPROVAL_MARKER.length).trim();

      if (!autoApprove) {
        log(`approval ${approvalId} is waiting — approve it in the UI or with the API`);
        return;
      }

      pending.push(
        sleep(APPROVAL_DELAY_MS)
          .then(() =>
            management.call('POST', `/api/v1/approvals/${approvalId}/approve`, {
              decidedBy: 'demo-orchestrator',
            }),
          )
          .then(() => log(`approved ${approvalId}`))
          .catch((error) => log(`could not approve ${approvalId}: ${error.message}`)),
      );
    }

    if (line.includes(EXPIRE_MARKER)) {
      pending.push(
        management
          .call('POST', `/api/v1/missions/${missionId}/expire`, {})
          .then(() => log(`expired mission ${missionId}`))
          .catch((error) => log(`could not expire ${missionId}: ${error.message}`)),
      );
    }
  });

  child.stderr.pipe(process.stderr);

  return pending;
}

async function runAgent(command, args, options, management, missionId, autoApprove) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  const pending = attachMarkerWatcher(child, management, missionId, autoApprove);

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  // A failed approve call is worth seeing even when the agent has already given up on it.
  await Promise.all(pending);

  return code ?? 1;
}

/** Compose mode: the stack in containers, the agent alone on an internal network. */
async function composeMode(autoApprove) {
  log('starting postgres, gateway and mock-github');
  await run('docker', ['compose', 'up', '-d', '--wait', 'postgres', 'gateway', 'mock-github']);

  const management = new Management(
    `http://127.0.0.1:${process.env['GATEWAY_PORT'] ?? '8080'}`,
    required('ADMIN_TOKEN'),
  );
  await management.waitForHealth();

  // The gateway's entrypoint migrates and seeds on start, which is where `github_work` and the
  // credential behind it come from.
  const session = await issueMission(management, 'github_work');

  log('running the demo agent on agent-net');

  return runAgent(
    'docker',
    [
      'compose',
      // The service sits behind the `demo` profile so `docker compose up` never starts it.
      '--profile',
      'demo',
      'run',
      '--rm',
      // No TTY: this output is read line by line by the marker watcher above.
      '-T',
      '-e',
      'AGENTGATE_URL=http://gateway:8080',
      '-e',
      `AGENTGATE_TOKEN=${session.token}`,
      '-e',
      'AGENTGATE_CREDENTIAL=github_work',
      '-e',
      'DEMO_MODE=container',
      'demo-agent',
    ],
    {},
    management,
    session.missionId,
    autoApprove,
  );
}

/** Starts a long-running local process and resolves once it answers on /healthz. */
async function startService(name, args, env, healthUrl) {
  const child = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const label = (line) => `${name}: ${line}`;
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (process.env['DEMO_VERBOSE'] === '1') {
      console.log(label(line));
    }
  });
  createInterface({ input: child.stderr }).on('line', (line) => console.error(label(line)));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with ${String(child.exitCode)} before becoming healthy`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        log(`${name} is up`);
        return child;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name} never became healthy`);
    }
    await sleep(300);
  }
}

/**
 * Host mode: the same demo without a Docker daemon.
 *
 * Everything is a local process, so the agent's own credential has to point at a mock GitHub on
 * loopback rather than at the compose hostname the seed writes. It gets its own alias, created
 * through the management API for this run — which is also why case 2 prints whichever alias it
 * was given rather than a constant.
 */
async function hostMode(autoApprove) {
  log('building the workspace');
  await run('pnpm', [
    '--filter',
    '@agentgate/demo-agent...',
    '--filter',
    '@agentgate/mock-github',
    'build',
  ]);

  const stopped = [];
  const stopAll = () => {
    for (const child of stopped) {
      child.kill('SIGTERM');
    }
  };

  try {
    const mockGithub = await startService(
      'mock-github',
      ['services/mock-github/dist/index.js'],
      {
        PORT: String(HOST_MOCK_GITHUB_PORT),
        HOST: '127.0.0.1',
        MOCK_GITHUB_TOKEN: required('MOCK_GITHUB_TOKEN'),
      },
      `http://127.0.0.1:${String(HOST_MOCK_GITHUB_PORT)}/healthz`,
    );
    stopped.push(mockGithub);

    const gateway = await startService(
      'gateway',
      ['apps/gateway/dist/index.js'],
      {
        PORT: String(HOST_GATEWAY_PORT),
        HOST: '127.0.0.1',
        // The host-side database, which is where `make db-migrate` applied the schema.
        DATABASE_URL: required('DATABASE_URL_TEST'),
      },
      `http://127.0.0.1:${String(HOST_GATEWAY_PORT)}/healthz`,
    );
    stopped.push(gateway);

    const management = new Management(
      `http://127.0.0.1:${String(HOST_GATEWAY_PORT)}`,
      required('ADMIN_TOKEN'),
    );
    await management.waitForHealth();

    // Its own alias per run: `github_work` already exists and points at the compose hostname,
    // and the management API refuses to silently replace the secret behind an alias in use.
    const alias = `github_host_${Date.now().toString(36)}`;
    await management.call('POST', '/api/v1/credentials', {
      alias,
      provider: 'github',
      logicalHost: 'api.github.com',
      upstreamBaseUrl: `http://127.0.0.1:${String(HOST_MOCK_GITHUB_PORT)}`,
      injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
      value: required('MOCK_GITHUB_TOKEN'),
    });
    log(`created credential ${alias} → http://127.0.0.1:${String(HOST_MOCK_GITHUB_PORT)}`);

    const session = await issueMission(management, alias);

    log('running the demo agent as a local process');

    return await runAgent(
      'node',
      ['dist/main.js'],
      {
        cwd: path.join(ROOT, 'apps/demo-agent'),
        // A deliberately minimal environment, built rather than inherited: the container gets
        // exactly these four variables, and case 2 prints every one of them. Handing the agent
        // the operator's shell would both make that dump unreadable and put whatever secrets
        // happen to live there inside the sandbox the demo is about.
        env: {
          PATH: process.env['PATH'],
          AGENTGATE_URL: `http://127.0.0.1:${String(HOST_GATEWAY_PORT)}`,
          AGENTGATE_TOKEN: session.token,
          AGENTGATE_CREDENTIAL: alias,
          DEMO_MODE: 'host',
        },
      },
      management,
      session.missionId,
      autoApprove,
    );
  } finally {
    stopAll();
  }
}

loadEnvFile();

const mode = process.env['DEMO_MODE'] === 'host' ? 'host' : 'compose';
const autoApprove = process.env['DEMO_AUTO_APPROVE'] !== '0';

log(`${mode} mode, auto-approve ${autoApprove ? 'on' : 'off'}`);

const exitCode = await (mode === 'host' ? hostMode(autoApprove) : composeMode(autoApprove)).catch(
  (error) => {
    console.error(`\ndemo: ${error.message}`);

    return 1;
  },
);

log(
  exitCode === 0
    ? 'every case the run could make passed'
    : `the agent exited with ${String(exitCode)}`,
);

process.exit(exitCode);
