import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionBadge } from '@/components/DecisionBadge';

describe('DecisionBadge', () => {
  it('gives each decision its own colour', () => {
    render(
      <>
        <DecisionBadge decision="ALLOW" />
        <DecisionBadge decision="DENY" />
        <DecisionBadge decision="REQUIRE_APPROVAL" />
        <DecisionBadge decision="ERROR" />
      </>,
    );

    const classesFor = (decision: string): string =>
      document.querySelector(`[data-decision="${decision}"]`)?.className ?? '';

    expect(classesFor('ALLOW')).toContain('text-allow');
    expect(classesFor('DENY')).toContain('text-deny');
    expect(classesFor('REQUIRE_APPROVAL')).toContain('text-review');
    expect(classesFor('ERROR')).toContain('text-fault');

    // Four decisions, four distinct treatments: an ERROR shown in the DENY colour would claim a
    // judgment the gateway never made.
    const tones = new Set(
      ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ERROR'].map((decision) => classesFor(decision)),
    );
    expect(tones.size).toBe(4);
  });

  it('spells REQUIRE_APPROVAL as words', () => {
    render(<DecisionBadge decision="REQUIRE_APPROVAL" />);

    expect(screen.getByText('REQUIRE APPROVAL')).toBeTruthy();
  });

  it('renders a decision it does not know rather than nothing', () => {
    render(<DecisionBadge decision="SOMETHING_NEW" />);

    const badge = screen.getByText('SOMETHING_NEW');
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('text-fault');
  });

  it('has a large variant for the verdict at the end of a decision view', () => {
    const { container } = render(<DecisionBadge decision="ALLOW" size="lg" />);

    expect(container.firstElementChild?.className).toContain('text-sm');
  });
});
