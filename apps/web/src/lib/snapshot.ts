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

/**
 * Which key the request asked for, by name. A scalar rather than a slice, so it gets its own
 * field instead of a card: there is nothing to unfold, and an alias shown as a one-line object
 * would read as if the console were hiding the rest of it.
 */
export const CREDENTIAL_TERM = {
  key: 'credentialAlias',
  term: 'Credential',
  note: 'The alias named by the request. The mission has to list it; the value is resolved after this decision.',
};

export interface ReadSnapshot {
  slices: Slice[];
  network: Slice;
  /** Null on a snapshot written before the alias was part of the question. */
  credentialAlias: string | null;
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

  const alias: unknown = value[CREDENTIAL_TERM.key];

  const known = new Set([...TERMS.map((term) => term.key), NETWORK_TERM.key, CREDENTIAL_TERM.key]);

  return {
    slices,
    credentialAlias: typeof alias === 'string' ? alias : null,
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
 * Read from `matchedPolicy`, which the gateway writes as a machine-readable stage name, rather
 * than inferred from the refusal prose. Prose inference got budget refusals wrong every time:
 * the gateway phrases all three as "mission exceeded its ...", so a test for "mission" fired
 * before the one for "limit" and the screen announced a dead mission about a live one that had
 * merely run out of requests. This function's whole job is to avoid claims like that.
 */
const STAGES: Record<string, string> = {
  'mission-limit-max_requests':
    'The mission had spent its request budget — step 3 of the decision order.',
  'mission-limit-rpm':
    'The mission had used its allowance of requests per minute — step 3 of the decision order. This one refills on its own.',
  'mission-limit-max_bytes':
    'The mission had spent its byte budget — step 3 of the decision order.',
  'mission-expired': 'The mission had passed its deadline — step 2 of the decision order.',
  'mission-revoked': 'The mission had been revoked — step 2 of the decision order.',
  'mission-unknown':
    'The token named a mission that does not exist — step 2 of the decision order.',
  'mission-status': 'The mission was not active — step 2 of the decision order.',
  'mission-identity-mismatch':
    'The token identity did not match the mission it named — step 2 of the decision order.',
  'mission-unreadable':
    'The mission scope could not be read, so nothing could be evaluated against it — step 2 of the decision order.',
  'request-invalid-envelope':
    'The request envelope was malformed, so the gateway never learned what was being asked.',
  'request-invalid-url':
    'The target URL could not be parsed, so there was no host or path to match a rule against.',
  'request-body-too-large':
    'The body was larger than the gateway will read. The attempt still counts against the mission budget.',
};

/**
 * The one refusal that happens before there is a mission to name a policy about, so the gateway
 * records no stage for it and the prose is all there is.
 */
function fromProse(reason: string): string | null {
  return reason.toLowerCase().includes('token')
    ? 'The agent token was missing, malformed or expired — step 1 of the decision order.'
    : null;
}

export function refusalStage(reason: string, matchedPolicy: string | null): string | null {
  if (matchedPolicy !== null) {
    // No fallback to prose when a policy was named: a stage this console does not recognise is a
    // gateway newer than it, and guessing from the wording is how the old bug happened.
    return STAGES[matchedPolicy] ?? null;
  }

  return fromProse(reason);
}
