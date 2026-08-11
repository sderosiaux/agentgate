import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POISONED_CREDENTIALS, SECRET_IN_FIXTURE } from './fixtures';

vi.mock('next/navigation', () => ({
  usePathname: () => '/credentials',
  useRouter: () => ({ refresh: vi.fn() }),
}));

const api = { credentials: vi.fn() };

vi.mock('@/lib/api', () => ({
  api,
  describeError: (error: unknown) => String(error),
  GatewayError: class GatewayError extends Error {},
}));

const { default: CredentialsPage } = await import('@/app/credentials/page');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the credentials page', () => {
  it('renders the alias and where it points', async () => {
    api.credentials.mockResolvedValue(POISONED_CREDENTIALS);

    render(await CredentialsPage());

    expect(screen.getByText('github_work')).toBeTruthy();
    expect(screen.getByText('api.github.com')).toBeTruthy();
    expect(screen.getByText('header: Authorization')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('renders nothing of a credential value, even when the API sends one', async () => {
    // The fixture is poisoned: it carries `value` and `ciphertext`, which the real API never
    // returns. If either reaches the DOM, some component is rendering the credential object
    // rather than the fields it chose — and this test is the only thing that would catch it.
    api.credentials.mockResolvedValue(POISONED_CREDENTIALS);

    const { container } = render(await CredentialsPage());

    expect(container.textContent).not.toContain(SECRET_IN_FIXTURE);
    expect(container.textContent).not.toContain('ciphertext');
    expect(container.innerHTML).not.toContain(SECRET_IN_FIXTURE);
  });

  it('says what a credential is and how to add one when there are none', async () => {
    api.credentials.mockResolvedValue([]);

    render(await CredentialsPage());

    expect(screen.getByText('No credential has been registered')).toBeTruthy();
    expect(screen.getByText(/write-only/)).toBeTruthy();
  });
});
