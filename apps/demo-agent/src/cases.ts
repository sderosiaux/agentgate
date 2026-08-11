import {
  AccessDeniedError,
  AgentGateSdkError,
  ApprovalRequiredError,
  type ProxyRequest,
  type ProxyResponse,
  type WaitForApprovalOptions,
} from '@agentgate/sdk';
import { describeExclusions, hasExclusions, scanForString } from './scan.js';

/**
 * Just enough of the SDK to run a case, so the suite can hand these functions a client that
 * fails on demand. The real `AgentGate` satisfies it structurally — there is no adapter and no
 * second implementation of anything.
 */
export interface DemoGate {
  request(request: ProxyRequest): Promise<ProxyResponse>;
  waitForApproval(approvalId: string, options?: WaitForApprovalOptions): Promise<void>;
}

export type DemoMode = 'container' | 'host';

export interface CaseResult {
  name: string;
  pass: boolean;
  /** A case that could not be run at all here, and is therefore not a verdict either way. */
  skipped: boolean;
  evidence: string[];
}

export interface DemoTimings {
  /** How long a raw socket may hang before "no route" is the honest reading (case 0). */
  isolationTimeoutMs: number;
  approvalTimeoutMs: number;
  approvalIntervalMs: number;
  /** How long to keep asking after the expire marker before giving up (case 6). */
  expirationTimeoutMs: number;
  expirationIntervalMs: number;
}

export const DEFAULT_TIMINGS: DemoTimings = {
  isolationTimeoutMs: 3_000,
  approvalTimeoutMs: 120_000,
  approvalIntervalMs: 1_000,
  expirationTimeoutMs: 30_000,
  expirationIntervalMs: 1_000,
};

export interface DemoContext {
  gate: DemoGate;
  /** The alias the agent names. It is the only credential-shaped thing it will ever hold. */
  credential: string;
  mode: DemoMode;
  /** The environment as the agent sees it. Passed in so a test can hand it a hostile one. */
  env: Record<string, string | undefined>;
  /** Where the filesystem scan of case 2 starts. */
  scanRoot: string;
  /** Where evidence goes as it is produced, so the orchestrator sees a marker in real time. */
  log: (line: string) => void;
  timings: DemoTimings;
  sleep: (ms: number) => Promise<void>;
  /** What one case learned and the next one needs. */
  state: { issueTitle?: string };
}

/**
 * One spelling of each case's name, used both by the case itself and by the list below, so the
 * header printed before a case runs and the row printed after it cannot disagree.
 */
export const CASE_NAMES = {
  isolation: 'Network isolation',
  allowedRead: 'Allowed read',
  secretProtection: 'Secret protection',
  unauthorizedRepo: 'Unauthorized repository',
  approval: 'Approval',
  dangerousAction: 'Dangerous action',
  expiration: 'Mission expiration',
} as const;

export const ISSUE_URL = 'https://api.github.com/repos/acme/payments/issues/423';
export const PULLS_URL = 'https://api.github.com/repos/acme/payments/pulls';
export const SECRET_REPO_URL = 'https://api.github.com/repos/acme/secret-project';
export const REPO_URL = 'https://api.github.com/repos/acme/payments';

/**
 * The action the mission forbids outright (case 5). Named here because the case asserts on the
 * *reason* the gateway gives: a mission whose network rules do not route a DELETE would refuse
 * one without the policy engine ever being asked, which is a weaker claim wearing the same
 * status code. Kept in step with `deniedActions` in the seed and in the orchestrator.
 */
const DENIED_ACTION = 'repository.delete';

/**
 * The repository the mission does not cover (case 3), spelled as the policy engine spells it.
 * `github:acme/secret-project` appears only in the resource-scope refusal — the network rules
 * would say `api.github.com/repos/acme/secret-project` — which is what makes it usable as the
 * difference between "policy refused this" and "nothing ever routed it".
 */
const OUT_OF_SCOPE_RESOURCE = 'github:acme/secret-project';

/** What the orchestrator watches stdout for. Any change here is a change to the orchestrator. */
export const APPROVAL_MARKER = 'DEMO_MARKER:APPROVAL_PENDING';
export const EXPIRE_MARKER = 'DEMO_MARKER:EXPIRE_MISSION';

/**
 * The fragment of the upstream credential the agent looks for in its own environment and disk.
 *
 * Assembled at runtime rather than written out: a demo agent whose source contains the string
 * it is proving it does not have would find itself, and the case would fail on its own honesty
 * check instead of on anything the gateway did.
 */
