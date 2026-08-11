import type { PrismaClient } from '../db.js';
import { registerSensitive } from '../logging.js';
import { assertMasterKey, decryptSecret } from './crypto.js';
import { InjectionSpecSchema, type InjectionSpec } from './injection.js';

/** Everything about a credential except the secret: safe to log, serialise and audit. */
export interface CredentialDescriptor {
  alias: string;
  provider: string;
  logicalHost: string;
  upstreamBaseUrl: string;
  injection: InjectionSpec;
}

export interface ResolvedCredential extends CredentialDescriptor {
  /**
   * The decrypted secret. Non-enumerable on purpose, so `JSON.stringify`, `util.inspect`,
   * `console.log` and object spreads all leave it out. Read it explicitly or not at all.
   */
  readonly value: string;
  toJSON(): CredentialDescriptor;
}

/**
 * The seam every secret backend implements. Only `createDbSecretStore` exists today;
 * Vault, AWS Secrets Manager, GSM and 1Password would slot in behind this interface.
 */
export interface SecretStore {
  getByAlias(alias: string): Promise<ResolvedCredential | null>;
}

/**
 * `Credential.injection` is a Json column: nothing in the database enforces its shape, so a
 * hand-edited or drifted row surfaces here. The alias is safe to log — it is what agents
 * already hold — and it is the only thing that makes the failure diagnosable.
 */
function parseInjection(alias: string, injection: unknown): InjectionSpec {
  const parsed = InjectionSpecSchema.safeParse(injection);

  if (!parsed.success) {
    throw new Error(`Credential "${alias}" has a malformed injection spec stored in the database`, {
      cause: parsed.error,
    });
  }

  return parsed.data;
}

function resolveCredential(descriptor: CredentialDescriptor, value: string): ResolvedCredential {
  const credential = { ...descriptor } as ResolvedCredential;

  Object.defineProperty(credential, 'value', { value, enumerable: false });
  Object.defineProperty(credential, 'toJSON', {
    value: (): CredentialDescriptor => ({ ...descriptor }),
    enumerable: false,
  });

  return credential;
}

export function createDbSecretStore(prisma: PrismaClient, masterKeyB64: string): SecretStore {
  // Fail at wiring time rather than on the first proxied request.
  assertMasterKey(masterKeyB64);

  return {
    async getByAlias(alias: string): Promise<ResolvedCredential | null> {
      const row = await prisma.credential.findUnique({ where: { alias } });

      // A revoked credential is as good as an unknown one: the caller gets no value and no
      // way to tell the two apart.
      if (!row || row.status !== 'active') {
        return null;
      }

      const descriptor: CredentialDescriptor = {
        alias: row.alias,
        provider: row.provider,
        logicalHost: row.logicalHost,
        upstreamBaseUrl: row.upstreamBaseUrl,
        injection: parseInjection(row.alias, row.injection),
      };

      const value = decryptSecret(masterKeyB64, Buffer.from(row.ciphertext));

      // From here on the plaintext exists in this process, so the log scrubber has to know it
      // before any code holding it gets a chance to log something.
      registerSensitive(value);

      return resolveCredential(descriptor, value);
    },
  };
}
