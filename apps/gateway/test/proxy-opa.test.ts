import { createOpaEngine } from '@agentgate/policy';
import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

const opaUrl = process.env['OPA_URL'];

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * The wiring, not the semantics: `packages/policy` already proves the two engines agree on the
 * decision matrix. What is unproven until here is that `POLICY_ENGINE=opa` produces a gateway
 * that enforces at all. Skipped unless an OPA is actually reachable.
 */
test.skipIf(opaUrl === undefined || opaUrl === '')(
  'a gateway wired to OPA allows and denies the same requests as the builtin one',
  async () => {
    harness = await startHarness({
      engine: createOpaEngine(opaUrl ?? ''),
      // Wide enough that only the mission scope — which is OPA's job here — can refuse.
      network: {
        allow: [{ host: 'api.github.com', path: '/repos/acme/**', methods: ['GET'] }],
        deny: [],
      },
    });
    const token = await harness.mint();

    const allowed = await harness.proxy(
      {
        credential: harness.alias,
        method: 'GET',
        url: 'https://api.github.com/repos/acme/payments',
      },
      token,
    );
    const denied = await harness.proxy(
      {
        credential: harness.alias,
        method: 'GET',
        url: 'https://api.github.com/repos/acme/secret-project',
      },
      token,
    );

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
  },
);
