import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import { assertMasterKey, decryptSecret } from './crypto.js';

// How a resolved credential is put on the wire by the enforcement path. `format` is a
// template: the gateway substitutes `{value}` with the decrypted secret at injection time.
export const InjectionSpecSchema = z.strictObject({
  type: z.literal('header'),
  name: z.string().min(1),
  format: z.string().refine((format) => format.includes('{value}'), {
    message: 'injection format must contain the {value} placeholder',
  }),
});

export type InjectionSpec = z.infer<typeof InjectionSpecSchema>;

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
        injection: InjectionSpecSchema.parse(row.injection),
      };

      return resolveCredential(
        descriptor,
        decryptSecret(masterKeyB64, Buffer.from(row.ciphertext)),
      );
    },
  };
}
