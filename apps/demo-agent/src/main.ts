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

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    console.error(`${name} is not set: the demo agent is started by scripts/demo-orchestrator.mjs`);
    process.exit(2);
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
const gatewayUrl = required('AGENTGATE_URL');

const context: DemoContext = {
  gate: new AgentGate({ gatewayUrl, token: required('AGENTGATE_TOKEN') }),
  credential: process.env['AGENTGATE_CREDENTIAL'] ?? DEFAULT_CREDENTIAL,
  mode,
  env: process.env,
  // `/app` is where the image puts the workspace. A host run scans the directory it was started
  // in, which the orchestrator sets to this package.
  scanRoot: process.env['DEMO_SCAN_ROOT'] ?? (mode === 'host' ? process.cwd() : '/app'),
  log,
  timings: DEFAULT_TIMINGS,
  sleep,
  state: {},
};

log(`AgentGate demo agent — ${mode} mode`);
log(`gateway: ${gatewayUrl}`);
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

process.exit(exitCode(results));
