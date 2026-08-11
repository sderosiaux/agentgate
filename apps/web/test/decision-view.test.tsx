import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_WITH_SNAPSHOT, DECISION_WITHOUT_SNAPSHOT } from './fixtures';

vi.mock('next/navigation', () => ({
  usePathname: () => '/decisions',
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error('notFound');
  },
}));

const api = { decision: vi.fn() };

vi.mock('@/lib/api', () => ({
  api,
  describeError: (error: unknown) => String(error),
  GatewayError: class GatewayError extends Error {},
}));

const { default: DecisionPage } = await import('@/app/decisions/[requestId]/page');

async function renderDecision(requestId: string): Promise<HTMLElement> {
  const { container } = render(await DecisionPage({ params: Promise.resolve({ requestId }) }));

  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the runtime decision view', () => {
  it('lays out the authorization formula, term by term', async () => {
    api.decision.mockResolvedValue(DECISION_WITH_SNAPSHOT);

    const container = await renderDecision(DECISION_WITH_SNAPSHOT.requestId);

    for (const term of [
      'Mission',
      'Identity',
      'Resource',
      'Action',
      'Data',
      'Environment',
      'Current state',
    ]) {
      expect(screen.getByRole('heading', { name: term })).toBeTruthy();
    }

    // The destination is its own card: it is matched against the network rules separately from
    // the action.
    expect(screen.getByRole('heading', { name: 'Destination' })).toBeTruthy();
    expect(container.textContent).toContain('/repos/acme/payments/pulls');
  });

  it('shows the values the engine actually saw', async () => {
    api.decision.mockResolvedValue(DECISION_WITH_SNAPSHOT);

    const container = await renderDecision(DECISION_WITH_SNAPSHOT.requestId);

    expect(container.textContent).toContain('agt_codex_01');
    expect(container.textContent).toContain('pull_request.create');
    expect(container.textContent).toContain('development');
    // currentState, straight out of the snapshot rather than recomputed here.
    expect(container.textContent).toContain('42');
  });

  it('ends on the matched policy, its reason and the verdict', async () => {
    api.decision.mockResolvedValue(DECISION_WITH_SNAPSHOT);

    await renderDecision(DECISION_WITH_SNAPSHOT.requestId);

    expect(screen.getByRole('heading', { name: 'Policy decision' })).toBeTruthy();
    expect(screen.getByText('github-pr-approval')).toBeTruthy();
    expect(
      screen.getAllByText('Creating a pull request requires human approval.').length,
    ).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-decision="REQUIRE_APPROVAL"]').length).toBe(2);
  });

  it('carries the request metadata, including the approval it produced', async () => {
    api.decision.mockResolvedValue(DECISION_WITH_SNAPSHOT);

    const container = await renderDecision(DECISION_WITH_SNAPSHOT.requestId);

    expect(container.textContent).toContain('37 ms');
    expect(container.textContent).toContain('202');
    expect(screen.getByText('apr_000000000000000000001')).toBeTruthy();
  });

  it('says which stage refused when there is no snapshot at all', async () => {
    api.decision.mockResolvedValue(DECISION_WITHOUT_SNAPSHOT);

    const container = await renderDecision(DECISION_WITHOUT_SNAPSHOT.requestId);

    expect(screen.getByRole('heading', { name: 'No policy was reached' })).toBeTruthy();
    expect(container.textContent).toContain('step 1 of the decision order');
    expect(container.textContent).toContain('Agent token is invalid');

    // No empty context cards pretending the engine was consulted.
    expect(screen.queryByRole('heading', { name: 'Current state' })).toBeNull();
    // The verdict is still shown: the request was decided, just not by a policy.
    expect(document.querySelectorAll('[data-decision="DENY"]').length).toBe(2);
  });

  it('surfaces a snapshot term it has no card for instead of dropping it', async () => {
    api.decision.mockResolvedValue({
      ...DECISION_WITH_SNAPSHOT,
      policyInputSnapshot: {
        ...(DECISION_WITH_SNAPSHOT.policyInputSnapshot as Record<string, unknown>),
        futureTerm: { somethingNew: true },
      },
    });

    const container = await renderDecision(DECISION_WITH_SNAPSHOT.requestId);

    expect(container.textContent).toContain('futureTerm');
    expect(container.textContent).toContain('somethingNew');
  });
});
