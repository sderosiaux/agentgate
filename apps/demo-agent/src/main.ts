import { AgentGate } from '@agentgate/sdk';
import {
  CASES,
  DEFAULT_TIMINGS,
  type CaseResult,
  type DemoContext,
  type DemoMode,
} from './cases.js';
import { exitCode, renderTable } from './report.js';

/** The alias the seed creates. Overridable so a host-mode run can point at its own credential. */
const DEFAULT_CREDENTIAL = 'github_work';

/** Missing wiring: a failure to start, not a case that went wrong. */
class MissingEnvironment extends Error {}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new MissingEnvironment(
      `${name} is not set: the demo agent is started by scripts/demo-orchestrator.mjs`,
    );
  }

  return value;
}

function log(line: string): void {
  console.log(line);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mode: DemoMode = process.env['DEMO_MODE'] === 'host' ? 'host' : 'container';

function buildContext(): DemoContext {
  return {
    gate: new AgentGate({
      gatewayUrl: required('AGENTGATE_URL'),
      token: required('AGENTGATE_TOKEN'),
    }),
    credential: process.env['AGENTGATE_CREDENTIAL'] ?? DEFAULT_CREDENTIAL,
    mode,
    env: process.env,
    // `/app` is where the image puts the workspace. A host run scans the directory it was
    // started in, which the orchestrator sets to this package.
    scanRoot: process.env['DEMO_SCAN_ROOT'] ?? (mode === 'host' ? process.cwd() : '/app'),
    // Published on the host, not reachable from here: it is printed for whoever is watching the
    // terminal, so it has to be the address *they* can open.
    consoleUrl: process.env['AGENTGATE_WEB_URL'] ?? 'http://localhost:3000',
    log,
    timings: DEFAULT_TIMINGS,
    sleep,
    state: {},
  };
}

async function run(): Promise<number> {
  const context = buildContext();

  log(`AgentGate demo agent — ${mode} mode`);
  log(`gateway: ${process.env['AGENTGATE_URL'] ?? ''}`);
  log(`credential alias: ${context.credential}`);

  const results: CaseResult[] = [];

  for (const [index, demoCase] of CASES.entries()) {
    log('');
    log(`── case ${String(index)}: ${demoCase.name}`);

    const result = await demoCase.run(context).catch((error: unknown) => {
      // A case that threw where it did not expect to is a failure of that case, not of the run:
      // the remaining ones still have something to say and the table has to show all of it.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      log(`unexpected failure: ${message}`);

      return { name: demoCase.name, pass: false, skipped: false, evidence: [message] };
    });

    results.push(result);
  }

  log('');
  log(renderTable(results));

  return exitCode(results);
}

try {
  // `process.exitCode`, never `process.exit`: stdout is a pipe whenever the orchestrator is
  // reading it, writes to a pipe are asynchronous, and `process.exit` abandons whatever is
  // still queued. The table is the last thing written and the one thing a CI run keeps, so it
  // is precisely what would be lost. Letting the loop drain costs nothing here — the SDK's
  // timers are unref'd, so nothing else is holding this process open.
  process.exitCode = await run();
} catch (error) {
  if (!(error instanceof MissingEnvironment)) {
    throw error;
  }

  console.error(error.message);
  process.exitCode = 2;
}
