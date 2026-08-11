import type { ReactElement, ReactNode } from 'react';

/**
 * An empty console is the first thing most people see, so every empty state here says what the
 * screen would hold and what produces it — never "no data".
 */
export function EmptyState({
  title,
  children,
  hint,
}: {
  title: string;
  children: ReactNode;
  hint?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-start gap-3 px-6 py-12 sm:px-10">
      <div aria-hidden="true" className="border-line-strong h-px w-10 border-t border-dashed" />
      <h3 className="text-ink text-[0.9375rem] font-semibold">{title}</h3>
      <div className="text-ink-muted max-w-prose text-sm leading-relaxed">{children}</div>
      {hint === undefined ? null : (
        <div className="bg-sunken border-line text-ink-muted ident mt-1 rounded-md border px-3 py-2 text-xs">
          {hint}
        </div>
      )}
    </div>
  );
}
