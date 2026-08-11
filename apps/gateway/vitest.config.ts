import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// Tests run on the host, the gateway runs inside compose: the database is the same
// instance reached through a different hostname.
const databaseUrl = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    ...(databaseUrl ? { env: { DATABASE_URL: databaseUrl } } : {}),
  },
});
