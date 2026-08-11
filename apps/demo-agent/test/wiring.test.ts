import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVAL_MARKER, EXPIRE_MARKER } from '../src/cases.js';

const ORCHESTRATOR = path.resolve(import.meta.dirname, '../../../scripts/demo-orchestrator.mjs');

/**
 * The agent and the orchestrator agree on two strings and nothing else: one asks for an
 * approval, the other performs it. They cannot import from each other — one is TypeScript
 * compiled into a container, the other a host-side script — so the agreement is checked here
 * rather than assumed. A rename on either side that forgets the other stops being a demo that
 * hangs for two minutes and becomes a test that fails in milliseconds.
 */
describe('the markers the orchestrator watches for', () => {
  it('are spelled the same way on both sides', async () => {
    const orchestrator = await readFile(ORCHESTRATOR, 'utf8');

    expect(orchestrator).toContain(`'${APPROVAL_MARKER}'`);
    expect(orchestrator).toContain(`'${EXPIRE_MARKER}'`);
  });
});

/**
 * The seed and the orchestrator issue the same mission, from the same file. Checked here
 * because the two cannot import each other: one is compiled into the gateway image, the other
 * is a host-side script, and a mission that drifts between them is a demo passing against a
 * scope nobody deployed.
 */
describe('the demo mission document', () => {
  it('is the one file both the seed and the orchestrator read', async () => {
    const relative = 'apps/gateway/prisma/demo-mission.json';
    const [orchestrator, seed, document] = await Promise.all([
      readFile(ORCHESTRATOR, 'utf8'),
      readFile(path.resolve(import.meta.dirname, '../../../apps/gateway/prisma/seed.ts'), 'utf8'),
      readFile(path.resolve(import.meta.dirname, `../../../${relative}`), 'utf8'),
    ]);

    expect(orchestrator).toContain(relative);
    expect(seed).toContain("'demo-mission.json'");

    const mission = JSON.parse(document) as Record<string, unknown>;
    expect(Object.keys(mission).sort()).toEqual([
      'intent',
      'limits',
      'network',
      'notes',
      'permissions',
    ]);
  });
});
