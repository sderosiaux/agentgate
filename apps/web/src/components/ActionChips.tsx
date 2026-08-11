import type { ReactElement } from 'react';

/**
 * One of the three action groups on a mission.
 *
 * They are shown as separate groups rather than one list with icons because they are not three
 * flavours of the same thing: allowed goes through, approval stops and waits for a human, denied
 * never goes through even when the credential could. Precedence runs denied → approval → allowed
 * (D3), which is why they are printed in that order.
 */
const TONES = {
  allow: {
    chip: 'bg-allow-soft text-allow border-allow-line',
    rule: 'bg-allow',
  },
  review: {
    chip: 'bg-review-soft text-review border-review-line',
    rule: 'bg-review',
  },
  deny: {
    chip: 'bg-deny-soft text-deny border-deny-line',
    rule: 'bg-deny',
  },
} as const;

export function ActionChips({
  label,
  note,
  actions,
  tone,
}: {
  label: string;
  note: string;
  actions: string[];
  tone: keyof typeof TONES;
}): ReactElement {
  const styles = TONES[tone];

  return (
    <div>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`h-3 w-[3px] rounded-full ${styles.rule}`} />
        <span className="eyebrow">{label}</span>
      </div>
      <p className="text-ink-faint mt-1 text-xs leading-snug">{note}</p>
      {actions.length === 0 ? (
        <p className="text-ink-faint mt-2.5 text-xs italic">none</p>
      ) : (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {actions.map((action) => (
            <li
              key={action}
              className={`ident rounded border px-2 py-1 text-[0.75rem] ${styles.chip}`}
            >
              {action}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
