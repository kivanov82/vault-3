/**
 * Backfill 1h candles + indicators for whitelist-candidate tickers.
 *
 * Fetches up to 5000 1h candles per symbol from Hyperliquid (≈207 days),
 * upserts Candle rows (fills gaps in live-collected data), then recomputes
 * the full indicator set over the complete series.
 *
 * Usage: npx tsx scripts/ml/backfill-candidate-tickers.ts [SYM1,SYM2,...]
 */

import dotenv from 'dotenv';
dotenv.config();

import * as hl from '@nktkas/hyperliquid';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ema, rsi, macd, bollingerBands, atr } from '../../src/service/utils/indicators';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DEFAULT_SYMBOLS = ['ZEC', 'XMR', 'PENGU', 'NEAR', 'PUMP', 'SPX', 'BLUR'];
const SYMBOLS = process.argv[2] ? process.argv[2].split(',') : DEFAULT_SYMBOLS;

const HOURS = 4990; // ≈207 days, just under HL's 5000-candle cap

const CHUNK = 1000;

async function backfillCandles(info: hl.InfoClient, symbol: string): Promise<number> {
  const startTime = Date.now() - HOURS * 3600 * 1000;
  const candles = await info.candleSnapshot({ coin: symbol, interval: '1h', startTime });
  const rows = candles.map((c) => ({
    symbol,
    timeframe: '1h',
    timestamp: new Date(c.t),
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  }));
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    // skipDuplicates: existing live-collected rows come from the same HL source — keep them
    const res = await prisma.candle.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    written += res.count;
  }
  return written;
}

async function backfillIndicators(symbol: string): Promise<number> {
  const candles = await prisma.candle.findMany({
    where: { symbol, timeframe: '1h' },
    orderBy: { timestamp: 'asc' },
    select: { id: true, timestamp: true, open: true, high: true, low: true, close: true, volume: true },
  });
  if (candles.length === 0) return 0;

  const closes = candles.map((c) => c.close);
  const ohlcv = candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));

  const ema9Series = ema(closes, 9);
  const ema21Series = ema(closes, 21);
  const ema50Series = ema(closes, 50);
  const ema200Series = ema(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes, 20, 2);
  const atrSeries = atr(ohlcv, 14);

  const bbOffset = 19;
  const atrOffset = 13;
  const rsiOffset = 14;
  const macdHistOffset = 33;

  const rows = candles.map((c, i) => {
    const bbIdx = i - bbOffset;
    const macdIdx = i - macdHistOffset;
    return {
      symbol,
      timeframe: '1h',
      timestamp: c.timestamp,
      rsi14: i - rsiOffset >= 0 ? rsiSeries[i - rsiOffset] ?? null : null,
      macd: macdIdx >= 0 ? macdResult.macd[macdIdx] ?? null : null,
      macdSignal: macdIdx >= 0 ? macdResult.signal[macdIdx] ?? null : null,
      macdHist: macdIdx >= 0 ? macdResult.histogram[macdIdx] ?? null : null,
      bbUpper: bbIdx >= 0 ? bbResult.upper[bbIdx] ?? null : null,
      bbMiddle: bbIdx >= 0 ? bbResult.middle[bbIdx] ?? null : null,
      bbLower: bbIdx >= 0 ? bbResult.lower[bbIdx] ?? null : null,
      bbWidth: bbIdx >= 0 ? bbResult.width[bbIdx] ?? null : null,
      ema9: i - 8 >= 0 ? ema9Series[i - 8] ?? null : null,
      ema21: i - 20 >= 0 ? ema21Series[i - 20] ?? null : null,
      ema50: i - 49 >= 0 ? ema50Series[i - 49] ?? null : null,
      ema200: i - 199 >= 0 ? ema200Series[i - 199] ?? null : null,
      atr14: i - atrOffset >= 0 ? atrSeries[i - atrOffset] ?? null : null,
    };
  });

  // Recreate the symbol's full indicator series in bulk — far faster than row upserts
  await prisma.technicalIndicator.deleteMany({ where: { symbol, timeframe: '1h' } });
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await prisma.technicalIndicator.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    written += res.count;
  }
  return written;
}

async function main() {
  console.log(`\n🔄 Candidate ticker backfill: ${SYMBOLS.join(', ')}\n`);
  const transport = new hl.HttpTransport({ timeout: 30000 });
  const info = new hl.InfoClient({ transport });

  for (const sym of SYMBOLS) {
    try {
      const candles = await backfillCandles(info, sym);
      const inds = await backfillIndicators(sym);
      const range = await prisma.candle.aggregate({
        where: { symbol: sym, timeframe: '1h' },
        _min: { timestamp: true },
        _max: { timestamp: true },
        _count: true,
      });
      console.log(`  ${sym.padEnd(8)} candles upserted: ${candles}, indicators: ${inds}, total range: ${range._min.timestamp?.toISOString().slice(0, 10)} → ${range._max.timestamp?.toISOString().slice(0, 10)} (${range._count})`);
      await new Promise((r) => setTimeout(r, 500)); // HL rate-limit courtesy
    } catch (e: any) {
      console.error(`  ❌ ${sym}: ${e.message}`);
    }
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
