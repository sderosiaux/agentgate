// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The rule this console is built around, checked against the artefact rather than the source.
 *
 * `ADMIN_TOKEN` unlocks the whole management API. It is read in one server-only module, and
 * every button reaches the gateway through a route handler rather than directly — but "no client
 * component imports the API module" is a claim about code, and what ships to a browser is the
 * only thing that settles it. So: build with a token nothing else in the repository uses, then
 * read every byte Next serves to a browser and look for it.
 *
 * The build runs here rather than being assumed, because a check that silently passes when there
 * is nothing to inspect is worse than no check.
 */

const CANARY = 'canary-admin-token-9f3a2b7c4d1e-DEV-ONLY';

const root = fileURLToPath(new URL('..', import.meta.url));
const staticDir = join(root, '.next', 'static');

/** Everything below has to be about the build this file just ran, not one left lying around. */
const startedAt = Date.now();

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

beforeAll(() => {
  execFileSync('node', [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: root,
    env: {
      ...process.env,
      ADMIN_TOKEN: CANARY,
      // Nothing is fetched during the build — every route is server-rendered on demand — but a
      // real address here would be a real request if that ever changed.
      GATEWAY_URL: 'http://127.0.0.1:9',
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
}, 600_000);

describe('the client bundle', () => {
  it('was built by this test run, and contains something to inspect', () => {
    expect(statSync(staticDir).isDirectory()).toBe(true);
    expect(filesUnder(staticDir).filter((file) => file.endsWith('.js')).length).toBeGreaterThan(0);
    // Otherwise the two assertions below could pass against a stale directory built with some
    // other token, which would make this whole file decorative.
    expect(statSync(join(root, '.next', 'BUILD_ID')).mtimeMs).toBeGreaterThanOrEqual(startedAt);
  });

  it('carries no trace of the admin token', () => {
    const carriers = filesUnder(staticDir).filter((file) =>
      readFileSync(file, 'utf8').includes(CANARY),
    );

    expect(carriers).toEqual([]);
  });

  it('holds no management API path, so no client code calls the gateway directly', () => {
    // The other half of the same rule. Every control in the console posts to a route handler
    // under `/api/`, and the `/api/v1/` prefix belongs to the gateway alone — a client chunk
    // carrying one would mean some button had learned to skip the server.
    const carriers = filesUnder(staticDir).filter((file) =>
      readFileSync(file, 'utf8').includes('/api/v1/'),
    );

    expect(carriers).toEqual([]);
  });
});
