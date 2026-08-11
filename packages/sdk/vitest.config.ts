import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// The SDK is tested against a real gateway started in-process, and that gateway needs the
// database. Same instance as every other suite, reached from the host: `DATABASE_URL_TEST`.
const databaseUrl = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    ...(databaseUrl ? { env: { DATABASE_URL: databaseUrl } } : {}),
  },
});
