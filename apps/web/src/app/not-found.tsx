import Link from 'next/link';
import type { ReactElement } from 'react';

export default function NotFound(): ReactElement {
  return (
    <div className="mx-auto max-w-lg py-20">
      <p className="eyebrow">404</p>
      <h1 className="text-ink mt-2 text-2xl font-semibold tracking-[-0.015em]">
        The gateway has no record of this
      </h1>
      <p className="text-ink-muted mt-3 text-sm leading-relaxed">
        Nothing here — the agent, mission or request id does not exist, or belongs to a database
        this console is not pointed at. Identifiers are stable, so a link that worked before still
        works.
      </p>
      <Link
        href="/"
        className="text-accent hover:text-accent-ink mt-6 inline-block text-sm font-medium underline-offset-4 hover:underline"
      >
        Back to the overview →
      </Link>
    </div>
  );
}
