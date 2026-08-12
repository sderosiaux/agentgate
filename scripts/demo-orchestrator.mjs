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
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which demo this is, taken from the invocation before `.env` is merged in.
 *
 * `.env` is the stack's configuration and is shared with compose; a `DEMO_MODE=host` line left
 * in it would otherwise turn `make demo` into a host run without saying so, and the run would
 * quietly stop proving the one thing only containers can prove.
 */
const INVOKED_MODE = process.env['DEMO_MODE'];

/** What the agent prints when it needs the outside world to do something (see `cases.ts`). */
const APPROVAL_MARKER = 'DEMO_MARKER:APPROVAL_PENDING';
const EXPIRE_MARKER = 'DEMO_MARKER:EXPIRE_MISSION';

/** How long a human is imagined to take. Long enough to read the line, short enough to watch. */
const APPROVAL_DELAY_MS = 2_000;

const MISSION_TTL_MS = 60 * 60 * 1000;

/** What counts as "yes, approve it for me" in DEMO_AUTO_APPROVE. Anything else is a no. */
const APPROVED_SPELLINGS = new Set(['1', 'true', 'yes', 'on']);

/**
 * The ports a host-mode run binds, when nothing says otherwise. Overridable because 8099 and
 * 3001 are ordinary numbers on a developer's machine and something else may already hold them —
 * which used to be discovered as a demo that passed against a *foreign* process.
 */
const HOST_PORT_DEFAULTS = { DEMO_GATEWAY_PORT: 8099, DEMO_MOCK_GITHUB_PORT: 3001 };

/**
 * The mission every run is issued, read from the one document the seed reads too
 * (`apps/gateway/prisma/demo-mission.json`). Written once rather than mirrored: a copy here and
 * a copy there is a demo that passes against a mission nobody deployed.
 */
const DEMO_MISSION_PATH = path.join(ROOT, 'apps/gateway/prisma/demo-mission.json');

function readMissionScope(credentialAlias) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(DEMO_MISSION_PATH, 'utf8'));
  } catch (error) {
    fail(`could not read ${DEMO_MISSION_PATH}: ${error.message}`);
  }

  // Field by field: the document carries a `notes` array explaining itself, and the management
  // API refuses a create body with fields it does not know.
  //
  // `allowedCredentials` is the one field this run overrides rather than copies. The document
  // names `github_work`, which is the alias the seed writes and which points at the compose
  // hostname; a host-mode run registers its own alias for the same upstream on loopback, and a
  // mission that did not name it would be refused at the credential stage on every case.
  return {
    intent: raw.intent,
    permissions: { ...raw.permissions, allowedCredentials: [credentialAlias] },
    network: raw.network,
    limits: raw.limits,
  };
}

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
    if (match[1] === 'DEMO_MODE' && match[2] !== INVOKED_MODE) {
      log(`ignoring DEMO_MODE=${match[2]} from .env: the mode comes from the make target`);
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

/**
 * Where a human would go to decide the approval, which is the host-published address of the
 * console and never the compose hostname: the agent prints this line for whoever is reading the
 * terminal, and it sits on a network from which the console is unreachable anyway.
 */
function webConsoleUrl() {
  return (
    process.env['AGENTGATE_WEB_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3000'}`
  );
}

/** A port from the environment, or the default. Read after `.env` is loaded, never before. */
function hostPort(name) {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return HOST_PORT_DEFAULTS[name];
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`${name} must be a tcp port number, not "${raw}"`);
  }

  return port;
}

/**
 * Refuses to start anything on a port that is already taken.
 *
 * Without this the health check below is the only thing standing between the demo and a
 * *foreign* process: something else answering 200 on /healthz would be adopted as the gateway,
 * and the run would report on a stack it never started. Bind-and-release is the only way to ask
 * the question that does not depend on what the other process happens to serve.
 */
async function assertPortIsFree(port, what, override) {
  await new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${String(port)} is already in use, so ${what} cannot be started there — stop what is holding it, or set ${override} to a free port`,
            )
          : error,
      );
    });
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve());
    });
  });
}

/**
 * Everything this run spawned and is responsible for killing. Module-level so a signal handler
 * can reach it: a Ctrl-C that leaves a gateway and a mock upstream holding ports turns the next
 * run into a port-collision failure with no visible cause.
 */
const started = [];

