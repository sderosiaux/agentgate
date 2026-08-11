import type { ReactElement, ReactNode } from 'react';

/** The console's container. One hairline, one radius, no shadow stack. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section className={`card overflow-hidden ${className ?? ''}`}>
      {title === undefined ? null : (
        <header className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-ink text-sm font-semibold">{title}</h2>
            {description === undefined ? null : (
              <p className="text-ink-muted mt-1 text-xs leading-relaxed">{description}</p>
            )}
          </div>
          {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A label/value pair. The console is mostly these. */
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`text-ink mt-1 text-sm break-words ${mono ? 'ident' : ''}`}>{children}</dd>
    </div>
  );
}

/** The page title block, identical on every screen so navigation feels like one surface. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow === undefined ? null : <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h1 className="text-ink text-2xl leading-tight font-semibold tracking-[-0.015em]">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="text-ink-muted mt-2 max-w-2xl text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * What a page shows when the gateway refused or could not be reached. Deliberately not a thrown
 * error: "the console is up, the gateway is not" is the single most useful thing an operator can
 * be told, and an error boundary would hide which of the two failed.
 */
export function ErrorPanel({ title, detail }: { title: string; detail: string }): ReactElement {
  return (
    <div className="border-deny-line bg-deny-soft rounded-card border px-5 py-4">
      <h2 className="text-deny text-sm font-semibold">{title}</h2>
      <p className="text-ink mt-1.5 font-mono text-xs leading-relaxed break-words">{detail}</p>
    </div>
  );
}
