import type { ReactElement } from 'react';

/**
 * One number, with the thing it counts and a word on how to read it.
 *
 * `tone` paints only the top rule and the value — the tiles that carry a decision colour are the
 * ones where the colour is the meaning (allowed, denied, waiting), never decoration.
 */
const TONES = {
  neutral: { rule: 'bg-line-strong', value: 'text-ink' },
  allow: { rule: 'bg-allow', value: 'text-allow' },
  deny: { rule: 'bg-deny', value: 'text-deny' },
  review: { rule: 'bg-review', value: 'text-review' },
} as const;

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  delay = 0,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: keyof typeof TONES;
  delay?: number;
}): ReactElement {
  const styles = TONES[tone];

  return (
    <div className="card rise overflow-hidden" style={{ animationDelay: `${delay}ms` }}>
      <div className={`h-[3px] w-full ${styles.rule}`} />
      <div className="px-4 py-3.5">
        <p className="eyebrow">{label}</p>
        <p
          className={`mt-2 text-[2rem] leading-none font-semibold tracking-[-0.03em] ${styles.value}`}
        >
          {value}
        </p>
        <p className="text-ink-faint mt-2 text-xs leading-snug">{hint}</p>
      </div>
    </div>
  );
}