const SECRET_FRAGMENT = ['super', 'secret'].join('-');

function recorder(context: DemoContext): { lines: string[]; note: (line: string) => void } {
  const lines: string[] = [];

  return {
    lines,
    note(line: string) {
      lines.push(line);
      context.log(line);
    },
  };
}

/** A short description of a failure, without a stack an operator has to read past. */
function describe(error: unknown): string {
  if (error instanceof AgentGateSdkError) {
    return `${error.name} [${error.code}] ${error.message}`;
  }

  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Case 0 — the sandbox is real.
 *
 * Both fetches must fail. This is the one claim in the demo that cannot be made from the host:
 * on a developer's machine `mock-github` resolves to nothing and `example.com` resolves fine,
 * so a host run would prove the opposite of what it printed. It is skipped there, loudly.
 */
export async function caseNetworkIsolation(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.isolation;
  const { lines, note } = recorder(context);

  if (context.mode === 'host') {
    note('SKIPPED: isolation can only be proven inside the compose networks.');
    note('  DEMO_MODE=host runs the agent as an ordinary process with ordinary network access.');
    note('  Run `make demo` (compose) for this case.');

    return { name, pass: false, skipped: true, evidence: lines };
  }

  const targets = ['http://mock-github:3001/repos/acme/payments', 'https://example.com'];
  let blocked = 0;

  for (const target of targets) {
    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(context.timings.isolationTimeoutMs),
      });
      note(`REACHED ${target} → HTTP ${String(response.status)} — the sandbox is not isolated`);
    } catch (error) {
      blocked += 1;
      note(`unreachable ${target} → ${describe(error)}`);
    }
  }

  note(
    `${String(blocked)}/${String(targets.length)} direct routes out of the sandbox are unavailable`,
  );
  note('the gateway is the only thing this container can talk to');

  return { name, pass: blocked === targets.length, skipped: false, evidence: lines };
}

/** Case 1 — the request the mission exists for. */
export async function caseAllowedRead(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.allowedRead;
  const { lines, note } = recorder(context);

  const response = await context.gate.request({
    credential: context.credential,
    method: 'GET',
    url: ISSUE_URL,
  });

  note(`GET ${ISSUE_URL}`);
  note(
    `→ HTTP ${String(response.status)} (request ${response.headers['x-agentgate-request-id'] ?? 'unknown'})`,
  );

  if (response.status !== 200) {
    return { name, pass: false, skipped: false, evidence: lines };
  }

  const issue = response.json<{ number: number; title: string; state: string }>();
  context.state.issueTitle = issue.title;

  note(`issue #${String(issue.number)} [${issue.state}]: ${issue.title}`);
  note('the credential was injected by the gateway; the agent never saw it');

  return { name, pass: issue.number === 423, skipped: false, evidence: lines };
}

/** Case 2 — what the agent holds, in full, and what it does not. */
export async function caseSecretProtection(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.secretProtection;
  const { lines, note } = recorder(context);

  note('environment, sorted:');
  const names = Object.keys(context.env).sort();
  const leaking: string[] = [];

  for (const key of names) {
    const value = context.env[key] ?? '';
    note(`  ${key}=${value}`);

    if (value.includes(SECRET_FRAGMENT)) {
      leaking.push(key);
    }
  }

  note(`credential alias: ${context.credential}`);
  note(
    "the only credential-shaped value above is this mission's own token: it opens one mission, " +
      'for one hour, and case 6 ends it',
  );
  note(
    `no environment value contains "${SECRET_FRAGMENT}": ${leaking.length === 0 ? 'confirmed' : `FAILED (${leaking.join(', ')})`}`,
  );

  const scan = await scanForString(context.scanRoot, SECRET_FRAGMENT);
  note(
    `scanned ${String(scan.filesScanned)} files under ${context.scanRoot} for "${SECRET_FRAGMENT}": ${String(scan.hits.length)} hits`,
  );
  for (const hit of scan.hits) {
    note(`  HIT ${hit}`);
  }
  if (hasExclusions(scan.excluded)) {
    note(`  not read, and therefore not claimed about: ${describeExclusions(scan.excluded)}`);
  }

  return {
    name,
    pass: leaking.length === 0 && scan.hits.length === 0,
    skipped: false,
    evidence: lines,
  };
}

