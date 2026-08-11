'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactElement, type ReactNode } from 'react';

/**
 * Every state-changing control in the console.
 *
 * It posts to a route handler in this app — never to the gateway — because the admin token is
 * server-side and must stay there. The body is `{}` at both hops: the management routes declare
 * a JSON body schema, and a POST that announces JSON while sending nothing is answered with a
 * 400, so "no payload" has to be spelled out rather than omitted.
 */

const TONES = {
  primary: 'bg-ink text-canvas hover:bg-ink/90 border-ink',
  allow: 'bg-allow-soft text-allow border-allow-line hover:bg-allow-soft/70',
  deny: 'bg-deny-soft text-deny border-deny-line hover:bg-deny-soft/70',
  quiet: 'bg-surface text-ink-muted border-line hover:border-line-strong hover:text-ink',
} as const;

export interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
}

export function ActionButton({
  endpoint,
  label,
  pendingLabel,
  tone = 'quiet',
  confirm,
  onDone,
}: {
  endpoint: string;
  label: string;
  pendingLabel?: string;
  tone?: keyof typeof TONES;
  confirm?: Confirmation;
  onDone?: (result: unknown) => void;
}): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const payload: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const reason =
          typeof payload === 'object' && payload !== null && 'reason' in payload
            ? String((payload as { reason: unknown }).reason)
            : `the gateway answered ${response.status}`;
        setError(reason);

        return;
      }

      setAsking(false);
      onDone?.(payload);
      // The optimistic half is the button's own state; the truth comes back from the server on
      // the next render, so nothing on screen can drift from what the gateway actually did.
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setError('this console could not reach its own server');
    } finally {
      setBusy(false);
    }
  }

  const working = busy || pending;

  return (
    <span className="relative inline-flex flex-col items-stretch">
      <button
        type="button"
        disabled={working}
        onClick={() => {
          if (confirm === undefined) {
            void run();
          } else {
            setAsking(true);
          }
        }}
        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${TONES[tone]}`}
      >
        {working ? (pendingLabel ?? 'Working…') : label}
      </button>

      {error === null ? null : (
        <span role="alert" className="text-deny mt-1.5 max-w-56 text-xs leading-snug">
          {error}
        </span>
      )}

      {asking && confirm !== undefined ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={confirm.title}
            className="card w-full max-w-md p-5"
          >
            <h2 className="text-ink text-sm font-semibold">{confirm.title}</h2>
            <div className="text-ink-muted mt-2 text-sm leading-relaxed">{confirm.body}</div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAsking(false)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium ${TONES.quiet}`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() => void run()}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${TONES.deny}`}
              >
                {working ? 'Working…' : confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}
