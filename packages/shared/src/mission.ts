import { z } from 'zod';

// The Mission table stores these three documents as Json columns: they are the only
// place where mission scope lives, so they are validated on the way in and on the way out.

export const MissionPermissionsSchema = z.strictObject({
  resources: z.array(z.string()),
  allowedActions: z.array(z.string()),
  approvalActions: z.array(z.string()),
  deniedActions: z.array(z.string()),
  /**
   * The credential aliases this mission may spend, by name (D2).
   *
   * Without it the alias in a proxy envelope was an agent's free choice: every alias in the
   * store was selectable by every mission, and the only thing standing between a read-only
   * mission and a production admin key was that the two happened to name different hosts.
   *
   * Required, and required for a reason. A mission document written before this field existed
   * fails to parse, and an unparseable mission grants nothing — which is the answer that keeps
   * the hole shut. `allowedCredentials: []` is the same "nothing", said deliberately.
   */
  allowedCredentials: z.array(z.string()),
});

// Methods are stored and compared uppercase, the casing HTTP itself uses on the wire, so
// the gateway can match `request.method` directly. A typo is rejected here rather than
// silently widening or narrowing a mission's network scope.
const HttpMethodSchema = z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

const NetworkRuleSchema = z.strictObject({
  host: z.string().min(1),
  path: z.string().optional(),
  methods: z.array(HttpMethodSchema).optional(),
});

export const NetworkRulesSchema = z.strictObject({
  allow: z.array(NetworkRuleSchema),
  deny: z.array(NetworkRuleSchema),
});

const positiveInt = z.number().int().positive();

export const MissionLimitsSchema = z.strictObject({
  maxRequests: positiveInt,
  maxBytes: positiveInt,
  requestsPerMinute: positiveInt,
});

export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type MissionPermissions = z.infer<typeof MissionPermissionsSchema>;
export type NetworkRules = z.infer<typeof NetworkRulesSchema>;
export type MissionLimits = z.infer<typeof MissionLimitsSchema>;
