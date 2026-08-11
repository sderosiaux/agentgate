import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AccessDeniedError,
  ApprovalRequiredError,
  GatewayError,
  LimitExceededError,
} from '@agentgate/sdk';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MARKER,
  EXPIRE_MARKER,
  caseAllowedRead,
  caseApproval,
  caseDangerousAction,
  caseMissionExpiration,
  caseNetworkIsolation,
  caseSecretProtection,
  caseUnauthorizedRepo,
} from '../src/cases.js';
import { contextFor, response, StubGate } from './helpers/stub-gate.js';

/** Assembled, never written out: this file is inside the tree case 2 scans on a host run. */
const SECRET_FRAGMENT = ['super', 'secret'].join('-');

const ISSUE = {
  number: 423,
  state: 'open',
  title: 'Payment webhook retries duplicate charges',
};

function denied(reason: string, code = 'agentgate_access_denied'): AccessDeniedError {
  return new AccessDeniedError(reason, { code, status: 403, requestId: 'req_stub' });
}

async function emptyDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'agentgate-demo-'));
}

describe('case 0 — network isolation', () => {
  it('is skipped, loudly, when there is no sandbox to prove anything about', async () => {
    const context = contextFor(new StubGate([]), { mode: 'host' });

    const result = await caseNetworkIsolation(context);

    expect(result.skipped).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.evidence[0]).toContain('SKIPPED');
    expect(context.output).toEqual(result.evidence);
  });
});

describe('case 1 — allowed read', () => {
  it('passes on the issue the mission was written for, and remembers its title', async () => {
    const context = contextFor(new StubGate([response(200, ISSUE)]));

    const result = await caseAllowedRead(context);

    expect(result.pass).toBe(true);
    expect(context.state.issueTitle).toBe(ISSUE.title);
    expect(result.evidence.join('\n')).toContain(ISSUE.title);
    expect(context.gate.calls[0]).toMatchObject({ credential: 'github_work', method: 'GET' });
  });

  it('fails when the gateway answered with something other than the issue', async () => {
    const context = contextFor(new StubGate([response(404, { message: 'Not Found' })]));

    expect((await caseAllowedRead(context)).pass).toBe(false);
  });
});

describe('case 2 — secret protection', () => {
  it('passes when neither the environment nor the filesystem holds the token', async () => {
    const context = contextFor(new StubGate([]), { scanRoot: await emptyDirectory() });

    const result = await caseSecretProtection(context);

    expect(result.pass).toBe(true);
    expect(result.evidence).toContain('credential alias: github_work');
    // Every variable is printed, sorted, so a reader can check the claim rather than trust it.
    expect(result.evidence).toContain('  AGENTGATE_URL=http://gateway:8080');
    expect(result.evidence.indexOf('  AGENTGATE_URL=http://gateway:8080')).toBeLessThan(
      result.evidence.indexOf('  HOME=/home/agent'),
    );
  });

  it('fails when the token is in the environment', async () => {
    const context = contextFor(new StubGate([]), {
      scanRoot: await emptyDirectory(),
      env: { GITHUB_TOKEN: `${SECRET_FRAGMENT}-github-token` },
    });

    const result = await caseSecretProtection(context);

    expect(result.pass).toBe(false);
    expect(result.evidence.join('\n')).toContain('GITHUB_TOKEN');
  });

  it('fails when the token is somewhere on disk', async () => {
    const root = await emptyDirectory();
    await writeFile(path.join(root, 'leaked.txt'), `token=${SECRET_FRAGMENT}-github-token\n`);
    const context = contextFor(new StubGate([]), { scanRoot: root });

    const result = await caseSecretProtection(context);

    expect(result.pass).toBe(false);
    expect(result.evidence.join('\n')).toContain('HIT leaked.txt');
  });
});

describe('case 3 — unauthorized repository', () => {
  it('passes on a denial', async () => {
    const context = contextFor(new StubGate([denied('repository is outside the mission')]));

    const result = await caseUnauthorizedRepo(context);

    expect(result.pass).toBe(true);
    expect(result.evidence.join('\n')).toContain('repository is outside the mission');
  });

  it('fails when the gateway let it through', async () => {
    const context = contextFor(new StubGate([response(200, { full_name: 'acme/secret-project' })]));

    expect((await caseUnauthorizedRepo(context)).pass).toBe(false);
  });

  it('fails when the request was refused for an unrelated reason', async () => {
    const context = contextFor(
      new StubGate([new LimitExceededError('out of budget', { code: 'agentgate_limit_exceeded' })]),
    );

    expect((await caseUnauthorizedRepo(context)).pass).toBe(false);
  });
});

