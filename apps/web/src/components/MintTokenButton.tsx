'use client';

import { useState, type ReactElement } from 'react';
import { ActionButton } from './ActionButton';

interface Minted {
  sessionId?: unknown;
  expiresAt?: unknown;
}

/**
 * Mint an agent token for a mission — and show everything about it except the token.
 *
 * The value never leaves the server (`api.mintToken` drops it), so what a human gets here is the
 * session the token belongs to and the instant it dies. That is the whole useful part: the token
 * itself belongs in the agent's environment, delivered by the SDK, not in a browser tab.
 */
export function MintTokenButton({ missionId }: { missionId: string }): ReactElement {
  const [minted, setMinted] = useState<Minted | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-2">
      <ActionButton
        endpoint={`/api/missions/${encodeURIComponent(missionId)}/tokens`}
        label="Mint agent token"
        pendingLabel="Minting…"
        onDone={(result) => setMinted(result as Minted)}
      />
      {minted === null ? null : (
        <span className="bg-sunken border-line rounded-md border px-3 py-2 text-right text-xs">
          <span className="text-ink block font-medium">Session opened</span>
          <span className="ident text-ink-muted block">{String(minted.sessionId ?? '—')}</span>
          <span className="text-ink-faint block">
            expires {String(minted.expiresAt ?? '—')} · the token went to the agent, not to this
            page
          </span>
        </span>
      )}
    </span>
  );
}
