import { newId } from '@agentgate/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerSensitive } from '../logging.js';
import { encryptSecret, InjectionSpecInputSchema } from '../secrets/index.js';
import { conflict, errorResponses, MAX_NAME_LENGTH } from './common.js';
import type { ManagementDeps } from './deps.js';

export const CREDENTIAL_STATUSES = ['active', 'revoked'] as const;

/** Long enough for any provider token or private key, short enough to bound a request body. */
const MAX_SECRET_LENGTH = 8_192;

/**
 * The shortest string this API will accept as a credential value.
 *
 * Not a security control, and nothing downstream depends on it: a credential value is kept out
 * of logs by the forwarder's per-request denylist, whatever its length. This is a data-quality
 * check at the boundary where a human types.
 *
 * The question it answers is "did a real upstream issue this?", and the answer for anything
 * under a dozen characters is almost always no. Provider tokens do not come that short — a
 * GitHub PAT is 40 characters, an AWS secret key is 40, a Stripe key is more. A four-character
 * value is a typo, a `TODO`, or a placeholder somebody meant to replace, and refusing it here
 * puts the error on the call that made the mistake instead of surfacing it as an unexplained
 * 401 from an upstream three steps later.
 *
 * Deliberately not `MIN_SENSITIVE_LENGTH`, which happens to sit nearby and answers a different
 * question — how short a string can be before scrubbing it out of every log line would redact
 * ordinary English. Tying the two together would imply that keeping a credential out of the
 * logs depends on this validation. It does not, and it must not start to.
 *
 * The cost, stated because it is real: an upstream that issues a genuinely short key cannot be
 * registered through this API, and there is no override. Nobody has hit that. If somebody does,
 * this constant is the one line to move.
 */
const MIN_SECRET_LENGTH = 12;

const AliasSchema = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'alias may hold letters, digits, dashes and underscores');

/**
 * Where the gateway actually sends the request. Restricted to http(s) because that is what the
 * forwarder speaks, and a `file:` or `gopher:` base url is a way to point the credential at
 * something that is not a web service at all.
 */
const UpstreamBaseUrlSchema = z
  .url()
  .max(MAX_NAME_LENGTH * 2)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'upstreamBaseUrl must be an http or https url',
  });

/**
 * What a credential looks like from outside. There is no `value` field, on any response, at any
 * level — the plaintext exists in this process for exactly as long as it takes to encrypt it,
 * and the only code that ever reads it back is the forwarder, through `SecretStore`.
 */
const CredentialSchema = z.object({
  id: z.string().describe('cred_xxx'),
  alias: z.string().describe('What an agent names in a proxy request'),
  provider: z.string(),
  logicalHost: z.string().describe('The one host this credential may be used against (D2)'),
  upstreamBaseUrl: z.string(),
  injection: z.object({ type: z.string(), name: z.string(), format: z.string() }),
  status: z.string().describe(CREDENTIAL_STATUSES.join(' | ')),
});

/**
 * The list is thinner still: type and name of the injection, no format. A format is a template
 * an operator wrote, and a list is the thing left open on a screen.
 */
const CredentialListItemSchema = CredentialSchema.omit({ injection: true }).extend({
  injection: z.object({ type: z.string(), name: z.string() }),
});

const CreateCredentialSchema = z.strictObject({
  alias: AliasSchema,
  provider: z.string().min(1).max(MAX_NAME_LENGTH),
  logicalHost: z.string().min(1).max(MAX_NAME_LENGTH),
  upstreamBaseUrl: UpstreamBaseUrlSchema,
  injection: InjectionSpecInputSchema,
  value: z
    .string()
    .min(MIN_SECRET_LENGTH)
    .max(MAX_SECRET_LENGTH)
    .describe('Write-only. Never read back.'),
});

/** A stored injection spec, read back defensively: the column is Json and may have drifted. */
const StoredInjectionSchema = z
  .object({ type: z.string(), name: z.string(), format: z.string() })
  .catch({ type: 'unknown', name: 'unknown', format: '' });

export function createCredentialRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.post(
      '/credentials',
      {
        schema: {
          tags: ['credentials'],
          summary: 'Store a credential. The value is encrypted and never returned.',
          body: CreateCredentialSchema,
          response: { 201: CredentialSchema, ...errorResponses(400, 401, 409) },
        },
      },
      async (request, reply) => {
        const { value, ...descriptor } = request.body;

        // Before anything else can log a request body: from here the plaintext is in this
        // process, and the scrubber has to know it whichever line it turns up in.
        registerSensitive(value);

        const existing = await deps.prisma.credential.findUnique({
          where: { alias: descriptor.alias },
          select: { alias: true },
        });
        if (existing !== null) {
          // Not an upsert. Silently replacing the secret behind an alias an agent is already
          // using is the kind of write that is only ever noticed by the request it breaks.
          throw conflict(`credential ${descriptor.alias} already exists`);
        }

        const credential = await deps.prisma.credential.create({
          data: {
            id: newId('cred'),
            ...descriptor,
            ciphertext: encryptSecret(deps.masterKey, value),
            status: 'active',
          },
          // Explicit: the ciphertext is not selected, so no later edit to this handler can
          // return it by widening the response schema.
          select: {
            id: true,
            alias: true,
            provider: true,
            logicalHost: true,
            upstreamBaseUrl: true,
            injection: true,
            status: true,
          },
        });

        return reply
          .code(201)
          .send({ ...credential, injection: StoredInjectionSchema.parse(credential.injection) });
      },
    );

    app.get(
      '/credentials',
      {
        schema: {
          tags: ['credentials'],
          summary: 'List credentials, without their values',
          response: {
            200: z.object({ credentials: z.array(CredentialListItemSchema) }),
            ...errorResponses(401),
          },
        },
      },
      async () => {
        const rows = await deps.prisma.credential.findMany({
          orderBy: { alias: 'asc' },
          select: {
            id: true,
            alias: true,
            provider: true,
            logicalHost: true,
            upstreamBaseUrl: true,
            injection: true,
            status: true,
          },
        });

        return {
          credentials: rows.map((row) => {
            const injection = StoredInjectionSchema.parse(row.injection);

            return { ...row, injection: { type: injection.type, name: injection.name } };
          }),
        };
      },
    );
  };
}
