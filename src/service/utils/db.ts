/**
 * Shared Database Connection
 *
 * Single Prisma instance shared across all services to prevent
 * connection pool exhaustion on Cloud Run.
 */

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Single connection pool for entire application
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,  // Total connections for entire app
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

// Export pool for manual queries if needed
export { pool };
