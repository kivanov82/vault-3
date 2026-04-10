/**
 * Backfill out-of-sample data for Mar 16 - Apr 10, 2026 validation window.
 *
 *   1. Fill sentiment wallet (Archangel + Bitcoin MA) fills from HL API
 *   2. Ensure indicators are complete for all whitelist + BTC
 *
 * Usage: npx tsx scripts/ml/backfill-oos-data.ts
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

// OOS window
const START_MS = new Date('2026-03-16T00:00:00Z').getTime();
const END_MS = new Date('2026-04-10T23:59:59Z').getTime();

const WALLETS: Array<{ address: `0x${string}`; label: string }> = [
  { address: '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0', label: 'archangel' },
  { address: '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768', label: 'bitcoin-ma' },
];

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE', 'VVV', 'MON', 'FARTCOIN'];
const LOOKBACK_HOURS = 210; // for ema200 warmup

const TWAP_WINDOW_SECONDS = 300;

// =============================================================================
// PART 1 — backfill sentiment wallet fills (same logic as backfill-sentiment-fills.ts)
// =============================================================================

async function backfillWallet(wallet: `0x${string}`, label: string) {
  console.log(`\n━━━ ${label} ━━━`);
  const transport = new hl.HttpTransport({ timeout: 30000 });
  const info = new hl.InfoClient({ transport });

  let cursor = START_MS;
  let imported = 0;
  let duplicates = 0;
  let pages = 0;

  while (cursor < END_MS) {
    pages++;
    console.log(`  📡 Page ${pages} from ${new Date(cursor).toISOString()}`);
    const apiFills = await info.userFillsByTime({
      user: wallet,
      startTime: cursor,
      endTime: END_MS,
      aggregateByTime: false,
    });

    if (apiFills.length === 0) {
      console.log('    (no fills)');
      break;
    }

    for (const fill of apiFills) {
      if (fill.time < START_MS || fill.time > END_MS) continue;
      try {
        await prisma.fill.create({
          data: {
            fillId: String(fill.tid ?? fill.oid),
            timestamp: new Date(fill.time),
            traderAddress: wallet,
            symbol: fill.coin,
            side: fill.side,
            price: parseFloat(fill.px),
            size: parseFloat(fill.sz),
            positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
            rawData: fill as any,
          },
        });
        imported++;
      } catch (e: any) {
        if (e.code === 'P2002') duplicates++;
        else console.error(`    ❌ ${fill.tid}: ${e.message}`);
      }
    }
    console.log(`    ${apiFills.length} fills, running total imported=${imported} dupes=${duplicates}`);
    const maxFillTime = Math.max(...apiFills.map((f) => f.time));
    if (maxFillTime <= cursor) break;
    cursor = maxFillTime + 1;
    await new Promise((r) => setTimeout(r, 400));
    if (apiFills.length < 2000) break;
  }

  // Aggregate
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: wallet,
      aggregateTradeId: null,
      timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) },
    },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`  🔄 Aggregating ${fills.length} fills into trades...`);

  let currentTrade: {
    symbol: string; side: 'long' | 'short'; fills: typeof fills;
    firstFillTime: number; lastFillTime: number; totalSize: number;
  } | null = null;
  let tradesCreated = 0;

  const finalize = async (t: NonNullable<typeof currentTrade>) => {
    const avgPrice = t.fills.reduce((s, f) => s + f.price * f.size, 0) / t.totalSize;
    const duration = (t.lastFillTime - t.firstFillTime) / 1000;
    const firstPrice = t.fills[0].price;
    const worst = t.fills.reduce((w, f) => Math.max(w, Math.abs((f.price - firstPrice) / firstPrice) * 10000), 0);
    const created = await prisma.trade.create({
      data: {
        timestamp: new Date(t.firstFillTime),
        trader: 'target',
        traderAddress: wallet,
        symbol: t.symbol,
        side: t.side,
        entryPrice: avgPrice,
        size: t.totalSize,
        leverage: 1,
        isTwapOrder: t.fills.length > 1,
        fillCount: t.fills.length,
        twapDurationSeconds: Math.round(duration),
        avgEntryPrice: avgPrice,
        worstSlippage: worst,
      },
    });
    for (let i = 0; i < t.fills.length; i++) {
      await prisma.fill.update({
        where: { id: t.fills[i].id },
        data: { aggregateTradeId: created.id, isFirstFill: i === 0, isLastFill: i === t.fills.length - 1 },
      });
    }
    tradesCreated++;
  };

  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    const ft = f.timestamp.getTime();
    if (!currentTrade) {
      currentTrade = { symbol: f.symbol, side: f.side === 'B' ? 'long' : 'short', fills: [f], firstFillTime: ft, lastFillTime: ft, totalSize: f.size };
    } else {
      const same = f.symbol === currentTrade.symbol && ((f.side === 'B' && currentTrade.side === 'long') || (f.side === 'A' && currentTrade.side === 'short'));
      const within = (ft - currentTrade.lastFillTime) / 1000 < TWAP_WINDOW_SECONDS;
      if (same && within) {
        currentTrade.fills.push(f);
        currentTrade.lastFillTime = ft;
        currentTrade.totalSize += f.size;
      } else {
        await finalize(currentTrade);
        currentTrade = { symbol: f.symbol, side: f.side === 'B' ? 'long' : 'short', fills: [f], firstFillTime: ft, lastFillTime: ft, totalSize: f.size };
      }
    }
    if (i === fills.length - 1 && currentTrade) await finalize(currentTrade);
  }
  console.log(`  ✅ Created ${tradesCreated} logical trades`);
}

// =============================================================================
// PART 2 — ensure indicators are complete (reuses logic from backfill-indicators.ts)
// =============================================================================

async function backfillIndicatorsForSymbol(symbol: string) {
  const lookbackStart = new Date(START_MS - LOOKBACK_HOURS * 3600 * 1000);
  const candles = await prisma.candle.findMany({
    where: { symbol, timeframe: '1h', timestamp: { gte: lookbackStart, lte: new Date(END_MS) } },
    orderBy: { timestamp: 'asc' },
    select: { id: true, timestamp: true, open: true, high: true, low: true, close: true, volume: true },
  });

  if (candles.length === 0) {
    console.log(`  ${symbol}: no candles`);
    return;
  }

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

  let written = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].timestamp.getTime() < START_MS) continue;

    const rsi14 = i - rsiOffset >= 0 ? rsiSeries[i - rsiOffset] ?? null : null;
    const ema9Val = i - 8 >= 0 ? ema9Series[i - 8] ?? null : null;
    const ema21Val = i - 20 >= 0 ? ema21Series[i - 20] ?? null : null;
    const ema50Val = i - 49 >= 0 ? ema50Series[i - 49] ?? null : null;
    const ema200Val = i - 199 >= 0 ? ema200Series[i - 199] ?? null : null;
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

    try {
      await prisma.candle.update({
        where: { id: candles[i].id },
        data: { rsi14, macd: macdLineVal, macdSignal: macdSignalVal, macdHist: macdHistVal, bbUpper, bbMiddle, bbLower, atr14 },
      });
      await prisma.technicalIndicator.upsert({
        where: { symbol_timeframe_timestamp: { symbol, timeframe: '1h', timestamp: candles[i].timestamp } },
        create: {
          symbol, timeframe: '1h', timestamp: candles[i].timestamp,
          rsi14, macd: macdLineVal, macdSignal: macdSignalVal, macdHist: macdHistVal,
          bbUpper, bbMiddle, bbLower, bbWidth,
          ema9: ema9Val, ema21: ema21Val, ema50: ema50Val, ema200: ema200Val, atr14,
        },
        update: {
          rsi14, macd: macdLineVal, macdSignal: macdSignalVal, macdHist: macdHistVal,
          bbUpper, bbMiddle, bbLower, bbWidth,
          ema9: ema9Val, ema21: ema21Val, ema50: ema50Val, ema200: ema200Val, atr14,
        },
      });
      written++;
    } catch (e: any) { /* continue */ }
  }
  console.log(`  ${symbol.padEnd(10)} ${written} rows written`);
}

// =============================================================================

async function main() {
  console.log(`\n🔄 OOS data backfill: ${new Date(START_MS).toISOString().slice(0,10)} → ${new Date(END_MS).toISOString().slice(0,10)}\n`);

  console.log('━━━ PART 1: Sentiment wallet fills ━━━');
  for (const { address, label } of WALLETS) {
    await backfillWallet(address, label);
  }

  console.log('\n━━━ PART 2: Indicator backfill ━━━');
  for (const sym of SYMBOLS) {
    await backfillIndicatorsForSymbol(sym);
  }

  // Verify
  console.log('\n━━━ Final verification ━━━');
  for (const { address, label } of WALLETS) {
    const n = await prisma.fill.count({ where: { traderAddress: address, timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } } });
    console.log(`  ${label.padEnd(12)} ${n} fills`);
  }
  for (const sym of SYMBOLS) {
    const inds = await prisma.technicalIndicator.count({ where: { symbol: sym, timeframe: '1h', timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } } });
    console.log(`  ${sym.padEnd(10)} ${inds} indicators`);
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
