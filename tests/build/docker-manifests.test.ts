import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

/**
 * Every Dockerfile copies the manifest of every workspace project before `pnpm install`, because
 * a frozen lockfile describes the whole workspace and will not install against a subset of it.
 * Each of them says "keep this list in sync with pnpm-workspace.yaml" in a comment, and a
 * comment is not a mechanism.
 *
 * The failure mode is quiet, which is why this exists. `pnpm install --frozen-lockfile` does not
 * always refuse a missing project — it can narrow its scope instead and install a workspace that
 * is not the one the lockfile describes. So the image builds, and what breaks is whatever that
 * missing package was providing, at runtime, inside a container, some time later.
 *
 * Adding `tests/` to the workspace is the change that proved it: four Dockerfiles needed a line
 * each, and nothing but this file would have said so.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

const DOCKERFILES = [
  'apps/gateway/Dockerfile',
  'apps/web/Dockerfile',
  'apps/demo-agent/Dockerfile',
  'services/mock-github/Dockerfile',
];

/** The workspace globs, expanded against the directories that actually hold a package.json. */
function workspaceProjects(): string[] {
  const yaml = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...yaml.matchAll(/^\s*-\s*'([^']+)'/gm)].map((match) => match[1] ?? '');
  const projects = new Set<string>();

  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      projects.add(pattern.replace(/\/$/, ''));
      continue;
    }

    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(path.join(ROOT, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        projects.add(`${parent}/${entry.name}`);
      }
    }
  }

  return [...projects].sort();
}

test('the workspace globs resolve to the projects on disk', () => {
  // The guard on the guard: a pattern spelling this parser cannot read would silently make
  // every assertion below vacuous.
  const projects = workspaceProjects();

  expect(projects.length).toBeGreaterThan(5);
  expect(projects).toContain('apps/gateway');
  expect(projects).toContain('tests');
});

test.each(DOCKERFILES)('%s copies the manifest of every workspace project', (dockerfile) => {
  const contents = readFileSync(path.join(ROOT, dockerfile), 'utf8');

  const missing = workspaceProjects().filter(
    (project) =>
      // Either its own `COPY <project>/package.json`, or a `COPY <project> <project>` that
      // brings the whole directory — both put the manifest where pnpm needs it.
      !new RegExp(`^COPY\\s+${project}/package\\.json\\s`, 'm').test(contents) &&
      !new RegExp(`^COPY\\s+${project}\\s+${project}\\s*$`, 'm').test(contents),
  );

  expect({ dockerfile, missing }).toEqual({ dockerfile, missing: [] });
});
