/**
 * Reading the three mission documents without trusting them.
 *
 * `permissions`, `network` and `limits` are JSON columns holding what an operator submitted. The
 * management API validates them on the way in and reads them back through `z.unknown()` on the
 * way out, precisely so one drifted row cannot break the list that would let you find it. This
 * console takes the same position: pull out what is recognisable, report what is not, and never
 * throw on a document's shape.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export interface Permissions {
  resources: string[];
  allowedActions: string[];
  approvalActions: string[];
  deniedActions: string[];
  /** The credential aliases this mission may spend. Empty means it may spend none. */
  allowedCredentials: string[];
  /** False when the column held something this console could not read as a permissions document. */
  readable: boolean;
}

export function readPermissions(value: unknown): Permissions {
  if (!isRecord(value)) {
    return {
      resources: [],
      allowedActions: [],
      approvalActions: [],
      deniedActions: [],
      allowedCredentials: [],
      readable: false,
    };
  }

  return {
    resources: strings(value.resources),
    allowedActions: strings(value.allowedActions),
    approvalActions: strings(value.approvalActions),
    deniedActions: strings(value.deniedActions),
    allowedCredentials: strings(value.allowedCredentials),
    readable: true,
  };
}

export interface NetworkRule {
  host: string;
  path: string | null;
  methods: string[] | null;
}

export interface NetworkRules {
  allow: NetworkRule[];
  deny: NetworkRule[];
  readable: boolean;
}

function rules(value: unknown): NetworkRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((rule) => ({
    host: typeof rule.host === 'string' ? rule.host : '(no host)',
    path: typeof rule.path === 'string' ? rule.path : null,
    methods: Array.isArray(rule.methods) ? strings(rule.methods) : null,
  }));
}

export function readNetwork(value: unknown): NetworkRules {
  if (!isRecord(value)) {
    return { allow: [], deny: [], readable: false };
  }

  return { allow: rules(value.allow), deny: rules(value.deny), readable: true };
}

export interface Limits {
  maxRequests: number | null;
  maxBytes: number | null;
  requestsPerMinute: number | null;
  readable: boolean;
}

export function readLimits(value: unknown): Limits {
  if (!isRecord(value)) {
    return { maxRequests: null, maxBytes: null, requestsPerMinute: null, readable: false };
  }

  return {
    maxRequests: positive(value.maxRequests),
    maxBytes: positive(value.maxBytes),
    requestsPerMinute: positive(value.requestsPerMinute),
    readable: true,
  };
}
