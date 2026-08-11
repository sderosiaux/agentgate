# Sub-plan 02 — Shared types + Agent tokens

**Goal:** `packages/shared` (IDs, errors, zod schemas for mission documents, decision types) and `packages/auth` (Ed25519 JWT mint/verify binding agent ↔ mission).

**Depends on:** 01.

## Files

- Create: `packages/shared/src/{ids.ts, errors.ts, decision.ts, mission.ts, index.ts}`, `package.json`, tests
- Create: `packages/auth/src/{token.ts, index.ts}`, `package.json`, tests

## Key interfaces (binding)

```typescript
// shared/src/ids.ts — prefixed ids: pri_ agt_ mis_ cred_ apr_ aud_ req_ ses_
export function newId(
  prefix: 'pri' | 'agt' | 'mis' | 'cred' | 'apr' | 'aud' | 'req' | 'ses',
): string; // `${prefix}_${crypto.randomUUID() sans dashes, 20 chars}`

// shared/src/decision.ts
export type Decision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
export interface PolicyDecision {
  decision: Decision;
  reason: string;
  matchedPolicy?: string;
}

// shared/src/errors.ts — machine-readable, SPEC "API" section
export class AgentGateError extends Error {
  constructor(
    public code:
      | 'agentgate_access_denied'
      | 'agentgate_approval_required'
      | 'agentgate_invalid_token'
      | 'agentgate_mission_expired'
      | 'agentgate_limit_exceeded'
      | 'agentgate_unknown_credential'
      | 'agentgate_unmapped_action'
      | 'agentgate_upstream_error'
      | 'agentgate_validation_error'
      | 'agentgate_not_found',
    public httpStatus: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toBody(requestId: string): object; // {error, decision?, reason, request_id}
}

// shared/src/mission.ts — zod schemas validating the Json columns
export const MissionPermissionsSchema: z.ZodType<{
  resources: string[]; // "github:acme/payments"
  allowedActions: string[]; // "repo.read"
  approvalActions: string[];
  deniedActions: string[];
}>;
export const NetworkRulesSchema: z.ZodType<{
  allow: Array<{ host: string; path?: string; methods?: string[] }>;
  deny: Array<{ host: string; path?: string; methods?: string[] }>;
}>;
export const MissionLimitsSchema: z.ZodType<{
  maxRequests: number;
  maxBytes: number;
  requestsPerMinute: number;
}>;

// auth/src/token.ts
export interface AgentClaims {
  agentId: string;
  principalId: string;
  agentType: string;
  missionId: string;
  sessionId: string;
}
export interface TokenService {
  mint(claims: AgentClaims, expiresAt: Date): Promise<string>;
  verify(token: string): Promise<AgentClaims>; // throws AgentGateError("agentgate_invalid_token")
}
export function createTokenService(
  privateKeyB64: string | undefined,
  publicKeyB64: string,
): TokenService;
// jose, alg EdDSA. mint requires private key; verify only needs public key.
```

## Tests (write first)

shared: id prefix/uniqueness/length; `MissionPermissionsSchema` rejects unknown keys and non-array; `AgentGateError.toBody` shape matches SPEC example; NetworkRules rejects empty host.
auth: mint→verify roundtrip returns claims; expired token (mint with past date) → `agentgate_invalid_token`; tampered payload → reject; token signed by a different key → reject; `verify` never returns without checking `exp`.

## Tasks

- [ ] 1. `packages/shared` package boilerplate + ids (TDD). Commit.
- [ ] 2. errors + decision types (TDD on `toBody`). Commit.
- [ ] 3. mission zod schemas (TDD, include a fixture matching seed mission from plan 01 — must parse). Commit.
- [ ] 4. `packages/auth` token service (TDD, jose, Ed25519 keys generated in-test via `jose.generateKeyPair`). Commit.
- [ ] 5. Wire gateway placeholder to import `@agentgate/shared` (compile check only). Commit.

## Exit criteria

`pnpm -r test` green; gateway builds against both packages; no runtime code depends on Prisma here (pure packages).
