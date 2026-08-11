import type { ReactElement } from 'react';

/**
 * Lifecycle status for missions, credentials and approvals.
 *
 * Deliberately not the same component as `DecisionBadge`: a decision is a judgment about one
 * request, a status is the state of a record. Giving them the same shape would invite reading a
 * green "active" mission as an allowed request.
 */
const TONES: Record<string, string> = {
  active: 'text-allow border-allow-line bg-allow-soft',
  approved: 'text-allow border-allow-line bg-allow-soft',
  pending: 'text-review border-review-line bg-review-soft',
  denied: 'text-deny border-deny-line bg-deny-soft',
  revoked: 'text-deny border-deny-line bg-deny-soft',
  expired: 'text-fault border-fault-line bg-fault-soft',
  consumed: 'text-ink-muted border-line bg-sunken',
};

export function StatusChip({ status }: { status: string }): ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium ${
        TONES[status] ?? 'text-ink-muted border-line bg-sunken'
      }`}
    >
      {status}
    </span>
  );
}
