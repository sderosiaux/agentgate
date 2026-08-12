import { expect, test } from 'vitest';
import { applyInjection, InjectionSpecSchema, type InjectionSpec } from '../src/secrets/index.js';

function spec(format: string): InjectionSpec {
  return InjectionSpecSchema.parse({ type: 'header', name: 'Authorization', format });
}

test('the standard bearer format yields the header the upstream expects', () => {
  expect(applyInjection(spec('Bearer {value}'), 'fixture-token')).toEqual({
    name: 'Authorization',
    value: 'Bearer fixture-token',
    secret: 'fixture-token',
  });
});

test('the credential travels next to the header it was wrapped into', () => {
  // Two different strings, and an upstream reflecting the credential picks either one. The
  // forwarder scrubs both out of the response, so both have to be reachable from here — the
  // bare value cannot be recovered from a composed header.
  const injected = applyInjection(spec('Bearer {value}'), 'fixture-token');

  expect(injected.secret).toBe('fixture-token');
  expect(injected.value).toBe('Bearer fixture-token');
});

test('a format without a surrounding template is still substituted', () => {
  expect(applyInjection(spec('{value}'), 'fixture-token').value).toBe('fixture-token');
});

test('dollar patterns in the secret are never interpreted as replacement syntax', () => {
  // `String.prototype.replace` reads `$&`, `$'`, "$`", `$$` and `$1` in a *string*
  // replacement as references to the match. A secret is arbitrary bytes, so the
  // replacement has to be a function or the injected header silently mangles it.
  for (const secret of ['$&', "$'", '$`', '$$', '$1', 'a$&b$$c', '$$$&']) {
    expect(applyInjection(spec('Bearer {value}'), secret)).toEqual({
      name: 'Authorization',
      value: `Bearer ${secret}`,
      secret,
    });
  }
});

test('the injected value is byte-exact, whitespace and unicode included', () => {
  const secret = ' tok en\t🔐$&\n';

  const injected = applyInjection(spec('token {value} end'), secret);

  expect(injected.value).toBe(`token ${secret} end`);
  expect(Buffer.from(injected.value, 'utf8')).toEqual(Buffer.from(`token ${secret} end`, 'utf8'));
});

test('every placeholder in the format is substituted', () => {
  // The schema only demands one `{value}`; leaving a second one literal would ship a
  // header containing the placeholder text.
  expect(applyInjection(spec('{value}:{value}'), 'tok').value).toBe('tok:tok');
});

test('the header name is taken from the spec, untouched', () => {
  const custom = InjectionSpecSchema.parse({
    type: 'header',
    name: 'X-Api-Key',
    format: 'key={value}',
  });

  expect(applyInjection(custom, 'tok')).toEqual({
    name: 'X-Api-Key',
    value: 'key=tok',
    secret: 'tok',
  });
});
