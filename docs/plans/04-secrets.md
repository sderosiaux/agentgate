# Sub-plan 04 — Secret store

**Goal:** Credential encryption at rest (AES-256-GCM) behind a `SecretStore` interface, wired into the seed. Gateway refuses to boot without a valid master key.

**Depends on:** 01, 02. Parallelizable with 03, 05.

## Files

- Create: `apps/gateway/src/secrets/{crypto.ts, store.ts, index.ts}`, tests
- Modify: `apps/gateway/prisma/seed.ts` — encrypt `MOCK_GITHUB_TOKEN` for real (replaces plan-01 placeholder)
- Modify: `apps/gateway/src/index.ts` — boot guard on `AGENTGATE_MASTER_KEY`

## Key interfaces (binding)

```typescript
// crypto.ts — isolated, no Prisma import
export function encryptSecret(masterKeyB64: string, plaintext: string): Buffer; // iv(12) || tag(16) || ciphertext
export function decryptSecret(masterKeyB64: string, blob: Buffer): string;      // throws on tamper/wrong key
export function assertMasterKey(masterKeyB64: string | undefined): void;        // throws unless base64 32 bytes

// store.ts — the seam for future backends (Vault, ASM, GSM, 1Password). Only Db impl now.
export interface InjectionSpec { type: "header"; name: string; format: string } // format contains "{value}"
export interface ResolvedCredential {
  alias: string; provider: string; logicalHost: string; upstreamBaseUrl: string;
  injection: InjectionSpec;
  value: string; // NEVER logged, NEVER serialized — see toJSON guard below
}
export interface SecretStore {
  getByAlias(alias: string): Promise<ResolvedCredential | null>;
}
export function createDbSecretStore(prisma: PrismaClient, masterKeyB64: string): SecretStore;
```

Anti-leak guard: `ResolvedCredential` is constructed with `value` as a non-enumerable property plus `toJSON()` returning the object without `value`. `JSON.stringify(cred)` and `console.log(cred)` must not show the secret (tested).

## Tests (write first)

crypto: roundtrip; distinct IV per call (two encrypts of same plaintext differ); wrong key → throw; flipped ciphertext byte → throw; `assertMasterKey` rejects short/invalid base64.
store (against test Postgres): `getByAlias("github_work")` returns decrypted value + injection spec; unknown alias → null; `JSON.stringify(resolved)` lacks the secret; `util.inspect(resolved)` lacks the secret.
boot: building the gateway app without `AGENTGATE_MASTER_KEY` throws before listening.

## Tasks

- [ ] 1. `crypto.ts` TDD. Commit.
- [ ] 2. `SecretStore` + `createDbSecretStore` TDD (uses seeded credential). Commit.
- [ ] 3. Seed rewire: encrypt real demo token; test seed → store roundtrip. Commit.
- [ ] 4. Boot guard + non-enumerable/`toJSON` leak tests. Commit.

## Exit criteria

`pnpm -r test` green; grep for `super-secret` in `apps/` and `packages/` source → zero hits (value only lives in env/compose).
