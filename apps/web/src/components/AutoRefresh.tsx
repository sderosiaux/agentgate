'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactElement } from 'react';

/**
 * Keeps a server-rendered page live without moving any data fetching into the browser.
 *
 * `router.refresh()` re-runs the server component, which is the only place the admin token
 * exists — so the console polls the gateway without the browser ever holding a credential or
 * even knowing the gateway's address. Polling stops while the tab is hidden: a dashboard left
 * open on a second monitor should not be a load generator.
 */
export function AutoRefresh({ intervalMs = 5_000 }: { intervalMs?: number }): ReactElement {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    function onVisibility(): void {
      const visible = document.visibilityState === 'visible';
      setLive(visible);
      if (visible) {
        router.refresh();
      }
    }

    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    }, intervalMs);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [router, intervalMs]);

  return (
    <span className="text-ink-faint inline-flex items-center gap-2 text-xs">
      <span className="relative flex size-2">
        {live ? (
          <span className="bg-allow absolute inline-flex size-2 animate-ping rounded-full opacity-60" />
        ) : null}
        <span
          className={`relative inline-flex size-2 rounded-full ${live ? 'bg-allow' : 'bg-ink-faint'}`}
        />
      </span>
      {live ? `live · every ${Math.round(intervalMs / 1000)}s` : 'paused'}
    </span>
  );
}
