import { z } from 'zod';
import { registerSensitive } from '../logging.js';

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

/**
 * RFC 9110 `token`: the only characters a header field name may be built from.
 */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** C0 and C1 controls, DEL included. CR and LF are the two that matter, and both are in here. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Long enough for any real header, short enough that neither is a place to store a document. */
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_FORMAT_LENGTH = 512;

/**
 * What the management API accepts when a human writes an injection spec.
 *
 * Stricter than {@link InjectionSpecSchema}, and deliberately so: the stored form has to stay
 * readable for rows that already exist, while the boundary that creates new ones is where a
 * header name of `X-Api-Key: x\r\nAuthorization` has to be refused. Undici throws on such a
 * name at request time — an obscure 500 on a proxied request, hours after the mistake — and
 * a request splitting through the injected header is the interesting version of the same bug.
 * Refused here, it is a 400 on the call that made it, naming the field.
 */
export const InjectionSpecInputSchema = z.strictObject({
  type: z.literal('header'),
  name: z
    .string()
    .min(1)
    .max(MAX_HEADER_NAME_LENGTH)
    .regex(HEADER_NAME, 'injection header name must be a valid HTTP field name'),
  format: z
    .string()
    .min(1)
    .max(MAX_FORMAT_LENGTH)
    .refine((format) => format.includes('{value}'), {
      message: 'injection format must contain the {value} placeholder',
    })
    .refine((format) => !CONTROL_CHARACTER.test(format), {
      message: 'injection format must not contain control characters',
    }),
});

export interface InjectedHeader {
  name: string;
  value: string;
}

/**
 * Builds the header carrying a secret. The only correct way to fill an injection format:
 * with a *string* replacement, `String.prototype.replace` reads `$&`, "$`", `$'`, `$$` and
 * `$1` inside the secret as references to the match and mangles it. A function replacement
 * has no such syntax, so the secret goes through byte for byte.
 */
export function applyInjection(spec: InjectionSpec, value: string): InjectedHeader {
  // The one place a credential becomes something that goes on a wire, so the one place worth
  // registering it with the scrubber: what must never come back is the value itself, not the
  // header it happens to travel in — an upstream reflecting it without the `Bearer ` in front
  // is reflecting it just the same.
  registerSensitive(value);

  return { name: spec.name, value: spec.format.replaceAll('{value}', () => value) };
}
