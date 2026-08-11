import { z } from 'zod';

// The Mission table stores these three documents as Json columns: they are the only
// place where mission scope lives, so they are validated on the way in and on the way out.

export const MissionPermissionsSchema = z.strictObject({
  resources: z.array(z.string()),
  allowedActions: z.array(z.string()),
  approvalActions: z.array(z.string()),
  deniedActions: z.array(z.string()),
});

const NetworkRuleSchema = z.strictObject({
  host: z.string().min(1),
  path: z.string().optional(),
  methods: z.array(z.string()).optional(),
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

export type MissionPermissions = z.infer<typeof MissionPermissionsSchema>;
export type NetworkRules = z.infer<typeof NetworkRulesSchema>;
export type MissionLimits = z.infer<typeof MissionLimitsSchema>;