describe('case 4 — approval', () => {
  const required = new ApprovalRequiredError('pull_request.create requires approval', 'apr_demo', {
    code: 'agentgate_approval_required',
    status: 202,
    requestId: 'req_stub',
  });
  const created = response(201, {
    number: 991,
    html_url: 'https://github.com/acme/payments/pull/991',
  });

  it('asks, waits, retries with the grant, and expects the reuse to be refused', async () => {
    const gate = new StubGate([
      required,
      created,
      denied('approval apr_demo has already been used'),
    ]);
    const context = contextFor(gate, { state: { issueTitle: ISSUE.title } });

    const result = await caseApproval(context);

    expect(result.pass).toBe(true);
    expect(gate.waited).toEqual(['apr_demo']);
    expect(gate.calls[1]).toMatchObject({ approvalId: 'apr_demo' });
    expect(result.evidence).toContain(`${APPROVAL_MARKER} apr_demo`);
    expect(result.evidence.join('\n')).toContain('#991');
    // The marker has to be printed before the agent starts waiting, or the orchestrator that
    // reads it would be waiting too.
    expect(result.evidence.indexOf(`${APPROVAL_MARKER} apr_demo`)).toBeLessThan(
      result.evidence.findIndex((line) => line.includes('approval granted')),
    );
    // The title carried over from case 1.
    expect(String(gate.calls[0]?.body)).toContain(ISSUE.title);
  });

  it('fails when the first attempt was allowed outright', async () => {
    const context = contextFor(new StubGate([created]));

    expect((await caseApproval(context)).pass).toBe(false);
  });

  it('fails when the approval never became usable', async () => {
    const gate = new StubGate([required]);
    gate.waitOutcome = denied('approval apr_demo is denied');
    const context = contextFor(gate);

    const result = await caseApproval(context);

    expect(result.pass).toBe(false);
    expect(result.evidence.join('\n')).toContain('never became usable');
  });

  it('fails when the same grant can be spent twice', async () => {
    const context = contextFor(new StubGate([required, created, created]));

    const result = await caseApproval(context);

    expect(result.pass).toBe(false);
    expect(result.evidence.join('\n')).toContain('spent twice');
  });
});

describe('case 5 — dangerous action', () => {
  it('passes on a denial and fails on anything else', async () => {
    const deniedContext = contextFor(new StubGate([denied('repository.delete is denied')]));
    expect((await caseDangerousAction(deniedContext)).pass).toBe(true);
    expect(deniedContext.gate.calls[0]?.method).toBe('DELETE');

    const allowedContext = contextFor(new StubGate([response(204, '')]));
    expect((await caseDangerousAction(allowedContext)).pass).toBe(false);
  });
});

describe('case 6 — mission expiration', () => {
  it('asks the orchestrator, keeps trying, and passes once the mission is expired', async () => {
    const gate = new StubGate([
      response(200, ISSUE),
      denied('mission has expired', 'agentgate_mission_expired'),
    ]);
    const context = contextFor(gate);

    const result = await caseMissionExpiration(context);

    expect(result.pass).toBe(true);
    expect(result.evidence).toContain(EXPIRE_MARKER);
    expect(gate.calls).toHaveLength(2);
  });

  it('fails when the request is denied for a reason that is not the expiry', async () => {
    const context = contextFor(new StubGate([denied('repository is outside the mission')]));

    expect((await caseMissionExpiration(context)).pass).toBe(false);
  });

  it('fails when the mission is still usable after the deadline', async () => {
    const context = contextFor(
      new StubGate([response(200, ISSUE), response(200, ISSUE), response(200, ISSUE)]),
      { timings: { ...contextFor(new StubGate([])).timings, expirationTimeoutMs: 0 } },
    );

    const result = await caseMissionExpiration(context);

    expect(result.pass).toBe(false);
    expect(result.evidence.join('\n')).toContain('still usable');
  });

  it('fails when the gateway broke instead of refusing', async () => {
    const context = contextFor(
      new StubGate([
        new GatewayError('upstream is unreachable', {
          code: 'agentgate_upstream_error',
          status: 502,
        }),
      ]),
    );

    expect((await caseMissionExpiration(context)).pass).toBe(false);
  });
});
