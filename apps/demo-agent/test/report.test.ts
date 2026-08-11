import { describe, expect, it } from 'vitest';
import type { CaseResult } from '../src/cases.js';
import { allPassed, exitCode, renderTable, verdictOf } from '../src/report.js';

function result(name: string, pass: boolean, skipped = false): CaseResult {
  return { name, pass, skipped, evidence: [] };
}

describe('the demo report', () => {
  it('reads a skipped case as neither a pass nor a failure', () => {
    const results = [result('Network isolation', false, true), result('Allowed read', true)];

    expect(verdictOf(results[0] as CaseResult)).toBe('SKIP');
    expect(allPassed(results)).toBe(true);
    expect(exitCode(results)).toBe(0);
    expect(renderTable(results)).toContain('1 passed, 0 failed, 1 skipped');
  });

  it('fails the run when any case that ran did not pass', () => {
    const results = [result('Allowed read', true), result('Approval', false)];

    expect(allPassed(results)).toBe(false);
    expect(exitCode(results)).toBe(1);
    expect(renderTable(results)).toContain('FAIL');
  });

  it('numbers the rows the way the cases are numbered', () => {
    const table = renderTable([result('Network isolation', true), result('Allowed read', true)]);

    expect(table).toContain(' 0  │ Network isolation │ PASS');
    expect(table).toContain(' 1  │ Allowed read      │ PASS');
  });
});
