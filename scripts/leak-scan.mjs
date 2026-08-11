#!/usr/bin/env node
/**
 * The SPEC's one security test: run the demo, then look everywhere the upstream token could
 * have ended up and fail if it is in any of them.
 *
 * The whole product claim is that an agent does useful authenticated work without ever holding
 * the credential. That claim is only worth the checking: a redacting log serialiser is a promise
 * about the code paths somebody thought of, and this is the thing that reads the actual output.
 *
 * It scans, in order:
 *
 *   1. every byte the demo run printed — the agent, the gateway, the upstream, the orchestrator
 *   2. every row of every table, in both databases, as JSON
 *   3. every management GET plus the OpenAPI document, against a live gateway
 *   4. every console page's HTML
 *   5. `docker compose logs` for the whole stack
 *
 * Zero tolerance: one hit anywhere is exit 1, naming the location.
 *
 * What it cannot reach, it says out loud rather than passing quietly. A check that skips in
 * silence is worse than one that does not exist, because the summary still says green.
 *
 *   node scripts/leak-scan.mjs
 *   node scripts/leak-scan.mjs --transcript artifacts/demo-output.txt   # reuse a demo run
 *   node scripts/leak-scan.mjs --transcript FILE --transcript-only      # just that file
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const TRANSCRIPT = path.join(ARTIFACTS, 'demo-output.txt');
/** Where the verdict is written, so a truncated terminal cannot destroy a finding. */
const REPORT = path.join(ARTIFACTS, 'leak-report.txt');

/**
 * Shortest string worth hunting for. Anything below this matches ordinary text by accident, and
 * a scanner that cries wolf on the word "test" is one people learn to run with their eyes shut.
 */
const MIN_NEEDLE_LENGTH = 12;

// ---------------------------------------------------------------------------- environment

function loadEnvFile() {
  let contents;
  try {
    contents = readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    console.error('leak-scan: no .env found — run `make setup` first.');
    process.exit(1);
  }

  for (const line of contents.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null) {
      process.env[match[1]] ??= match[2];
    }
  }
}

/**
 * What must not appear anywhere.
 *
 * The literal from the SPEC is included whatever `.env` says: a deployment that rotated
 * MOCK_GITHUB_TOKEN should still fail if the committed fixture value is sitting in a log
 * somebody pasted, and the test the SPEC actually asks for is the one that greps for that
 * string. ADMIN_TOKEN is here because it is the other credential in this system — it does not
 * open GitHub, it opens the approve button.
 */
function collectNeedles() {
  const candidates = [
    ['MOCK_GITHUB_TOKEN', process.env['MOCK_GITHUB_TOKEN']],
    ['ADMIN_TOKEN', process.env['ADMIN_TOKEN']],
    ['the SPEC fixture token', 'super-secret-github-token'],
  ];

  const needles = [];
  const seen = new Set();

  for (const [name, value] of candidates) {
    if (typeof value !== 'string' || value.length < MIN_NEEDLE_LENGTH || seen.has(value)) {
      continue;
    }
    seen.add(value);
    needles.push({ name, value });
  }

  if (needles.length === 0) {
    console.error('leak-scan: nothing to look for — MOCK_GITHUB_TOKEN and ADMIN_TOKEN are unset');
    process.exit(1);
  }

  return needles;
}

// ---------------------------------------------------------------------------- reporting

const findings = [];
const checks = [];
let needles = [];

/** A skip nobody can miss, recorded so the summary repeats it after the green lines. */
function skip(name, why, fix) {
  checks.push({ name, status: 'SKIPPED', why, fix });
  console.log('');
  console.log(`  ############  SKIPPED: ${name}`);
  console.log(`  ############  ${why}`);
  if (fix !== undefined) {
    console.log(`  ############  to run it: ${fix}`);
  }
  console.log('');
}

function scanned(name, sources) {
  const bytes = sources.reduce((total, source) => total + source.text.length, 0);
  checks.push({ name, status: 'scanned', detail: `${sources.length} source(s), ${bytes} bytes` });
  console.log(`  ok  ${name} — ${String(sources.length)} source(s), ${String(bytes)} bytes`);
}

/**
 * The text with the secret taken out, so that a scanner reporting a leak is not itself the
 * thing that writes it to a terminal, a CI log and an artifact bucket.
 */
