import { newId } from '@agentgate/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * `ERROR` is not a policy decision, which is why this is not `Decision` from `@agentgate/shared`:
 * it records that the gateway failed to reach one, and it must be distinguishable from a DENY
 * when reading the trail.
 */
export const AUDIT_DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ERROR'] as const;

export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

const optionalText = z.string().nullish();

/**
 * The question the engine was asked, as the pipeline built it (`PolicyInput`). Spelled out here
 * rather than imported from `@agentgate/policy` on purpose: the trail decides for itself what
 * may be written to it, so widening `PolicyInput` cannot widen the audit table by accident.
 *
 * Strict at every level. The mission documents are admin-authored and pass through as stored —
 * they are scope, not content — while `data` is metadata about a body and never a body (D10).
 */
const PolicyInputSnapshotSchema = z.strictObject({
  identity: z.strictObject({
    principalId: z.string(),
    agentId: z.string(),
    agentType: z.string(),
  }),
  mission: z.strictObject({
    id: z.string(),
    intent: z.string(),
    permissions: z.unknown(),
    network: z.unknown(),
    expiresAt: z.string(),
  }),
  resource: z.strictObject({ provider: z.string(), id: z.string() }),
  action: z.strictObject({ type: z.string(), method: z.string() }),
  network: z.strictObject({ host: z.string(), path: z.string() }),
  environment: z.strictObject({ name: z.string() }),
  currentState: z.strictObject({
    requestCount: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  }),
  data: z.strictObject({
    contentType: z.string().optional(),
    bodySize: z.number().int().nonnegative().optional(),
    bodyHash: z.string().optional(),
  }),
});

export type PolicyInputSnapshot = z.infer<typeof PolicyInputSnapshotSchema>;

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
  /**
   * Absent on every attempt that never reached the engine. `null` and "not given" mean the same
   * thing here — there was no question to record.
   */
  policyInputSnapshot: PolicyInputSnapshotSchema.nullish(),
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

/**
 * Walks the whole event, not just its top level.
 *
 * Flat rows made a shallow check sufficient until `policyInputSnapshot` arrived: a nested
 * document is exactly where a header map or a resolved credential would end up if someone
 * widened the snapshot without thinking, and the top-level key would still read innocently.
 */
function assertNoCredentialShapedKey(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoCredentialShapedKey(item, `${path}[${String(index)}]`);
    }

    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const where = path === '' ? key : `${path}.${key}`;

    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Audit events must not carry a "${where}" field: it may hold a credential`);
    }

    assertNoCredentialShapedKey(child, where);
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

      const { policyInputSnapshot, ...parsed } = AuditEventSchema.parse(event);

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
          // Left out rather than set: on a nullable Json column Prisma spells SQL NULL as
          // `Prisma.DbNull` and JSON `null` as `Prisma.JsonNull`, and omitting the field is the
          // one way to get the column default without importing that distinction here.
          ...(policyInputSnapshot === undefined || policyInputSnapshot === null
            ? {}
            : // Asserted, not trusted: the value has just been through the schema above, and
              // Prisma's `InputJsonValue` is a recursive structural type no zod inference lines
              // up with. The guarantee this row needs comes from the parse, not from the cast.
              { policyInputSnapshot: policyInputSnapshot as Prisma.InputJsonValue }),
        },
      });
    },
  };
}
