import type { ReactElement } from 'react';

/**
 * A mission's budget, spent and remaining. CSS only — a chart library for two rectangles is a
 * dependency nobody can justify.
 *
 * The bar turns amber past 75% and red past 90%: a limit is a thing that ends a mission's
 * ability to work, so approaching one is a state an operator should see without reading digits.
 */
export function UsageBar({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number;
  format: (value: number) => string;
}): ReactElement {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const percent = Math.round(ratio * 100);
  const tone = ratio >= 0.9 ? 'bg-deny' : ratio >= 0.75 ? 'bg-review' : 'bg-accent';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="eyebrow">{label}</span>
        <span className="ident text-ink-muted">
          <span className="text-ink font-medium">{format(used)}</span>
          {' / '}
          {limit > 0 ? format(limit) : 'no limit'}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-sunken border-line mt-2 h-2 overflow-hidden rounded-full border"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-ink-faint mt-1.5 text-xs">
        {percent}% used
        {limit > 0 ? ` · ${format(Math.max(limit - used, 0))} left` : null}
      </p>
    </div>
  );
}
