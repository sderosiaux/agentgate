import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/audit',
  useRouter: () => ({ refresh: vi.fn() }),
}));

const api = { audit: vi.fn(), agents: vi.fn(), principals: vi.fn(), missions: vi.fn() };

vi.mock('@/lib/api', () => ({
  api,
  describeError: (error: unknown) => String(error),
  GatewayError: class GatewayError extends Error {},
}));

const { default: AuditPage } = await import('@/app/audit/page');

async function visit(query: Record<string, string | string[]>): Promise<void> {
  render(await AuditPage({ searchParams: Promise.resolve(query) }));
}

function auditCall(): Record<string, unknown> {
  return (api.audit.mock.calls[0] as [Record<string, unknown>])[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  api.audit.mockResolvedValue({ items: [], nextCursor: null });
  api.agents.mockResolvedValue([]);
  api.principals.mockResolvedValue([]);
  api.missions.mockResolvedValue([]);
});

describe('what the audit page forwards to the management API', () => {
  it('passes the filters it owns', async () => {
    await visit({ agentId: 'agt_1', decision: 'DENY', resource: 'github:acme/payments' });

    expect(auditCall()).toMatchObject({
      agentId: 'agt_1',
      decision: 'DENY',
      resource: 'github:acme/payments',
    });
  });

  it('drops a parameter it does not own', async () => {
    // The management API rejects unknown query parameters outright, so forwarding whatever was
    // in the URL meant one stray parameter in a shared link broke the whole page with a 400.
    await visit({ agentId: 'agt_1', utm_source: 'newsletter', foo: 'bar' });

    const forwarded = auditCall();
    expect(forwarded).not.toHaveProperty('utm_source');
    expect(forwarded).not.toHaveProperty('foo');
    expect(forwarded).toMatchObject({ agentId: 'agt_1' });
  });

  it('takes one value when a parameter is repeated, never a joined string', async () => {
    // `?decision=ALLOW&decision=DENY` used to be stringified into "ALLOW,DENY", which is not a
    // decision the gateway has ever heard of.
    await visit({ decision: ['ALLOW', 'DENY'] });

    expect(auditCall().decision).toBe('ALLOW');
  });

  it('leaves an empty filter out entirely rather than sending a blank', async () => {
    await visit({ agentId: '', decision: 'ALLOW' });

    expect(auditCall().agentId).toBeUndefined();
  });

  it('completes a local datetime as UTC, which is the only form the API accepts', async () => {
    await visit({ from: '2026-08-11T09:15' });

    expect(auditCall().from).toBe('2026-08-11T09:15:00Z');
  });

  it('passes an already-complete instant through untouched', async () => {
    await visit({ to: '2026-08-11T09:15:00+02:00' });

    expect(auditCall().to).toBe('2026-08-11T09:15:00+02:00');
  });
});
