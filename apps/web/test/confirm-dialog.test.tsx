import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionButton } from '@/components/ActionButton';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/missions/mis_1',
}));

/**
 * The confirmation dialog guards the only irreversible action in this console. It announced
 * `aria-modal` while leaving focus on the trigger behind the scrim, ignoring Escape, and letting
 * Tab walk out of it — which for anyone not using a mouse meant confirming, or failing to
 * cancel, blind.
 */

const CONFIRM = {
  title: 'Expire this mission?',
  body: 'Every request the agent makes from now on is denied.',
  confirmLabel: 'Expire it',
};

function renderButton(): void {
  render(
    <ActionButton endpoint="/api/missions/mis_1/expire" label="Expire mission" confirm={CONFIRM} />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the confirmation dialog', () => {
  it('does nothing until it is confirmed', async () => {
    renderButton();

    await userEvent.click(screen.getByRole('button', { name: 'Expire mission' }));

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts focus on Cancel, not on the destructive choice', async () => {
    renderButton();

    await userEvent.click(screen.getByRole('button', { name: 'Expire mission' }));

    // Never one stray Enter away from an irreversible action.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    renderButton();
    const trigger = screen.getByRole('button', { name: 'Expire mission' });

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab inside the dialog', async () => {
    renderButton();

    await userEvent.click(screen.getByRole('button', { name: 'Expire mission' }));
    const dialog = screen.getByRole('alertdialog');

    // Three tabs used to land behind the scrim, on controls the scrim claims to have disabled.
    for (let press = 0; press < 4; press += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('wraps backwards too', async () => {
    renderButton();

    await userEvent.click(screen.getByRole('button', { name: 'Expire mission' }));
    const dialog = screen.getByRole('alertdialog');

    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('cancels back to the trigger', async () => {
    renderButton();
    const trigger = screen.getByRole('button', { name: 'Expire mission' });

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('posts only once confirmed, with the body the management API requires', async () => {
    renderButton();

    await userEvent.click(screen.getByRole('button', { name: 'Expire mission' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expire it' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/missions/mis_1/expire');
    expect(init.body).toBe('{}');
  });
});
