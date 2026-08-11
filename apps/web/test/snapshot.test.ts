// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { refusalStage } from '@/lib/snapshot';

/**
 * When a request is refused before any policy runs, the decision view has no context to show and
 * says which stage did the refusing instead. That sentence is the only explanation an operator
 * gets, so it has to come from something the gateway actually stated.
 *
 * It used to be inferred from the refusal prose, which got budget refusals wrong every time: the
 * gateway phrases all three of them as "mission exceeded its ...", and a substring test for
 * "mission" matched before the one for "limit". The flagship screen therefore announced "the
 * mission was missing, expired or revoked — step 2" about a mission that was live and had simply
 * run out of budget at step 3. Exactly the plausible-but-false claim this module promises not to
 * make.
 *
 * So the stage is now read from `matchedPolicy`, which the gateway writes as a machine-readable
 * name, and the prose is consulted only when there is none.
 */

describe('naming the stage that refused', () => {
  it('separates a spent budget from a dead mission', () => {
    // The bug: all three of these carry the word "mission" in their reason.
    const budget = 'mission exceeded its request budget';

    expect(refusalStage(budget, 'mission-limit-max_requests')).toContain('step 3');
    expect(refusalStage('mission exceeded its requests per minute', 'mission-limit-rpm')).toContain(
      'step 3',
    );
    expect(refusalStage('mission exceeded its byte budget', 'mission-limit-max_bytes')).toContain(
      'step 3',
    );
    expect(refusalStage(budget, 'mission-limit-max_requests')).not.toContain('step 2');
  });

  it('names which budget ran out, since they are refilled differently', () => {
    expect(refusalStage('x', 'mission-limit-max_requests')).toContain('request');
    expect(refusalStage('x', 'mission-limit-rpm')).toContain('per minute');
    expect(refusalStage('x', 'mission-limit-max_bytes')).toContain('byte');
  });

  it('reports the mission stage for every way a mission can be unusable', () => {
    for (const policy of [
      'mission-expired',
      'mission-revoked',
      'mission-unknown',
      'mission-status',
      'mission-identity-mismatch',
      'mission-unreadable',
    ]) {
      expect(refusalStage('mission has expired', policy)).toContain('step 2');
    }
  });

  it('distinguishes a malformed request from an authorization refusal', () => {
    for (const policy of [
      'request-invalid-envelope',
      'request-invalid-url',
      'request-body-too-large',
    ]) {
      const stage = refusalStage('proxy request body is not well formed', policy);

      expect(stage).not.toBeNull();
      expect(stage).not.toContain('step 2');
      expect(stage).not.toContain('step 3');
    }
  });

  it('falls back to the prose when the gateway named no stage', () => {
    // The token case: refused before there is a mission to name a policy about.
    expect(refusalStage('Agent token is invalid', null)).toContain('step 1');
    expect(refusalStage('Agent token is missing', null)).toContain('step 1');
  });

  it('claims nothing at all when neither source says anything it recognises', () => {
    expect(refusalStage('something nobody has seen before', null)).toBeNull();
    expect(refusalStage('something nobody has seen before', 'a-policy-from-the-future')).toBeNull();
  });
});
