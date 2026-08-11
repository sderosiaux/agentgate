import { expect, test } from 'vitest';
import { newId } from '../src/ids.js';

test('an id carries its prefix and 20 hex characters', () => {
  expect(newId('mis')).toMatch(/^mis_[0-9a-f]{20}$/);
});

test('every prefix is preserved verbatim', () => {
  const prefixes = ['pri', 'agt', 'mis', 'cred', 'apr', 'aud', 'req', 'ses'] as const;

  for (const prefix of prefixes) {
    expect(newId(prefix).startsWith(`${prefix}_`)).toBe(true);
  }
});

test('ids are unique and stable in length over 1000 draws', () => {
  const ids = Array.from({ length: 1000 }, () => newId('req'));

  expect(new Set(ids).size).toBe(1000);
  expect(new Set(ids.map((id) => id.length))).toEqual(new Set([24]));
});