function redactedContext(text, index, needle) {
  const before = text.slice(Math.max(0, index - 60), index).replace(/\s+/g, ' ');
  const after = text
    .slice(index + needle.value.length, index + needle.value.length + 60)
    .replace(/\s+/g, ' ');

  return `…${before}<<< ${needle.name} >>>${after}…`;
}

function look(where, text) {
  if (typeof text !== 'string' || text === '') {
    return { where, text: '' };
  }

  for (const needle of needles) {
    let index = text.indexOf(needle.value);
    while (index !== -1) {
      findings.push({
        where,
        needle: needle.name,
        offset: index,
        context: redactedContext(text, index, needle),
      });
      index = text.indexOf(needle.value, index + needle.value.length);
    }
  }

  return { where, text };
}

// ---------------------------------------------------------------------------- helpers

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a command to completion and returns its combined output, whatever the exit code. */
async function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const started = [];

function stopStarted() {
  while (started.length > 0) {
    started.pop()?.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopStarted();
    process.exit(130);
  });
}

/** Starts a local service and waits for it to answer. Its own output is scanned too. */
async function startService(name, command, args, env, healthUrl, timeoutMs = 90_000) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with ${String(child.exitCode)} before answering:\n${output}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return { child, output: () => output };
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name} never answered on ${healthUrl}:\n${output}`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------- 1. the demo

/**
 * The demo, run for real, with every byte it prints kept.
 *
 * This is the source that matters most: it is the only one where the token is actually in play —
 * decrypted in gateway memory, injected into a request, sent to an upstream that demands it. The
 * other four checks look at what was stored afterwards; this one looks at what was said while
 * it was happening.
 */
async function runDemo() {
  const explicit = process.argv.indexOf('--transcript');
  const reuse = explicit === -1 ? process.env['LEAK_SCAN_TRANSCRIPT'] : process.argv[explicit + 1];

  if (reuse !== undefined && reuse !== '') {
    const file = path.resolve(ROOT, reuse);
    console.log(`  reusing the transcript at ${file}`);

    return look(`demo transcript (${file})`, readFileSync(file, 'utf8'));
  }

  const gatewayPort = await freePort();
  const mockGithubPort = await freePort();
  console.log(`  running the host-mode demo (gateway :${String(gatewayPort)})`);

  const { code, output } = await capture('node', ['scripts/demo-orchestrator.mjs'], {
    env: {
      ...process.env,
      DEMO_MODE: 'host',
      DEMO_GATEWAY_PORT: String(gatewayPort),
      DEMO_MOCK_GITHUB_PORT: String(mockGithubPort),
      // Everything the services print, not only what the agent prints. A gateway that logs a
      // header is exactly the failure this exists to catch, and by default its stdout is dropped.
      DEMO_VERBOSE: '1',
    },
  });

  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(TRANSCRIPT, output, { mode: 0o600 });

  if (code !== 0) {
    console.error(`\nleak-scan: the demo exited with ${String(code)} — see ${TRANSCRIPT}`);
    console.error('leak-scan: scanning the output of a demo that failed proves nothing.\n');
    process.exit(1);
  }

  return look(`demo transcript (${TRANSCRIPT})`, output);
}

// ---------------------------------------------------------------------------- 2. databases

/**
 * Every row of every table, as JSON.
 *
 * Table by table rather than through the Prisma models: a model this script does not know about
 * is exactly the one a future migration adds, and the point of the check is to cover the columns
 * nobody thought to cover. `Credential.ciphertext` is in here too — the plaintext must not be
 * recoverable from a dump, which is what AES-GCM at rest is supposed to mean.
 */
async function scanDatabases() {
  const { createPrismaClient } = await import(
    pathToUrl(path.join(ROOT, 'apps/gateway/dist/db.js'))
  );

  const targets = [
    ['test database', process.env['DATABASE_URL_TEST']],
    ['demo database', process.env['DATABASE_URL_DEMO']],
  ].filter(([, url]) => typeof url === 'string' && url !== '');

  if (targets.length === 0) {
    skip(
      'the databases',
      'neither DATABASE_URL_TEST nor DATABASE_URL_DEMO is set',
      'set them in .env (see .env.example)',
    );

    return [];
  }

  const sources = [];

  for (const [label, url] of targets) {
    const prisma = createPrismaClient(url);
    try {
      const tables = await prisma.$queryRawUnsafe(
        `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );

      for (const { table_name: table } of tables) {
        const rows = await prisma.$queryRawUnsafe(`select * from "${table}"`);
        sources.push(look(`${label} → table ${table} (${String(rows.length)} rows)`, asJson(rows)));
      }
    } catch (error) {
      skip(
        `${label} (${url.replace(/:[^:@/]*@/, ':***@')})`,
        error.message,
        'run `make db-migrate`',
      );
    } finally {
      await prisma.$disconnect();
    }
  }

  return sources;
}