/**
 * Case 3 — the credential could read it; the mission says no.
 *
 * SPEC's claim here is precise: the token the gateway holds *can* read `acme/secret-project`,
 * and what stops the request is policy. So the mission routes `GET /repos/acme/**` — the
 * network layer is deliberately coarse — and the refusal has to come from the resource scope.
 * A denial that named no resource would mean the request died at the network rules, which
 * demonstrates the opposite: that this repository was never reachable in the first place.
 */
export async function caseUnauthorizedRepo(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.unauthorizedRepo;
  const { lines, note } = recorder(context);

  note(`GET ${SECRET_REPO_URL}`);

  try {
    const response = await context.gate.request({
      credential: context.credential,
      method: 'GET',
      url: SECRET_REPO_URL,
    });
    note(`→ HTTP ${String(response.status)} — the gateway let this through`);

    return { name, pass: false, skipped: false, evidence: lines };
  } catch (error) {
    note(`→ ${describe(error)}`);

    const namesTheResource =
      error instanceof AgentGateSdkError && error.reason.includes(OUT_OF_SCOPE_RESOURCE);

    note(
      namesTheResource
        ? `the credential can read this repository and the network would carry the request: the mission's resource scope is what refused it`
        : `the refusal does not name ${OUT_OF_SCOPE_RESOURCE}: this request was stopped before the policy engine saw it`,
    );

    if (error instanceof AgentGateSdkError) {
      note(`request ${error.requestId ?? 'unknown'} is in the audit trail as a denial`);
    }

    return {
      name,
      pass: error instanceof AccessDeniedError && namesTheResource,
      skipped: false,
      evidence: lines,
    };
  }
}

/** Case 4 — a human in the loop, once, for one request. */
export async function caseApproval(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.approval;
  const { lines, note } = recorder(context);

  const title = `Fix: ${context.state.issueTitle ?? 'payment webhook retries'}`;
  const pullRequest: ProxyRequest = {
    credential: context.credential,
    method: 'POST',
    url: PULLS_URL,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, head: 'fix/idempotency-key', base: 'main' }),
  };

  note(`POST ${PULLS_URL} — "${title}"`);

  const first = await context.gate.request(pullRequest).then(
    (response) => response,
    (error: unknown) => error,
  );

  if (!(first instanceof ApprovalRequiredError)) {
    note(
      first instanceof Error
        ? `→ ${describe(first)} — expected a request for approval`
        : `→ HTTP ${String((first as ProxyResponse).status)} — expected a request for approval`,
    );

    return { name, pass: false, skipped: false, evidence: lines };
  }

  note(`→ 202 approval required: ${first.reason}`);
  note(`approval ${first.approvalId} is waiting for a human`);
  // Printed before the wait starts: the orchestrator reads stdout, and a marker written after
  // the agent has already blocked would be a deadlock rather than a demo.
  note(`${APPROVAL_MARKER} ${first.approvalId}`);

  try {
    await context.gate.waitForApproval(first.approvalId, {
      timeoutMs: context.timings.approvalTimeoutMs,
      intervalMs: context.timings.approvalIntervalMs,
    });
  } catch (error) {
    note(`→ the approval never became usable: ${describe(error)}`);

    return { name, pass: false, skipped: false, evidence: lines };
  }

  note('approval granted; retrying the same request with the grant');

  let created: ProxyResponse;
  try {
    created = await context.gate.request({ ...pullRequest, approvalId: first.approvalId });
  } catch (error) {
    note(`→ the approved retry was refused: ${describe(error)}`);

    return { name, pass: false, skipped: false, evidence: lines };
  }

  if (created.status !== 201) {
    note(`→ HTTP ${String(created.status)} — expected 201`);

    return { name, pass: false, skipped: false, evidence: lines };
  }

  const pull = created.json<{ number: number; html_url: string }>();
  note(`→ 201 pull request #${String(pull.number)} — ${pull.html_url}`);

  // The same grant a second time. A single-use approval is the difference between "a human
  // allowed this request" and "a human allowed this kind of request from now on".
  const reused = await context.gate.request({ ...pullRequest, approvalId: first.approvalId }).then(
    (response) => response,
    (error: unknown) => error,
  );

  if (reused instanceof AccessDeniedError) {
    note(`reuse of approval ${first.approvalId} → ${describe(reused)}`);

    return { name, pass: true, skipped: false, evidence: lines };
  }

  note(
    reused instanceof Error
      ? `reuse of approval ${first.approvalId} → ${describe(reused)} — expected a denial`
      : `reuse of approval ${first.approvalId} → HTTP ${String((reused as ProxyResponse).status)} — the grant was spent twice`,
  );

  return { name, pass: false, skipped: false, evidence: lines };
}