function stopStarted() {
  while (started.length > 0) {
    started.pop()?.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, stopping what this run started`);
    stopStarted();
    // 128 + signal number, as a shell reports it.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
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
    ...readMissionScope(credentialAlias),
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
          .catch(async (error) => {
            log(`could not approve ${approvalId}: ${error.message}`);

            // The agent is now waiting for a decision that is never coming, and would sit there
            // until its own timeout — two minutes of nothing, for a cause known at second two.
            // Denying it is the honest way to end the wait: the agent fails case 4 immediately,
            // the reason above is right next to it in the same output, and the audit row says
            // who decided and why.
            await management
              .call('POST', `/api/v1/approvals/${approvalId}/deny`, {
                decidedBy: 'demo-orchestrator (auto-approve failed)',
              })
              .then(() => log(`denied ${approvalId} so the agent stops waiting`))
              .catch((denial) => log(`could not deny ${approvalId} either: ${denial.message}`));
          }),
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
      // Names only, never `NAME=value`. A `-e AGENTGATE_TOKEN=<jwt>` would put a live mission
      // token in this process's argv, where `ps` shows it to every user on the host for the
      // hour it stays valid — the one place a credential must not turn up in a product whose
      // whole claim is that the agent never holds one. Given a bare name, compose forwards the
      // value from the environment below, which no process table lists.
      '-e',
      'AGENTGATE_URL',
      '-e',
      'AGENTGATE_TOKEN',
      '-e',
      'AGENTGATE_CREDENTIAL',
      '-e',
      'AGENTGATE_WEB_URL',
      'demo-agent',
    ],
    {
      env: {
        ...process.env,
        AGENTGATE_URL: 'http://gateway:8080',
        AGENTGATE_TOKEN: session.token,
        AGENTGATE_CREDENTIAL: 'github_work',
        AGENTGATE_WEB_URL: webConsoleUrl(),
      },
    },
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

  const gatewayPort = hostPort('DEMO_GATEWAY_PORT');
  const mockGithubPort = hostPort('DEMO_MOCK_GITHUB_PORT');

  // Before anything is spawned: a port already answering is a process this run did not start,
  // and adopting it would make the demo report on somebody else's stack.
  await assertPortIsFree(mockGithubPort, 'the mock GitHub', 'DEMO_MOCK_GITHUB_PORT');
  await assertPortIsFree(gatewayPort, 'the gateway', 'DEMO_GATEWAY_PORT');

  try {
    const mockGithub = await startService(
      'mock-github',
      ['services/mock-github/dist/index.js'],
      {
        PORT: String(mockGithubPort),
        HOST: '127.0.0.1',
        MOCK_GITHUB_TOKEN: required('MOCK_GITHUB_TOKEN'),
      },
      `http://127.0.0.1:${String(mockGithubPort)}/healthz`,
    );
    started.push(mockGithub);

    const gateway = await startService(
      'gateway',
      ['apps/gateway/dist/index.js'],
      {
        PORT: String(gatewayPort),
        HOST: '127.0.0.1',
        // The host-side database, which is where `make db-migrate` applied the schema.
        DATABASE_URL: required('DATABASE_URL_TEST'),
      },
      `http://127.0.0.1:${String(gatewayPort)}/healthz`,
    );
    started.push(gateway);

    const management = new Management(
      `http://127.0.0.1:${String(gatewayPort)}`,
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
      upstreamBaseUrl: `http://127.0.0.1:${String(mockGithubPort)}`,
      injection: { type: 'header', name: 'Authorization', format: 'Bearer {value}' },
      value: required('MOCK_GITHUB_TOKEN'),
    });
    log(`created credential ${alias} → http://127.0.0.1:${String(mockGithubPort)}`);

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
          AGENTGATE_URL: `http://127.0.0.1:${String(gatewayPort)}`,
          AGENTGATE_TOKEN: session.token,
          AGENTGATE_CREDENTIAL: alias,
          AGENTGATE_WEB_URL: webConsoleUrl(),
          DEMO_MODE: 'host',
        },
      },
      management,
      session.missionId,
      autoApprove,
    );
  } finally {
    stopStarted();
  }
}

loadEnvFile();

const mode = INVOKED_MODE === 'host' ? 'host' : 'compose';
// Explicitly true, or absent. `!== '0'` read `DEMO_AUTO_APPROVE=false` as a yes, which is the
// one spelling somebody turning it off is most likely to reach for. Absent still means on: the
// demo is meant to run unattended, and an .env that never mentions the variable should not
// leave the agent waiting two minutes for a click nobody was told to make.
const autoApprove = APPROVED_SPELLINGS.has(
  (process.env['DEMO_AUTO_APPROVE'] ?? '1').trim().toLowerCase(),
);

log(`${mode} mode, auto-approve ${autoApprove ? 'on' : 'off'}`);

// A rejection here means the agent never produced an exit code of its own: the stack would not
// come up, a port was taken, the management API refused something. Tracked separately so the
// last line of the run does not report a verdict from a process that never started.
let neverRan = false;

const exitCode = await (mode === 'host' ? hostMode(autoApprove) : composeMode(autoApprove)).catch(
  (error) => {
    console.error(`\ndemo: ${error.message}`);
    neverRan = true;

    return 1;
  },
);

if (neverRan) {
  log('the stack could not be prepared, so no case was run and nothing was proven');
} else {
  log(
    exitCode === 0
      ? 'every case the run could make passed'
      : `the agent exited with ${String(exitCode)}`,
  );
}

process.exit(exitCode);
