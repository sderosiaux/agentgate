import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function createPrismaClient(connectionString = process.env['DATABASE_URL']): PrismaClient {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export { PrismaClient };
