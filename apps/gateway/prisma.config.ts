import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// The monorepo keeps a single .env at the repo root; the Prisma CLI runs from apps/gateway.
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// `prisma generate` needs no connection, so the datasource is only declared when a
// URL is configured. Commands that do need one (migrate, db seed) fail loudly without it.
const databaseUrl = process.env['DATABASE_URL'];

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
