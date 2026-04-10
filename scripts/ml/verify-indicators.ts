/**
 * Spot-check backfilled indicators against live-computed values for a few timestamps.
 * Verifies the series offsets are correct.
 */
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { calculateAllIndicators } from '../../src/service/utils/indicators';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkPoint(symbol: string, targetTs: Date) {
  // Fetch candles from same lookback anchor the backfill used (Jan 1 minus 210h)
  // so EMA warmup matches.
  const lookbackStart = new Date(new Date('2026-01-01T00:00:00Z').getTime() - 210 * 60 * 60 * 1000);
  const candles = await prisma.candle.findMany({
    where: {
      symbol,
      timeframe: '1h',
      timestamp: { gte: lookbackStart, lte: targetTs },
    },
    orderBy: { timestamp: 'asc' },
  });

  if (candles.length === 0) {
    console.log(`  ${symbol} @ ${targetTs.toISOString()}: no candles`);
    return;
  }

  // Compute from scratch using the same lib call the live system uses
  const computed = calculateAllIndicators(candles as any);

  // Fetch stored indicator
  const stored = await prisma.technicalIndicator.findUnique({
    where: {
      symbol_timeframe_timestamp: { symbol, timeframe: '1h', timestamp: targetTs },
    },
  });

  if (!stored) {
    console.log(`  ${symbol} @ ${targetTs.toISOString()}: no stored indicator`);
    return;
  }

  const fmt = (n: number | null) => (n === null ? 'null' : n.toFixed(4));
  const match = (a: number | null, b: number | null) => {
    if (a === null && b === null) return '✓';
    if (a === null || b === null) return '✗';
    return Math.abs(a - b) < 0.0001 * Math.abs(a || 1) ? '✓' : '✗';
  };

  console.log(`\n  ${symbol} @ ${targetTs.toISOString()}`);
  console.log(`    rsi14:     stored=${fmt(stored.rsi14)}  computed=${fmt(computed.rsi14)}  ${match(stored.rsi14, computed.rsi14)}`);
  console.log(`    macdHist:  stored=${fmt(stored.macdHist)}  computed=${fmt(computed.macdHist)}  ${match(stored.macdHist, computed.macdHist)}`);
  console.log(`    bbUpper:   stored=${fmt(stored.bbUpper)}  computed=${fmt(computed.bbUpper)}  ${match(stored.bbUpper, computed.bbUpper)}`);
  console.log(`    bbLower:   stored=${fmt(stored.bbLower)}  computed=${fmt(computed.bbLower)}  ${match(stored.bbLower, computed.bbLower)}`);
  console.log(`    ema9:      stored=${fmt(stored.ema9)}  computed=${fmt(computed.ema9)}  ${match(stored.ema9, computed.ema9)}`);
  console.log(`    ema21:     stored=${fmt(stored.ema21)}  computed=${fmt(computed.ema21)}  ${match(stored.ema21, computed.ema21)}`);
  console.log(`    ema50:     stored=${fmt(stored.ema50)}  computed=${fmt(computed.ema50)}  ${match(stored.ema50, computed.ema50)}`);
  console.log(`    ema200:    stored=${fmt(stored.ema200)}  computed=${fmt(computed.ema200)}  ${match(stored.ema200, computed.ema200)}`);
  console.log(`    atr14:     stored=${fmt(stored.atr14)}  computed=${fmt(computed.atr14)}  ${match(stored.atr14, computed.atr14)}`);
}

async function main() {
  // Sample a few symbol/time combinations across the window
  await checkPoint('BTC', new Date('2026-01-15T12:00:00Z'));
  await checkPoint('BTC', new Date('2026-02-15T18:00:00Z'));
  await checkPoint('BTC', new Date('2026-03-10T06:00:00Z'));
  await checkPoint('HYPE', new Date('2026-02-01T00:00:00Z'));
  await checkPoint('VVV', new Date('2026-02-20T12:00:00Z'));
  await checkPoint('FARTCOIN', new Date('2026-03-01T18:00:00Z'));

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
