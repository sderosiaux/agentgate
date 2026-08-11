import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

/**
 * The SPEC's one security test, as a suite entry so that `pnpm -r test` runs it.
 *
 * The work is all in `scripts/leak-scan.mjs`, which runs the demo for real and then reads the
 * transcript, both databases, every management GET, the OpenAPI document, every console page
 * and `docker compose logs`. This file is what makes it a thing CI fails on rather than a thing
 * somebody remembers to run.
 *
 * Two tests, and the second is the one that keeps the first honest: a scanner that has never
 * been observed to fail is indistinguishable from a script that prints "clean" and exits.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

interface Run {
  code: number;
  output: string;
}

async function leakScan(...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/leak-scan.mjs', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

test('the upstream token reaches nothing a demo run leaves behind', async () => {
  const run = await leakScan();

  // The output is printed on failure rather than summarised: "the leak scan failed" without the
  // location is the least actionable sentence a CI log can contain.
  expect(run.output.includes('leak-scan: clean') ? 'clean' : run.output).toBe('clean');
  expect(run.code).toBe(0);
});

test('a planted secret is caught, so a clean result means something', async () => {
  const transcript = path.join(mkdtempSync(path.join(tmpdir(), 'agentgate-leak-')), 'planted.txt');
  writeFileSync(
    transcript,
    // The literal from the SPEC, which is also what `.env` holds for the demo. A run that fails
    // to notice this string is a run whose green result is worth nothing.
    'gateway forwarded with Authorization: Bearer super-secret-github-token\n',
  );

  const run = await leakScan('--transcript', transcript, '--transcript-only');

  expect(run.code).toBe(1);
  expect(run.output).toContain('leak-scan: FAILED');
  expect(run.output).toContain('MOCK_GITHUB_TOKEN');
  // And the report itself does not repeat the secret it is reporting: a leak scanner that
  // prints the value into a CI log everyone can read has leaked it on everyone's behalf.
  expect(run.output).not.toContain('super-secret-github-token');
});

test("the self-test does not overwrite the real run's verdict", () => {
  // Runs last, and reads the file the first test left behind. The test above deliberately
  // fails a scan, and a partial scan that writes its own failure into the run's verdict file
  // leaves every green build shipping a report that says FAILED — which CI then uploads as
  // though the suite had found something. The alarm test must not be able to trip the alarm.
  const report = readFileSync(path.join(ROOT, 'artifacts/leak-report.txt'), 'utf8');

  expect(report).toContain('clean');
  expect(report).not.toContain('FAILED');
});