/** Postgres hands back BigInt counters and Buffer ciphertext; neither survives JSON by default. */
function asJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') {
      return item.toString();
    }
    if (item instanceof Uint8Array) {
      return Buffer.from(item).toString('base64');
    }

    return item;
  });
}

function pathToUrl(file) {
  return new URL(`file://${file}`).href;
}

// ---------------------------------------------------------------------------- 3. the API

/**
 * Every GET the management API publishes, plus the document that publishes them.
 *
 * The route list comes from the OpenAPI document rather than from a list written here: a route
 * added next month is covered without anybody remembering this file exists. Path parameters are
 * filled from the ids the list endpoints just returned, so the detail routes are fetched against
 * real rows — an empty 404 sweep would be a very green way to check nothing.
 */
async function scanManagementApi(baseUrl, adminToken) {
  const sources = [];
  const headers = { authorization: `Bearer ${adminToken}` };

  const docsJson = await fetch(`${baseUrl}/api/docs/json`);
  const document = await docsJson.text();
  sources.push(look('GET /api/docs/json (the OpenAPI document)', document));
  sources.push(
    look('GET /api/docs (the browsable UI)', await (await fetch(`${baseUrl}/api/docs`)).text()),
  );

  const paths = Object.entries(JSON.parse(document).paths ?? {});
  const ids = new Map();

  // Collections first, so their ids can fill the `{id}` in the detail routes below.
  const ordered = [
    ...paths.filter(([url]) => !url.includes('{')),
    ...paths.filter(([url]) => url.includes('{')),
  ];

  for (const [template, methods] of ordered) {
    if (methods.get === undefined) {
      continue;
    }

    for (const url of expand(template, ids)) {
      const response = await fetch(`${baseUrl}${url}`, { headers });
      const body = await response.text();
      sources.push(look(`GET ${url} → ${String(response.status)}`, body));
      remember(template, body, ids);
    }
  }

  return sources;
}

/**
 * Every id a list route returned, keyed by the placeholder it can fill.
 *
 * Each list wraps its rows under its own name — `missions`, `events`, `approvals` — so the
 * first array in the body is what gets read rather than a key written down here. One fewer
 * thing to update when a route is added, which is the whole point of driving this from the
 * document in the first place.
 */
function remember(template, body, ids) {
  if (template.includes('{')) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : (Object.values(parsed).find((value) => Array.isArray(value)) ?? []);

  // Two per collection: enough to prove the detail route is really being read, few enough that
  // a thousand audit rows do not turn this into a thousand HTTP calls.
  const take = (pick) =>
    rows
      .map(pick)
      .filter((id) => typeof id === 'string')
      .slice(0, 2);

  const collection = template.split('/').filter(Boolean).pop();
  const found = take((row) => row?.id);
  if (found.length > 0) {
    ids.set(collection, found);
  }

  // `/decisions/{requestId}` is keyed by the id the *agent* was handed, which the audit list is
  // the only place to find. Without this the flagship route is swept as a 404.
  const requestIds = take((row) => row?.requestId);
  if (requestIds.length > 0) {
    ids.set('decisions', requestIds);
  }
}

/** `/api/v1/missions/{id}` against the ids that exist, or nothing when none do. */
function expand(template, ids) {
  const placeholder = /\{([^}]+)\}/.exec(template);
  if (placeholder === null) {
    return [template];
  }

  const collection = template
    .split('/')
    .filter((part) => part !== '' && !part.startsWith('{'))
    .pop();

  return (ids.get(collection) ?? []).map((id) =>
    template.replace(placeholder[0], encodeURIComponent(id)),
  );
}

// ---------------------------------------------------------------------------- 4. the console

