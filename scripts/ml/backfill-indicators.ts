/**
 * Backfill indicators on historical candles for Jan 1 - Mar 15, 2026 window.
 *
 * For each symbol in the CORE set, compute rsi14/macd/bb/ema9/ema21/ema50/ema200/atr14
 * per 1h candle and write to:
 *   - Candle.rsi14/macd/macdSignal/macdHist/bbUpper/bbMiddle/bbLower/atr14
 *   - TechnicalIndicator (full row with ema9/21/50/200, bbWidth)
 *
 * Uses a look-back window so each candle gets indicators computed as if we were
 * in live mode at that timestamp (no look-ahead).
 *
 * Usage: npx tsx scripts/ml/backfill-indicators.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ema, rsi, macd, bollingerBands, atr } from '../../src/service/utils/indicators';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-03-15T00:00:00Z');

// Core symbols: ≥95% coverage AND meaningful target activity in window
const CORE_SYMBOLS = [
  'BTC', 'ETH', 'SOL',
  'HYPE', 'VVV', 'SPX', 'SKY', 'VIRTUAL',
  'MON', 'PUMP', 'FARTCOIN', 'kPEPE',
  'ZEC', 'ETHFI', 'AVNT', 'IP',
];

// We need 200 candles of look-back to compute ema200 at the first window candle.
// That means we should fetch candles from (START - 200 hours) onward.
const LOOKBACK_HOURS = 210;

async function backfillSymbol(symbol: string): Promise<{ computed: number; written: number }> {
  const lookbackStart = new Date(START.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const candles = await prisma.candle.findMany({
    where: {
      symbol,
      timeframe: '1h',
      timestamp: { gte: lookbackStart, lte: END },
    },
    orderBy: { timestamp: 'asc' },
    select: { id: true, timestamp: true, open: true, high: true, low: true, close: true, volume: true },
  });

  if (candles.length === 0) {
    return { computed: 0, written: 0 };
  }

  // Compute indicators incrementally: for each candle i, use closes[0..i] as input
  // and take the last value of each indicator series.
  const closes = candles.map((c) => c.close);
  const ohlcv = candles.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  // Compute full series once — each index i corresponds to the indicator value at candle i
  // (after the indicator's own warmup period).
  const ema9Series = ema(closes, 9);
  const ema21Series = ema(closes, 21);
  const ema50Series = ema(closes, 50);
  const ema200Series = ema(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes, 20, 2);
  const atrSeries = atr(ohlcv, 14);

  // Alignment helpers:
  // ema(closes, p) returns array starting at index (p-1) in the closes array.
  // rsi returns array starting at index p (first price-change is closes[1]-closes[0]).
  // macd returns array aligned with slowPeriod (26) -> first value at index 25, minus signal lag.
  // bollingerBands returns array starting at index (period-1) = 19.
  // atr returns array starting at index (period) = 14.

  const ema9Offset = 9 - 1;
  const ema21Offset = 21 - 1;
  const ema50Offset = 50 - 1;
  const ema200Offset = 200 - 1;
  const rsiOffset = 14;
  const bbOffset = 20 - 1;
  // ATR: first value is average of TR[0..13] → belongs to candle index 13
  const atrOffset = 13;

  // MACD is aligned with signalLine (ema of macdLine, signalPeriod=9 on top of macdLine which starts at 25)
  // Final macdResult.histogram has length = macdLine.length - signalLine.length + 1? Let's compute offset:
  //   macdLine[0] corresponds to closes index 25
  //   signalLine = ema(macdLine, 9), first value at macdLine index 8 -> closes index 25+8 = 33
  const macdHistOffset = 25 + 9 - 1; // 33

  let computed = 0;
  const updates: Array<{
    candleId: string;
    timestamp: Date;
    rsi14: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHist: number | null;
    bbUpper: number | null;
    bbMiddle: number | null;
    bbLower: number | null;
    bbWidth: number | null;
    ema9: number | null;
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
    atr14: number | null;
  }> = [];

  for (let i = 0; i < candles.length; i++) {
    // Only persist candles inside the target window (skip lookback candles)
    if (candles[i].timestamp < START) continue;

    const rsi14 = i - rsiOffset >= 0 ? rsiSeries[i - rsiOffset] ?? null : null;
    const ema9Val = i - ema9Offset >= 0 ? ema9Series[i - ema9Offset] ?? null : null;
    const ema21Val = i - ema21Offset >= 0 ? ema21Series[i - ema21Offset] ?? null : null;
    const ema50Val = i - ema50Offset >= 0 ? ema50Series[i - ema50Offset] ?? null : null;
    const ema200Val = i - ema200Offset >= 0 ? ema200Series[i - ema200Offset] ?? null : null;
    const bbIdx = i - bbOffset;
    const bbUpper = bbIdx >= 0 ? bbResult.upper[bbIdx] ?? null : null;
    const bbMiddle = bbIdx >= 0 ? bbResult.middle[bbIdx] ?? null : null;
    const bbLower = bbIdx >= 0 ? bbResult.lower[bbIdx] ?? null : null;
    const bbWidth = bbIdx >= 0 ? bbResult.width[bbIdx] ?? null : null;
    const atr14 = i - atrOffset >= 0 ? atrSeries[i - atrOffset] ?? null : null;

    const macdIdx = i - macdHistOffset;
    const macdLineVal = macdIdx >= 0 ? macdResult.macd[macdIdx] ?? null : null;
    const macdSignalVal = macdIdx >= 0 ? macdResult.signal[macdIdx] ?? null : null;
    const macdHistVal = macdIdx >= 0 ? macdResult.histogram[macdIdx] ?? null : null;

    updates.push({
      candleId: candles[i].id,
      timestamp: candles[i].timestamp,
      rsi14,
      macd: macdLineVal,
      macdSignal: macdSignalVal,
      macdHist: macdHistVal,
      bbUpper,
      bbMiddle,
      bbLower,
      bbWidth,
      ema9: ema9Val,
      ema21: ema21Val,
      ema50: ema50Val,
      ema200: ema200Val,
      atr14,
    });
    computed++;
  }

  // Batch write in chunks of 500
  let written = 0;
  for (let chunkStart = 0; chunkStart < updates.length; chunkStart += 500) {
    const chunk = updates.slice(chunkStart, chunkStart + 500);

    // Write Candle rows (columns already exist on schema)
    await Promise.all(
      chunk.map((u) =>
        prisma.candle.update({
          where: { id: u.candleId },
          data: {
            rsi14: u.rsi14,
            macd: u.macd,
            macdSignal: u.macdSignal,
            macdHist: u.macdHist,
            bbUpper: u.bbUpper,
            bbMiddle: u.bbMiddle,
            bbLower: u.bbLower,
            atr14: u.atr14,
          },
        })
      )
    );

    // Upsert TechnicalIndicator rows (full indicator set including ema9/21/50/200, bbWidth)
    await Promise.all(
      chunk.map((u) =>
        prisma.technicalIndicator.upsert({
          where: {
            symbol_timeframe_timestamp: {
              symbol,
              timeframe: '1h',
              timestamp: u.timestamp,
            },
          },
          create: {
            symbol,
            timeframe: '1h',
            timestamp: u.timestamp,
            rsi14: u.rsi14,
            macd: u.macd,
            macdSignal: u.macdSignal,
            macdHist: u.macdHist,
            bbUpper: u.bbUpper,
            bbMiddle: u.bbMiddle,
            bbLower: u.bbLower,
            bbWidth: u.bbWidth,
            ema9: u.ema9,
            ema21: u.ema21,
            ema50: u.ema50,
            ema200: u.ema200,
            atr14: u.atr14,
          },
          update: {
            rsi14: u.rsi14,
            macd: u.macd,
            macdSignal: u.macdSignal,
            macdHist: u.macdHist,
            bbUpper: u.bbUpper,
            bbMiddle: u.bbMiddle,
            bbLower: u.bbLower,
            bbWidth: u.bbWidth,
            ema9: u.ema9,
            ema21: u.ema21,
            ema50: u.ema50,
            ema200: u.ema200,
            atr14: u.atr14,
          },
        })
      )
    );

    written += chunk.length;
    process.stdout.write(`    ${written}/${updates.length}\r`);
  }

  return { computed, written };
}

async function main() {
  console.log(`\n🔢 Backfilling indicators: ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}`);
  console.log(`   Symbols: ${CORE_SYMBOLS.join(', ')}\n`);

  const t0 = Date.now();
  for (const sym of CORE_SYMBOLS) {
    console.log(`  ${sym}...`);
    const t1 = Date.now();
    try {
      const { computed, written } = await backfillSymbol(sym);
      console.log(`  ${sym}: ${computed} computed, ${written} written (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      console.error(`  ${sym}: ERROR ${e.message}`);
    }
  }
  console.log(`\n✅ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
