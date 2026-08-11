import type { CaseResult } from './cases.js';

export type Verdict = 'PASS' | 'FAIL' | 'SKIP';

export function verdictOf(result: CaseResult): Verdict {
  if (result.skipped) {
    return 'SKIP';
  }

  return result.pass ? 'PASS' : 'FAIL';
}

/**
 * A skipped case is not a passing one, and it is not a failing one either: it is a claim this
 * run was not in a position to make. Counting it as either would make `make demo` say something
 * untrue about the run — which is the one thing a demo of an authorization product cannot do.
 */
export function allPassed(results: CaseResult[]): boolean {
  return results.every((result) => result.skipped || result.pass);
}

export function exitCode(results: CaseResult[]): number {
  return allPassed(results) ? 0 : 1;
}

/** The summary a human reads after the evidence has scrolled past. */
export function renderTable(results: CaseResult[]): string {
  const width = Math.max(4, ...results.map((result) => result.name.length));
  const rule = `${'─'.repeat(4)}┼${'─'.repeat(width + 2)}┼${'─'.repeat(8)}`;

  const rows = results.map((result, index) => {
    return ` ${String(index)}  │ ${result.name.padEnd(width)} │ ${verdictOf(result)}`;
  });

  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.skipped && !result.pass).length;
  const passed = results.filter((result) => !result.skipped && result.pass).length;

  return [
    ` #  │ ${'Case'.padEnd(width)} │ Result`,
    rule,
    ...rows,
    rule,
    `${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`,
  ].join('\n');
}
