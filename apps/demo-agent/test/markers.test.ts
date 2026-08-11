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
