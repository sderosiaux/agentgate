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