/** Every page the console serves, as the HTML a browser would receive. */
async function scanWebPages(baseUrl, apiBase, adminToken) {
  const sources = [];
  const pages = ['/', '/agents', '/missions', '/policies', '/credentials', '/approvals', '/audit'];

  // The detail pages are where the interesting data is rendered, so they are fetched against
  // rows that exist rather than as 404s.
  const headers = { authorization: `Bearer ${adminToken}` };

  async function firstRow(url) {
    const response = await fetch(`${apiBase}${url}`, { headers });
    const body = await response.json().catch(() => ({}));

    return Object.values(body).find((value) => Array.isArray(value))?.[0] ?? {};
  }

  for (const collection of ['agents', 'missions']) {
    const { id } = await firstRow(`/api/v1/${collection}`);
    if (typeof id === 'string') {
      pages.push(`/${collection}/${id}`);
    }
  }

  // The runtime decision view: the flagship screen, and the one page that renders the whole
  // policy input. If any page were going to show something it should not, it is this one.
  const { requestId } = await firstRow('/api/v1/audit?limit=1');
  if (typeof requestId === 'string') {
    pages.push(`/decisions/${requestId}`);
  }

  for (const page of pages) {
    const response = await fetch(`${baseUrl}${page}`);
    sources.push(
      look(`GET ${page} (console HTML) → ${String(response.status)}`, await response.text()),
    );
  }

  return sources;
}

// ---------------------------------------------------------------------------- 5. compose

async function scanComposeLogs() {
  const daemon = await capture('docker', ['info']).catch(() => ({ code: 1, output: '' }));

  if (daemon.code !== 0) {
    skip(
      'docker compose logs',
      'no Docker daemon answered `docker info`, so no container ever ran here and there are no container logs to read',
      'start Docker, then `docker compose up --build -d && make demo && node scripts/leak-scan.mjs`',
    );

    return [];
  }

  const { output } = await capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix']);
  if (output.trim() === '') {
    skip(
      'docker compose logs',
      'the daemon is up but this project has no containers, so the logs are empty',
      '`docker compose up --build -d && make demo` first',
    );

    return [];
  }

  return [look('docker compose logs (every service)', output)];
}

// ---------------------------------------------------------------------------- main

loadEnvFile();
needles = collectNeedles();

console.log('');
console.log('leak-scan: looking for');
for (const needle of needles) {
  console.log(`  - ${needle.name} (${String(needle.value.length)} characters)`);
}
console.log('');

/**
 * Scan one file and stop. What the suite uses to prove the alarm is wired: it hands this a
 * transcript with the secrets planted in it and requires a non-zero exit. A leak scanner nobody
 * has ever seen fail is indistinguishable from a script that prints "clean" and returns.
 */
const transcriptOnly = process.argv.includes('--transcript-only');

try {
  console.log('1. the demo run');
  scanned('demo output', [await runDemo()]);

  if (transcriptOnly) {
    skip(
      'the databases, the API, the console and the containers',
      '--transcript-only was passed, so only the file above was read',
      'drop the flag',
    );
  } else {
    console.log('2. the databases');
    const database = await scanDatabases();
    if (database.length > 0) {
      scanned('database rows', database);
    }

    console.log('3. the management API');
    const gatewayPort = await freePort();
    const adminToken = process.env['ADMIN_TOKEN'];
    /**
     * The database the swept gateway reads, which has to be the one the demo just wrote to or
     * this stage rakes an empty schema and reports it as clean.
     *
     * `DATABASE_URL_TEST` is right by default, because the default is a host-mode demo and that
     * is where it writes. A compose demo writes to `DATABASE_URL` instead, and nothing here can
     * work that out on its own — the transcript may have come from either. So it is a variable,
     * and CI sets it in the job where the demo ran in containers.
     */
    const databaseUrl =
      process.env['LEAK_SCAN_DATABASE_URL'] ?? process.env['DATABASE_URL_TEST'] ?? '';

    if (databaseUrl === '') {
      skip(
        'the management API and the console',
        'neither LEAK_SCAN_DATABASE_URL nor DATABASE_URL_TEST is set, so no gateway can be started',
        'set DATABASE_URL_TEST in .env (see .env.example)',
      );
    } else {
      const gateway = await startService(
        'gateway',
        'node',
        ['apps/gateway/dist/index.js'],
        { PORT: String(gatewayPort), HOST: '127.0.0.1', DATABASE_URL: databaseUrl },
        `http://127.0.0.1:${String(gatewayPort)}/healthz`,
      );
      const apiBase = `http://127.0.0.1:${String(gatewayPort)}`;
      scanned('management API responses', await scanManagementApi(apiBase, adminToken));

      console.log('4. the console');
      if (!existsSync(path.join(ROOT, 'apps/web/.next/BUILD_ID'))) {
        skip(
          'the console pages',
          'apps/web has not been built, so there is no console to serve',
          'pnpm --filter @agentgate/web build, then re-run',
        );
      } else {
        const webPort = await freePort();
        await startService(
          'web',
          'pnpm',
          ['--filter', '@agentgate/web', 'exec', 'next', 'start', '--port', String(webPort)],
          {
            GATEWAY_URL: apiBase,
            ADMIN_TOKEN: adminToken,
            PORT: String(webPort),
            NODE_ENV: 'production',
          },
          `http://127.0.0.1:${String(webPort)}/`,
        );
        scanned(
          'console pages',
          await scanWebPages(`http://127.0.0.1:${String(webPort)}`, apiBase, adminToken),
        );
      }

      // The gateway's own stdout for the whole sweep: it logged every one of those requests.
      scanned('gateway log output', [look('gateway stdout during the sweep', gateway.output())]);
    }

    console.log('5. the containers');
    const compose = await scanComposeLogs();
    if (compose.length > 0) {
      scanned('docker compose logs', compose);
    }
  }
} finally {
  stopStarted();
}

