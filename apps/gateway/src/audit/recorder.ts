import { newId } from '@agentgate/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';

/**
 * `ERROR` is not a policy decision, which is why this is not `Decision` from `@agentgate/shared`:
 * it records that the gateway failed to reach one, and it must be distinguishable from a DENY
 * when reading the trail.
 */
export const AUDIT_DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ERROR'] as const;

export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

const optionalText = z.string().nullish();

/**
 * One row of the trail, and the exhaustive list of what may be written to it. Strict on
 * purpose: a field this schema does not name cannot reach the database, so widening the trail
 * is a deliberate edit here rather than a caller quietly passing something extra.
 */
const AuditEventSchema = z.strictObject({
  requestId: z.string().min(1),
  decision: z.enum(AUDIT_DECISIONS),
  reason: z.string(),
  latencyMs: z.number().int().nonnegative(),
  principalId: optionalText,
  agentId: optionalText,
  missionId: optionalText,
  resource: optionalText,
  action: optionalText,
  method: optionalText,
  destHost: optionalText,
  destPath: optionalText,
  matchedPolicy: optionalText,
  approvalId: optionalText,
  httpStatus: z.number().int().nullish(),
  // D10: request metadata only. The body itself is never stored, and never logged.
  bodySize: z.number().int().nonnegative().nullish(),
  bodyHash: optionalText,
  contentType: optionalText,
});

export type AuditEventInput = z.input<typeof AuditEventSchema>;

export interface AuditRecorder {
  record(event: AuditEventInput): Promise<void>;
}

/**
 * Names that carry credential material by convention. The schema above already refuses
 * anything it does not name, but a future field called `authorizationHeader` would have to
 * pass here too: the trail is append-only, so a secret written into it cannot be taken back.
 */
const FORBIDDEN_KEY = /authorization|credential|secret|password|cookie|token|value|^body$/i;

function assertNoCredentialShapedKey(event: object): void {
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Audit events must not carry a "${key}" field: it may hold a credential`);
    }
  }
}

/**
 * Writes the audit trail, and nothing else. Deliberately unaware of missions, policies and
 * decisions — it takes a finished row (SPEC architecture rule: audit code independent from
 * policy code), so no rule can ever be evaluated differently because of how it is logged.
 */
export function createAuditRecorder(prisma: PrismaClient): AuditRecorder {
  return {
    async record(event: AuditEventInput): Promise<void> {
      assertNoCredentialShapedKey(event);

      const parsed = AuditEventSchema.parse(event);

      await prisma.auditEvent.create({
        data: {
          id: newId('aud'),
          ...parsed,
          // `null` rather than absent: an unknown identity is a fact about the attempt, and a
          // row that simply omits it reads like one that was never given the chance.
          principalId: parsed.principalId ?? null,
          agentId: parsed.agentId ?? null,
          missionId: parsed.missionId ?? null,
          resource: parsed.resource ?? null,
          action: parsed.action ?? null,
          method: parsed.method ?? null,
          destHost: parsed.destHost ?? null,
          destPath: parsed.destPath ?? null,
          matchedPolicy: parsed.matchedPolicy ?? null,
          approvalId: parsed.approvalId ?? null,
          httpStatus: parsed.httpStatus ?? null,
          bodySize: parsed.bodySize ?? null,
          bodyHash: parsed.bodyHash ?? null,
          contentType: parsed.contentType ?? null,
        },
      });
    },
  };
}
