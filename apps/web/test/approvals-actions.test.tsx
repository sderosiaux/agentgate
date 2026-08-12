import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_APPROVAL } from './fixtures';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/approvals',
}));

const api = {
  approvals: vi.fn(),
  missions: vi.fn(),
  agents: vi.fn(),
  principals: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  api,
  describeError: (error: unknown) => String(error),
  GatewayError: class GatewayError extends Error {},
}));

const { default: ApprovalsPage } = await import('@/app/approvals/page');

/** The pending queue as the page receives it, with just enough context to render a card. */
function seed(): void {
  api.approvals.mockResolvedValue({ items: [PENDING_APPROVAL], nextCursor: null });
  api.missions.mockResolvedValue([
    {
      id: 'mis_payments_423',
      intent: 'Investigate issue #423 and open a pull request',
      agentId: 'agt_codex_01',
      principalId: 'pri_stephane',
      status: 'active',
      label: 'development',
      permissions: {},
      network: {},
      limits: {},
      expiresAt: '2026-08-11T10:00:00.000Z',
      createdAt: '2026-08-11T09:00:00.000Z',
    },
  ]);
  api.agents.mockResolvedValue([
    {
      id: 'agt_codex_01',
      principalId: 'pri_stephane',
      agentType: 'codex',
      createdAt: '2026-08-11T08:00:00.000Z',
    },
  ]);
  api.principals.mockResolvedValue([{ id: 'pri_stephane', name: 'Stéphane' }]);
}

async function renderQueue(): Promise<void> {
  render(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...PENDING_APPROVAL, status: 'approved' }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the approvals queue', () => {
  it('shows what a human needs to decide', async () => {
    await renderQueue();

    expect(screen.getByText('pull_request.create')).toBeTruthy();
    expect(screen.getByText('Creating a pull request requires human approval.')).toBeTruthy();
    expect(screen.getByText(/api\.github\.com/)).toBeTruthy();
    expect(screen.getByText('Investigate issue #423 and open a pull request')).toBeTruthy();
  });

  it('approves through this app, with a body the management API accepts', async () => {
    await renderQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`/api/approvals/${PENDING_APPROVAL.id}/approve`);
    expect(init.method).toBe('POST');
    // Not decoration: these routes declare a JSON body, and announcing JSON while sending
    // nothing is answered with 400.
    expect(init.body).toBe('{}');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('denies through the deny endpoint, not the approve one', async () => {
    await renderQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/approvals/${PENDING_APPROVAL.id}/deny`);
    expect(init.body).toBe('{}');
  });

  it('re-reads the server once the gateway has answered', async () => {
    await renderQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }));

    // The button's own state is the optimistic half; the truth comes from a fresh server render.
    expect(refresh).toHaveBeenCalled();
  });

  it('never posts to the gateway from the browser', async () => {
    await renderQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('/api/')).toBe(true);
    expect(url).not.toContain('/api/v1/');
  });

  it('shows the gateway’s refusal instead of pretending it worked', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'agentgate_validation_error', reason: 'approval is denied' }),
    });
    await renderQueue();

    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('approval is denied')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
