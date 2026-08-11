export const DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'] as const;

export type Decision = (typeof DECISIONS)[number];

export interface PolicyDecision {
  decision: Decision;
  reason: string;
  matchedPolicy?: string;
}

export function isDecision(value: unknown): value is Decision {
  return DECISIONS.includes(value as Decision);
}
