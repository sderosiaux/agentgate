/**
 * Reading the policy input a decision was made from.
 *
 * The snapshot is stored as JSON and served back as `unknown`. It is also the most load-bearing
 * thing this console displays — it is the evidence behind a judgment — so it is read without
 * assuming a shape: known slices come out in the order the authorization formula names them, and
 * anything unrecognised is surfaced rather than dropped. A decision view that quietly hides a
 * field it did not expect is worse than no decision view.
 */

export interface Slice {
  /** The term of the formula, e.g. `MISSION`. */
  term: string;
  /** What this term contributes to the judgment, in one line. */
  note: string;
  /** The slice as stored, or null when the snapshot carried nothing under this key. */
  value: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The seven terms of `MISSION + IDENTITY + RESOURCE + ACTION + DATA + ENVIRONMENT + CURRENT STATE`. */
const TERMS: { key: string; term: string; note: string }[] = [
  {
    key: 'mission',
    term: 'Mission',
    note: 'The delegated authority in force: what was granted, to whom, until when.',
  },
  {
    key: 'identity',
    term: 'Identity',
    note: 'Which agent asked, and the principal it acts for. Not the human who launched it.',
  },
  {
    key: 'resource',
    term: 'Resource',
    note: 'What the gateway parsed the request as touching — never what the agent claimed.',
  },
  {
    key: 'action',
    term: 'Action',
    note: 'The operation the route maps to. An unmapped route is denied outright.',
  },
  {
    key: 'data',
    term: 'Data',
    note: 'Metadata about the body only: type, size, hash. The body itself is never read here.',
  },
  {
    key: 'environment',
    term: 'Environment',
    note: 'Where this is running. The same action can be allowed in one and denied in another.',
  },
  {
    key: 'currentState',
    term: 'Current state',
    note: 'What the mission has already spent. A budget that is out ends the request.',
  },
];

/** The destination, kept beside the resource: it is matched separately from the action. */
export const NETWORK_TERM = {
  key: 'network',
  term: 'Destination',
  note: 'Host and path, matched against the mission network rules on the logical host.',
};

export interface ReadSnapshot {
  slices: Slice[];
  network: Slice;
  /** Keys the snapshot carried that this console has no term for. Shown raw rather than dropped. */
  unknownKeys: string[];
}

export function readSnapshot(value: unknown): ReadSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const slices = TERMS.map((term) => ({
    term: term.term,
    note: term.note,
    value: isRecord(value[term.key]) ? (value[term.key] as Record<string, unknown>) : null,
  }));

  const known = new Set([...TERMS.map((term) => term.key), NETWORK_TERM.key]);

  return {
    slices,
    network: {
      term: NETWORK_TERM.term,
      note: NETWORK_TERM.note,
      value: isRecord(value[NETWORK_TERM.key])
        ? (value[NETWORK_TERM.key] as Record<string, unknown>)
        : null,
    },
    unknownKeys: Object.keys(value).filter((key) => !known.has(key)),
  };
}

/**
 * Which step of the decision order ended the request, when no policy was ever consulted.
 *
 * Derived from the reason the gateway recorded, and deliberately conservative: an unrecognised
 * reason produces no claim at all rather than a plausible-looking guess about a refusal.
 */
export function refusalStage(reason: string): string | null {
  const text = reason.toLowerCase();

  if (text.includes('token')) {
    return 'The agent token was missing, malformed or expired — step 1 of the decision order.';
  }
  if (text.includes('mission')) {
    return 'The mission was missing, expired or revoked — step 2 of the decision order.';
  }
  if (text.includes('limit') || text.includes('budget') || text.includes('exceeded')) {
    return 'The mission had spent its budget — step 3 of the decision order.';
  }
  if (text.includes('credential') || text.includes('alias')) {
    return 'The credential alias could not be resolved, so there was nothing to inject.';
  }

  return null;
}
