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
    label: z.string(),
    expiresAt: z.string(),
  }),
  resource: z.strictObject({ provider: z.string(), id: z.string() }),
  action: z.strictObject({ type: z.string(), method: z.string() }),
  /** The alias, which is a name an operator chose. Never the value behind it — see below. */
  credentialAlias: z.string().optional(),
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
 *
 * WARNING — read before adding a field anywhere a snapshot can reach.
 *
 * Every alternative but `body` is an unanchored substring match, and that is deliberate:
 * `authorizationHeader` and `refreshToken` have to be caught, and anchoring each one would be a
 * list of exact spellings that the next well-meaning name walks straight past. The `^body$`
 * anchor is the proof it was a choice — `bodySize` and `bodyHash` are metadata this trail wants,
 * so that one alternative is pinned and the rest are not.
 *
 * The cost is real and worth stating plainly. A field called `maxTokens`, `limitValues` or
 * `tokenizer` — anywhere in the event, at any depth, including inside the mission scope an
 * administrator authored — makes `record` throw. `record` is awaited in the pipeline's `finally`
 * and its failure is not swallowed, so that is not a logging hiccup: it is every proxied request
 * answering 500 until the name is changed.
 *
 * That is the intended failure direction. An unaudited request is one this gateway is not
 * willing to have served, and a false positive is a name somebody can rename in a minute, while
 * a false negative is a credential in an append-only table forever. Widen the pattern only by
 * making it more specific — never by dropping an alternative to unblock a build.
 */
const FORBIDDEN_KEY = /authorization|credential|secret|password|cookie|token|value|^body$/i;

/**
 * The exemptions, by exact name, and there are two.
 *
 * An alias is not a credential. `credentialAlias` is the key the request named and
 * `allowedCredentials` is the list the mission was issued (D2); both hold nothing but the
 * strings an operator typed into the management API, which returns them in plaintext already.
 * Neither can hold the value behind the alias: the secret store is not read until after the
 * policy snapshot is built, and the two fields are validated as a string and as an array of
 * strings before they get here.
 *
 * A set of exact names rather than a hole in the pattern above, on purpose. The pattern is what
 * catches the field nobody thought about, so it stays as broad as it was; this is a list of
 * names somebody did think about, and adding to it is an edit a reviewer can read in full.
 * `credentials`, `credentialValue` and `allowedCredential` are not on it and still throw.
 */
const CREDENTIAL_NAMING_KEYS = new Set(['credentialAlias', 'allowedCredentials']);

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

    if (!CREDENTIAL_NAMING_KEYS.has(key) && FORBIDDEN_KEY.test(key)) {
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