// ---------------------------------------------------------------------------- verdict

/**
 * The verdict, on disk as well as on the terminal.
 *
 * Written because of a real loss: a run of this script reported five occurrences and the
 * locations went to stderr through a `| head` that cut them off. Terminals truncate, CI
 * collapses log groups, and a pipeline eats stderr. A file does none of those. The needle
 * values are still redacted out of it: this records where something was found, never what.
 *
 * `--transcript-only` writes nothing, and that is the point of this function having a guard at
 * all. That mode reads one file and skips the databases, the API, the console and the
 * containers, so its verdict is not a verdict about the system. The suite uses it to plant a
 * secret and require a failure — and a partial scan that wrote its own failure here would leave
 * every green build with a report saying FAILED, which CI would then upload as a finding. The
 * test for the alarm must not be able to trip the alarm.
 */
function writeReport(lines) {
  if (transcriptOnly) {
    return null;
  }

  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(REPORT, `${lines.join('\n')}\n`, { mode: 0o600 });

    return REPORT;
  } catch (error) {
    console.error(`leak-scan: could not write ${REPORT}: ${error.message}`);

    return null;
  }
}

console.log('');
const skipped = checks.filter((check) => check.status === 'SKIPPED');
const report = [
  `leak-scan ${new Date().toISOString()}`,
  '',
  'checks:',
  ...checks.map((check) =>
    check.status === 'SKIPPED'
      ? `  SKIPPED  ${check.name} — ${check.why}`
      : `  scanned  ${check.name} — ${check.detail}`,
  ),
  '',
];

if (skipped.length > 0) {
  console.log(`leak-scan: ${String(skipped.length)} check(s) did NOT run:`);
  for (const check of skipped) {
    console.log(`  - ${check.name}: ${check.why}`);
  }
  console.log('  A green result below says nothing about these.');
  console.log('');
}

if (findings.length > 0) {
  const detail = findings.flatMap((finding) => [
    `  - ${finding.needle} in ${finding.where} at byte ${String(finding.offset)}`,
    `      ${finding.context}`,
  ]);

  console.error(`leak-scan: FAILED — ${String(findings.length)} occurrence(s):`);
  for (const line of detail) {
    console.error(line);
  }

  const written = writeReport([
    ...report,
    `FAILED — ${String(findings.length)} occurrence(s):`,
    ...detail,
  ]);
  if (written !== null) {
    console.error(`\nleak-scan: the same list is in ${written}, in full.`);
  }
  console.error('');
  process.exit(1);
}

const ran = checks.filter((check) => check.status === 'scanned').length;
writeReport([...report, `clean — ${String(ran)} check(s) ran, no occurrence of any secret.`]);
console.log(`leak-scan: clean — ${String(ran)} check(s) ran, no occurrence of any secret.`);
process.exit(0);
