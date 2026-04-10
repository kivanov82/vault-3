/**
 * Backfill 4h and 1d candles for whitelist + BTC over the Jan 1 - Mar 15 window.
 *
 * Usage: npx tsx scripts/ml/backfill-higher-tf-candles.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import * as hl from '@nktkas/hyperliquid';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START_MS = new Date('2026-01-01T00:00:00Z').getTime();
const END_MS = new Date('2026-03-15T00:00:00Z').getTime();

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE', 'VVV', 'MON', 'FARTCOIN'];
const TIMEFRAMES: ('4h' | '1d')[] = ['4h', '1d'];

async function fetchAndStore(symbol: string, timeframe: '4h' | '1d') {
  const transport = new hl.HttpTransport({ timeout: 30000 });
  const info = new hl.InfoClient({ transport });

  const candles = await info.candleSnapshot({
    coin: symbol,
    interval: timeframe,
    startTime: START_MS,
    endTime: END_MS,
  });

  if (!candles || candles.length === 0) {
    console.log(`  ${symbol} ${timeframe}: no data`);
    return 0;
  }

  let inserted = 0;
  let updated = 0;
  for (const c of candles) {
    try {
      await prisma.candle.upsert({
        where: {
          symbol_timeframe_timestamp: {
            symbol,
            timeframe,
            timestamp: new Date(Number(c.t)),
          },
        },
        create: {
          symbol,
          timeframe,
          timestamp: new Date(Number(c.t)),
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v),
        },
        update: {
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v),
        },
      });
      inserted++;
    } catch (e: any) {
      console.error(`  ${symbol} ${timeframe} @ ${c.t}: ${e.message}`);
    }
  }

  console.log(`  ${symbol.padEnd(10)} ${timeframe}  ${inserted} candles`);
  return inserted;
}

async function main() {
  console.log(`\n🔄 Backfilling higher-TF candles ${new Date(START_MS).toISOString().slice(0,10)} → ${new Date(END_MS).toISOString().slice(0,10)}\n`);

  let total = 0;
  for (const tf of TIMEFRAMES) {
    console.log(`--- ${tf} ---`);
    for (const sym of SYMBOLS) {
      total += await fetchAndStore(sym, tf);
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log();
  }

  console.log(`\n✅ Stored ${total} higher-TF candles`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