/**
 * Case 5 — the action nobody may take, whatever the credential could do.
 *
 * The mission routes `DELETE /repos/acme/payments` on purpose, so this is refused by its
 * `deniedActions` list rather than by the absence of a network rule. Both are a 403; only one
 * of them is a decision somebody made. The case therefore checks the *reason*, not the status:
 * a refusal that does not name the action means the request never reached the policy engine,
 * and the thing this case claims to demonstrate did not happen.
 */
export async function caseDangerousAction(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.dangerousAction;
  const { lines, note } = recorder(context);

  note(`DELETE ${REPO_URL}`);

  try {
    const response = await context.gate.request({
      credential: context.credential,
      method: 'DELETE',
      url: REPO_URL,
    });
    note(`→ HTTP ${String(response.status)} — the repository deletion was forwarded`);

    return { name, pass: false, skipped: false, evidence: lines };
  } catch (error) {
    note(`→ ${describe(error)}`);

    const namesTheAction =
      error instanceof AgentGateSdkError && error.reason.includes(DENIED_ACTION);

    note(
      namesTheAction
        ? `the mission's deniedActions list is what refused it: the reason names ${DENIED_ACTION}`
        : `the refusal does not name ${DENIED_ACTION}: this request was stopped before the policy engine saw it`,
    );
    note('no credential was injected: nothing left the gateway');

    return {
      name,
      pass: error instanceof AccessDeniedError && namesTheAction,
      skipped: false,
      evidence: lines,
    };
  }
}

/**
 * Case 6 — the mission ends and the token stops being worth anything.
 *
 * The agent cannot expire its own mission, which is the point: it prints a marker, the
 * orchestrator calls the management API, and the agent finds out the way anything else would —
 * by being refused. It keeps asking until that happens rather than sleeping a fixed interval,
 * so the case measures the gateway rather than the two processes' clocks.
 */
export async function caseMissionExpiration(context: DemoContext): Promise<CaseResult> {
  const name = CASE_NAMES.expiration;
  const { lines, note } = recorder(context);

  note('asking the orchestrator to expire the mission');
  note(EXPIRE_MARKER);

  const deadline = Date.now() + context.timings.expirationTimeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;

    const outcome = await context.gate
      .request({ credential: context.credential, method: 'GET', url: ISSUE_URL })
      .then(
        (response) => response,
        (error: unknown) => error,
      );

    if (outcome instanceof AccessDeniedError) {
      note(`after ${String(attempts)} attempt(s), the same request as case 1 is refused:`);
      note(`→ ${describe(outcome)}`);

      return {
        name,
        pass: outcome.code === 'agentgate_mission_expired',
        skipped: false,
        evidence: lines,
      };
    }

    if (outcome instanceof Error) {
      note(`→ ${describe(outcome)} — expected the mission to be expired`);

      return { name, pass: false, skipped: false, evidence: lines };
    }

    if (Date.now() >= deadline) {
      note(
        `the mission was still usable after ${String(attempts)} attempt(s): HTTP ${String((outcome as ProxyResponse).status)}`,
      );

      return { name, pass: false, skipped: false, evidence: lines };
    }

    await context.sleep(context.timings.expirationIntervalMs);
  }
}

export interface DemoCase {
  name: string;
  run: (context: DemoContext) => Promise<CaseResult>;
}

/** The demo, in the order SPEC tells it: the sandbox first, then what the sandbox lets through. */
export const CASES: DemoCase[] = [
  { name: CASE_NAMES.isolation, run: caseNetworkIsolation },
  { name: CASE_NAMES.allowedRead, run: caseAllowedRead },
  { name: CASE_NAMES.secretProtection, run: caseSecretProtection },
  { name: CASE_NAMES.unauthorizedRepo, run: caseUnauthorizedRepo },
  { name: CASE_NAMES.approval, run: caseApproval },
  { name: CASE_NAMES.dangerousAction, run: caseDangerousAction },
  { name: CASE_NAMES.expiration, run: caseMissionExpiration },
];
