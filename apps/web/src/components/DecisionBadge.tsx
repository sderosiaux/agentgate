import type { ReactElement } from 'react';

/**
 * The one place a decision becomes a colour.
 *
 * Four cases, not three: `ERROR` is what the trail records when the gateway never reached a
 * decision, and showing it as a DENY would claim a judgment that was never made. Anything else
 * arriving here is rendered as itself in the neutral treatment — an unreadable badge is better
 * than a wrong one.
 */

const STYLES: Record<string, string> = {
  ALLOW: 'bg-allow-soft text-allow border-allow-line',
  DENY: 'bg-deny-soft text-deny border-deny-line',
  REQUIRE_APPROVAL: 'bg-review-soft text-review border-review-line',
  ERROR: 'bg-fault-soft text-fault border-fault-line',
};

const NEUTRAL = 'bg-fault-soft text-fault border-fault-line';

const LABELS: Record<string, string> = {
  REQUIRE_APPROVAL: 'REQUIRE APPROVAL',
};

const SIZES = {
  sm: 'text-[0.6875rem] px-2 py-[3px] tracking-[0.07em] gap-1.5',
  lg: 'text-sm px-4 py-2 tracking-[0.12em] gap-2.5',
} as const;

const DOTS = {
  sm: 'size-1.5',
  lg: 'size-2',
} as const;

export interface DecisionBadgeProps {
  decision: string;
  size?: keyof typeof SIZES;
}

export function DecisionBadge({ decision, size = 'sm' }: DecisionBadgeProps): ReactElement {
  const tone = STYLES[decision] ?? NEUTRAL;

  return (
    <span
      data-decision={decision}
      className={`inline-flex items-center rounded-full border font-semibold uppercase ${tone} ${SIZES[size]}`}
    >
      <span aria-hidden="true" className={`rounded-full bg-current ${DOTS[size]}`} />
      {LABELS[decision] ?? decision}
    </span>
  );
}
