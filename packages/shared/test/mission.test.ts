import { expect, test } from 'vitest';
import {
  MissionLimitsSchema,
  MissionPermissionsSchema,
  NetworkRulesSchema,
} from '../src/mission.js';

// Copied verbatim from the demo mission seeded in apps/gateway/prisma/seed.ts.
// If the seed and these schemas ever drift apart, this fixture stops parsing.
const seededPermissions = {
  resources: ['github:acme/payments'],
  allowedActions: [
    'repo.read',
    'issue.read',
    'pull_request.read',
    'branch.create',
    'pull_request.create',
  ],
  approvalActions: ['pull_request.create'],
  deniedActions: ['pull_request.merge', 'repository.delete'],
};

const seededNetwork = {
  allow: [
    { host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET'] },
    { host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] },
  ],
  deny: [],
};

const seededLimits = { maxRequests: 500, maxBytes: 50_000_000, requestsPerMinute: 60 };

test('the seeded demo mission documents parse unchanged', () => {
  expect(MissionPermissionsSchema.parse(seededPermissions)).toEqual(seededPermissions);
  expect(NetworkRulesSchema.parse(seededNetwork)).toEqual(seededNetwork);
  expect(MissionLimitsSchema.parse(seededLimits)).toEqual(seededLimits);
});

test('permissions reject unknown keys', () => {
  expect(() =>
    MissionPermissionsSchema.parse({ ...seededPermissions, allowed_actions: ['repo.read'] }),
  ).toThrow();
});

test('permissions require every action list, as arrays of strings', () => {
  expect(() =>
    MissionPermissionsSchema.parse({ ...seededPermissions, deniedActions: 'pull_request.merge' }),
  ).toThrow();
  expect(() => MissionPermissionsSchema.parse({ ...seededPermissions, resources: [42] })).toThrow();

  const { approvalActions: _omitted, ...withoutApproval } = seededPermissions;
  expect(() => MissionPermissionsSchema.parse(withoutApproval)).toThrow();
});

test('network rules reject an empty host', () => {
  expect(() => NetworkRulesSchema.parse({ allow: [{ host: '' }], deny: [] })).toThrow();
});

test('network rules keep path and methods optional but reject unknown keys', () => {
  expect(NetworkRulesSchema.parse({ allow: [{ host: 'api.github.com' }], deny: [] })).toEqual({
    allow: [{ host: 'api.github.com' }],
    deny: [],
  });
  expect(() =>
    NetworkRulesSchema.parse({ allow: [{ host: 'api.github.com', port: 443 }], deny: [] }),
  ).toThrow();
});

test('network rules only accept uppercase http verbs', () => {
  expect(() =>
    NetworkRulesSchema.parse({
      allow: [{ host: 'api.github.com', methods: ['get'] }],
      deny: [],
    }),
  ).toThrow();
  expect(() =>
    NetworkRulesSchema.parse({
      allow: [{ host: 'api.github.com', methods: ['FETCH'] }],
      deny: [],
    }),
  ).toThrow();
  expect(
    NetworkRulesSchema.parse({
      allow: [{ host: 'api.github.com', methods: ['GET', 'HEAD', 'OPTIONS'] }],
      deny: [{ host: 'api.github.com', methods: ['PUT', 'PATCH', 'DELETE'] }],
    }),
  ).toEqual({
    allow: [{ host: 'api.github.com', methods: ['GET', 'HEAD', 'OPTIONS'] }],
    deny: [{ host: 'api.github.com', methods: ['PUT', 'PATCH', 'DELETE'] }],
  });
});

test('network rules require both lists to be arrays', () => {
  expect(() => NetworkRulesSchema.parse({ allow: {}, deny: [] })).toThrow();
  expect(() => NetworkRulesSchema.parse({ allow: [] })).toThrow();
});

test('limits reject zero, negative and fractional values', () => {
  for (const invalid of [
    { ...seededLimits, maxRequests: 0 },
    { ...seededLimits, maxBytes: -1 },
    { ...seededLimits, requestsPerMinute: 1.5 },
  ]) {
    expect(() => MissionLimitsSchema.parse(invalid)).toThrow();
  }
});

test('limits reject unknown keys and non-numbers', () => {
  expect(() => MissionLimitsSchema.parse({ ...seededLimits, maxSeconds: 60 })).toThrow();
  expect(() => MissionLimitsSchema.parse({ ...seededLimits, maxRequests: '500' })).toThrow();
});
