#!/usr/bin/env node
// Generates a .env with fresh secrets: an AES-256-GCM master key and an Ed25519
// keypair for the agent JWTs. The values committed in .env.example are dev-only —
// every real deployment must run this script.
//
// Usage: node scripts/generate-env.mjs [outputPath]

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, '.env.example');
const outputPath = path.resolve(process.argv[2] ?? path.join(repoRoot, '.env'));

function generateSecrets() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  return {
    AGENTGATE_MASTER_KEY: randomBytes(32).toString('base64'),
    AGENTGATE_JWT_PRIVATE_KEY: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
    AGENTGATE_JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    // Guards the management API, which is what turns a REQUIRE_APPROVAL into a request that
    // goes through: shipping the committed dev value would be shipping an open approve button.
    ADMIN_TOKEN: randomBytes(32).toString('base64url'),
  };
}

function applySecrets(template, secrets) {
  return Object.entries(secrets).reduce(
    (content, [key, value]) => content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`),
    template,
  );
}

if (!existsSync(templatePath)) {
  console.error(`Missing template: ${templatePath}`);
  process.exit(1);
}

const secrets = generateSecrets();
const content = applySecrets(readFileSync(templatePath, 'utf8'), secrets);

for (const key of Object.keys(secrets)) {
  if (!content.includes(`${key}=${secrets[key]}`)) {
    console.error(`Template has no ${key} entry to replace`);
    process.exit(1);
  }
}

writeFileSync(outputPath, content, { mode: 0o600 });
console.log(`Wrote ${outputPath} with a fresh master key and JWT keypair.`);
