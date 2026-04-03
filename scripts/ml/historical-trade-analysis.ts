/**
 * Historical Trade Analysis — Target Vault Strategy Extraction
 *
 * Analyzes all fills from vault 0x4cb5 (Jan 1 - Mar 10, 2026) to extract:
 * - Position cycles with VWAP entry/exit
 * - Technical indicators at entry/exit points
 * - Indicator combinations that predict winners
 * - Actionable trading rules
 *
 * Usage: npm run ml:historical [--skip-candle-fetch]
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as hl from '@nktkas/hyperliquid';
import { calculateAllIndicators, type AllIndicators, type OHLCV } from '../../src/service/utils/indicators';
import * as fs from 'fs';
import * as path from 'path';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 120000, // 2 min for large queries
  query_timeout: 120000,
  connectionTimeoutMillis: 30000,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TARGET_ADDR = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';
const START_DATE = new Date('2026-01-01T00:00:00Z');
const END_DATE = new Date('2026-03-10T23:59:59Z');
const SKIP_CANDLE_FETCH = process.argv.includes('--skip-candle-fetch');

// ═══════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════

interface Fill {
  symbol: string;
  side: string;
  price: number;
  size: number;
  positionSzi: number;
  timestamp: Date;
  rawData: any;
}

interface MarketContext {
  price: number;
  rsi14: number | null;
  macd: number | null;
  macdHist: number | null;
  macdSignal: number | null;
  bbPosition: number | null;
  bbWidth: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  atr14Pct: number | null;
  stochK: number | null;
  adx: number | null;
  roc12: number | null;
  priceChange1h: number | null;
  priceChange4h: number | null;
  priceChange24h: number | null;
  btcPrice: number | null;
  btcChange1h: number | null;
  btcChange24h: number | null;
  btcRsi: number | null;
  btcMacdHist: number | null;
  btcMacroRegime: 'bull' | 'bear' | 'neutral';
  session: string;
  hourOfDay: number;
  dayOfWeek: number;
}

interface EnrichedCycle {
  symbol: string;
  direction: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  holdTimeMs: number;
  holdTimeH: number;
  entryPrice: number;
  exitPrice: number;
  peakSize: number;
  entryFillCount: number;
  exitFillCount: number;
  realizedPnl: number;
  pnlPct: number;
  entrySession: string;
  exitSession: string;
  entryIndicators: MarketContext | null;
  exitIndicators: MarketContext | null;
  incompleteData: boolean;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function getSession(date: Date): string {
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 8) return 'asia';
  if (hour >= 8 && hour < 16) return 'europe';
  return 'us';
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function median(arr: number[]): number {
  return percentile(arr, 50);
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ═══════════════════════════════════════════════════════
// STEP 1: VERIFY & BACKFILL FILLS
// ═══════════════════════════════════════════════════════

async function verifyAndBackfillFills(): Promise<Fill[]> {
  console.log('═'.repeat(70));
  console.log('STEP 1: VERIFY & BACKFILL FILLS');
  console.log('═'.repeat(70));

  // Check existing fills
  const existingCount = await prisma.fill.count({
    where: {
      traderAddress: TARGET_ADDR,
      timestamp: { gte: START_DATE, lte: END_DATE },
    },
  });

  console.log(`  Existing fills in DB for date range: ${existingCount}`);

  // Check coverage
  const dateRange = await prisma.fill.aggregate({
    where: {
      traderAddress: TARGET_ADDR,
      timestamp: { gte: START_DATE, lte: END_DATE },
    },
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  if (dateRange._min.timestamp && dateRange._max.timestamp) {
    console.log(`  DB range: ${dateRange._min.timestamp.toISOString().slice(0, 16)} to ${dateRange._max.timestamp.toISOString().slice(0, 16)}`);
  }

  // Backfill if needed (check if we have fills from Jan 1)
  const hasJanFills = await prisma.fill.count({
    where: {
      traderAddress: TARGET_ADDR,
      timestamp: { gte: START_DATE, lt: new Date('2026-01-02T00:00:00Z') },
    },
  });

  if (hasJanFills === 0) {
    console.log('  Missing early fills — backfilling from API...');
    await backfillFromAPI();
  } else {
    console.log('  Coverage looks good, skipping backfill');
  }

  // Load all fills for analysis
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: TARGET_ADDR,
      timestamp: { gte: START_DATE, lte: END_DATE },
    },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`  Total fills for analysis: ${fills.length}`);
  if (fills.length > 0) {
    console.log(`  From: ${fills[0].timestamp.toISOString().slice(0, 16)}`);
    console.log(`  To:   ${fills[fills.length - 1].timestamp.toISOString().slice(0, 16)}`);
  }

  return fills.map(f => ({
    symbol: f.symbol,
    side: f.side,
    price: f.price,
    size: f.size,
    positionSzi: f.positionSzi,
    timestamp: f.timestamp,
    rawData: f.rawData,
  }));
}

async function backfillFromAPI(): Promise<void> {
  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });

  let startTime = START_DATE.getTime();
  const endTime = END_DATE.getTime();
  let totalImported = 0;
  const MAX_PAGES = 50;

  for (let page = 0; page < MAX_PAGES; page++) {
    console.log(`    Fetching page ${page + 1} (from ${new Date(startTime).toISOString().slice(0, 16)})...`);

    const apiFills = await info.userFillsByTime({
      user: TARGET_ADDR as `0x${string}`,
      startTime,
      endTime,
      aggregateByTime: false,
    });

    if (apiFills.length === 0) break;

    let pageImported = 0;
    for (const fill of apiFills) {
      try {
        await prisma.fill.create({
          data: {
            fillId: String(fill.tid || fill.oid),
            timestamp: new Date(fill.time),
            traderAddress: TARGET_ADDR,
            symbol: fill.coin,
            side: fill.side,
            price: parseFloat(fill.px),
            size: parseFloat(fill.sz),
            positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
            rawData: fill as any,
          },
        });
        pageImported++;
      } catch (error: any) {
        if (error.code !== 'P2002') {
          console.error(`    Fill import error: ${error.message}`);
        }
      }
    }

    totalImported += pageImported;
    console.log(`    Page ${page + 1}: ${apiFills.length} fetched, ${pageImported} new`);

    if (apiFills.length < 2000) break;

    startTime = Math.max(...apiFills.map(f => f.time)) + 1;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  Backfill complete: ${totalImported} new fills imported`);
}

// ═══════════════════════════════════════════════════════
// STEP 2: RECONSTRUCT POSITION CYCLES
// ═══════════════════════════════════════════════════════

function reconstructCycles(fills: Fill[]): EnrichedCycle[] {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2: RECONSTRUCT POSITION CYCLES');
  console.log('═'.repeat(70));

  const positionState = new Map<string, {
    direction: 'long' | 'short' | null;
    size: number;
    entryFills: Fill[];
    exitFills: Fill[];
    peakSize: number;
    totalEntryValue: number;
    totalEntrySize: number;
    totalExitValue: number;
    totalExitSize: number;
  }>();

  const cycles: EnrichedCycle[] = [];

  for (const fill of fills) {
    const raw = fill.rawData as any;
    const dir = raw?.dir as string || '';
    const sym = fill.symbol;

    let state = positionState.get(sym);
    if (!state) {
      state = {
        direction: null, size: 0, entryFills: [], exitFills: [],
        peakSize: 0, totalEntryValue: 0, totalEntrySize: 0,
        totalExitValue: 0, totalExitSize: 0,
      };
      positionState.set(sym, state);
    }

    const isOpen = dir.startsWith('Open');
    const isClose = dir.startsWith('Close');
    const isLong = dir.includes('Long');

    if (isOpen) {
      if (state.direction === null || state.size === 0) {
        state.direction = isLong ? 'long' : 'short';
        state.entryFills = [fill];
        state.exitFills = [];
        state.totalEntryValue = fill.price * fill.size;
        state.totalEntrySize = fill.size;
        state.totalExitValue = 0;
        state.totalExitSize = 0;
        state.peakSize = fill.size;
        state.size = fill.size;
      } else {
        state.entryFills.push(fill);
        state.totalEntryValue += fill.price * fill.size;
        state.totalEntrySize += fill.size;
        state.size += fill.size;
        if (state.size > state.peakSize) state.peakSize = state.size;
      }
    } else if (isClose) {
      state.exitFills.push(fill);
      state.totalExitValue += fill.price * fill.size;
      state.totalExitSize += fill.size;
      state.size -= fill.size;

      if (Math.abs(fill.positionSzi) < 0.0001 || state.size <= 0.0001) {
        if (state.entryFills.length > 0 && state.totalExitSize > 0) {
          const avgEntry = state.totalEntryValue / state.totalEntrySize;
          const avgExit = state.totalExitValue / state.totalExitSize;
          const holdTimeMs = fill.timestamp.getTime() - state.entryFills[0].timestamp.getTime();

          cycles.push({
            symbol: sym,
            direction: state.direction!,
            entryTime: state.entryFills[0].timestamp.toISOString(),
            exitTime: fill.timestamp.toISOString(),
            holdTimeMs,
            holdTimeH: holdTimeMs / 3600000,
            entryPrice: avgEntry,
            exitPrice: avgExit,
            peakSize: state.peakSize,
            entryFillCount: state.entryFills.length,
            exitFillCount: state.exitFills.length,
            realizedPnl: parseFloat(raw?.closedPnl || '0'),
            pnlPct: state.direction === 'long'
              ? ((avgExit - avgEntry) / avgEntry) * 100
              : ((avgEntry - avgExit) / avgEntry) * 100,
            entrySession: getSession(state.entryFills[0].timestamp),
            exitSession: getSession(fill.timestamp),
            entryIndicators: null,
            exitIndicators: null,
            incompleteData: false,
          });
        }
        // Reset
        state.direction = null;
        state.size = 0;
        state.entryFills = [];
        state.exitFills = [];
        state.peakSize = 0;
        state.totalEntryValue = 0;
        state.totalEntrySize = 0;
        state.totalExitValue = 0;
        state.totalExitSize = 0;
      }
    }
  }

  const wins = cycles.filter(c => c.pnlPct > 0);
  const uniqueSymbols = new Set(cycles.map(c => c.symbol));

  console.log(`  Total cycles: ${cycles.length}`);
  console.log(`  Unique symbols: ${uniqueSymbols.size}`);
  console.log(`  Win rate: ${(wins.length / cycles.length * 100).toFixed(1)}%`);
  console.log(`  Long: ${cycles.filter(c => c.direction === 'long').length}, Short: ${cycles.filter(c => c.direction === 'short').length}`);
  console.log(`  Avg hold: ${avg(cycles.map(c => c.holdTimeH)).toFixed(1)}h`);
  console.log(`  Median hold: ${median(cycles.map(c => c.holdTimeH)).toFixed(1)}h`);
  console.log(`  Avg entry fills: ${avg(cycles.map(c => c.entryFillCount)).toFixed(1)}`);
  console.log(`  Avg exit fills: ${avg(cycles.map(c => c.exitFillCount)).toFixed(1)}`);

  return cycles;
}

// ═══════════════════════════════════════════════════════
// STEP 3: FETCH HISTORICAL CANDLES
// ═══════════════════════════════════════════════════════

async function fetchHistoricalCandles(symbols: string[]): Promise<void> {
  if (SKIP_CANDLE_FETCH) {
    console.log('\n  --skip-candle-fetch flag set, skipping candle fetch');
    return;
  }

  console.log('\n' + '═'.repeat(70));
  console.log('STEP 3: FETCH HISTORICAL CANDLES');
  console.log('═'.repeat(70));

  const transport = new hl.HttpTransport({ timeout: 30000 });
  const info = new hl.InfoClient({ transport });

  // Warmup from Dec 1 for EMA200
  const candleStart = new Date('2025-12-01T00:00:00Z').getTime();
  const candleEnd = END_DATE.getTime();

  // Ensure BTC is included
  const allSymbols = [...new Set(['BTC', ...symbols])];
  console.log(`  Fetching candles for ${allSymbols.length} symbols (Dec 1, 2025 - Mar 10, 2026)`);

  const BATCH_SIZE = 5;
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (symbol) => {
      try {
        // Check if we already have candles for this symbol in this range
        const existing = await prisma.candle.count({
          where: {
            symbol,
            timeframe: '1h',
            timestamp: { gte: new Date(candleStart), lte: END_DATE },
          },
        });

        if (existing > 2000) {
          fetched++;
          return; // Already have sufficient data
        }

        const candles = await info.candleSnapshot({
          coin: symbol,
          interval: '1h',
          startTime: candleStart,
          endTime: candleEnd,
        });

        if (!candles || candles.length === 0) {
          console.log(`    ${symbol}: no candles returned (may be delisted)`);
          failed++;
          return;
        }

        // Bulk upsert candles via raw SQL (much faster than individual upserts)
        const CHUNK = 200;
        for (let ci = 0; ci < candles.length; ci += CHUNK) {
          const chunk = candles.slice(ci, ci + CHUNK);
          const values = chunk.map(c => {
            const ts = new Date(c.t).toISOString();
            return `(gen_random_uuid(), '${symbol}', '1h', '${ts}', ${parseFloat(c.o)}, ${parseFloat(c.h)}, ${parseFloat(c.l)}, ${parseFloat(c.c)}, ${parseFloat(c.v)}, NOW())`;
          }).join(',\n');

          try {
            await pool.query(`
              INSERT INTO "Candle" (id, symbol, timeframe, timestamp, open, high, low, close, volume, "createdAt")
              VALUES ${values}
              ON CONFLICT (symbol, timeframe, timestamp)
              DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume
            `);
          } catch (_) {
            // Skip on error
          }
        }

        fetched++;
        if (fetched % 10 === 0) {
          console.log(`    Progress: ${fetched}/${allSymbols.length} symbols`);
        }
      } catch (error: any) {
        console.log(`    ${symbol}: fetch failed - ${error.message?.slice(0, 60)}`);
        failed++;
      }
    }));

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  Candle fetch complete: ${fetched} OK, ${failed} failed`);
}

// ═══════════════════════════════════════════════════════
// STEP 4: COMPUTE INDICATORS AT ENTRY/EXIT
// ═══════════════════════════════════════════════════════

async function computeIndicators(cycles: EnrichedCycle[]): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 4: COMPUTE INDICATORS AT ENTRY/EXIT');
  console.log('═'.repeat(70));

  // Cache candles per symbol to avoid repeated DB queries
  const candleCache = new Map<string, { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[]>();

  async function getCandlesForSymbol(symbol: string): Promise<typeof candleCache extends Map<string, infer V> ? V : never> {
    if (candleCache.has(symbol)) return candleCache.get(symbol)!;

    const candles = await prisma.candle.findMany({
      where: {
        symbol,
        timeframe: '1h',
        timestamp: { gte: new Date('2025-12-01'), lte: END_DATE },
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, open: true, high: true, low: true, close: true, volume: true },
    });

    candleCache.set(symbol, candles);
    return candles;
  }

  function getIndicatorsAt(
    candles: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[],
    targetTime: Date,
    lookback: number = 210
  ): AllIndicators | null {
    // Find candles up to targetTime
    const idx = candles.findIndex(c => c.timestamp > targetTime);
    const endIdx = idx === -1 ? candles.length : idx;
    const startIdx = Math.max(0, endIdx - lookback);
    const slice = candles.slice(startIdx, endIdx);

    if (slice.length < 26) return null;

    const ohlcv: OHLCV[] = slice.map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));

    return calculateAllIndicators(ohlcv);
  }

  function buildMarketContext(
    symbol: string,
    candles: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[],
    targetTime: Date,
    btcCandles: typeof candles,
    indicators: AllIndicators
  ): MarketContext {
    // Find current price
    const idx = candles.findIndex(c => c.timestamp > targetTime);
    const endIdx = idx === -1 ? candles.length : idx;
    const currentCandle = candles[endIdx - 1];
    const price = currentCandle?.close || 0;

    // Price changes
    const getChangeN = (arr: typeof candles, ei: number, n: number) => {
      if (ei <= n || ei > arr.length) return null;
      const prev = arr[ei - n - 1]?.close;
      const curr = arr[ei - 1]?.close;
      return prev && curr ? ((curr - prev) / prev) * 100 : null;
    };

    // BB position
    let bbPosition: number | null = null;
    if (indicators.bbUpper && indicators.bbLower && price) {
      const range = indicators.bbUpper - indicators.bbLower;
      bbPosition = range > 0 ? (price - indicators.bbLower) / range : 0.5;
    }

    // ATR as % of price
    const atr14Pct = indicators.atr14 && price ? (indicators.atr14 / price) * 100 : null;

    // BTC context
    const btcIdx = btcCandles.findIndex(c => c.timestamp > targetTime);
    const btcEndIdx = btcIdx === -1 ? btcCandles.length : btcIdx;
    const btcIndicators = getIndicatorsAt(btcCandles, targetTime);
    const btcPrice = btcCandles[btcEndIdx - 1]?.close || null;
    const btcChange1h = getChangeN(btcCandles, btcEndIdx, 1);
    const btcChange24h = getChangeN(btcCandles, btcEndIdx, 24);

    // BTC macro regime
    let btcMacroRegime: 'bull' | 'bear' | 'neutral' = 'neutral';
    if (btcIndicators) {
      let score = 0;
      if (btcIndicators.ema50 && btcPrice) score += btcPrice > btcIndicators.ema50 ? 1 : -1;
      if (btcIndicators.ema200 && btcPrice) score += btcPrice > btcIndicators.ema200 ? 1 : -1;
      if (btcIndicators.macdHist) score += btcIndicators.macdHist > 0 ? 1 : -1;
      if (btcChange24h !== null) {
        if (btcChange24h < -5) score -= 2;
        else if (btcChange24h > 5) score += 2;
      }
      if (score >= 2) btcMacroRegime = 'bull';
      else if (score <= -2) btcMacroRegime = 'bear';
    }

    return {
      price,
      rsi14: indicators.rsi14,
      macd: indicators.macd,
      macdHist: indicators.macdHist,
      macdSignal: indicators.macdSignal,
      bbPosition,
      bbWidth: indicators.bbWidth,
      ema9: indicators.ema9,
      ema21: indicators.ema21,
      ema50: indicators.ema50,
      ema200: indicators.ema200,
      atr14: indicators.atr14,
      atr14Pct,
      stochK: indicators.stochK,
      adx: indicators.adx,
      roc12: indicators.roc12,
      priceChange1h: getChangeN(candles, endIdx, 1),
      priceChange4h: getChangeN(candles, endIdx, 4),
      priceChange24h: getChangeN(candles, endIdx, 24),
      btcPrice,
      btcChange1h,
      btcChange24h,
      btcRsi: btcIndicators?.rsi14 || null,
      btcMacdHist: btcIndicators?.macdHist || null,
      btcMacroRegime,
      session: getSession(targetTime),
      hourOfDay: targetTime.getUTCHours(),
      dayOfWeek: targetTime.getUTCDay(),
    };
  }

  const btcCandles = await getCandlesForSymbol('BTC');
  let completed = 0;
  let incomplete = 0;

  for (const cycle of cycles) {
    const candles = await getCandlesForSymbol(cycle.symbol);

    if (candles.length < 30) {
      cycle.incompleteData = true;
      incomplete++;
      continue;
    }

    const entryTime = new Date(cycle.entryTime);
    const exitTime = new Date(cycle.exitTime);

    const entryInd = getIndicatorsAt(candles, entryTime);
    const exitInd = getIndicatorsAt(candles, exitTime);

    if (entryInd) {
      cycle.entryIndicators = buildMarketContext(cycle.symbol, candles, entryTime, btcCandles, entryInd);
    }
    if (exitInd) {
      cycle.exitIndicators = buildMarketContext(cycle.symbol, candles, exitTime, btcCandles, exitInd);
    }

    if (!entryInd && !exitInd) {
      cycle.incompleteData = true;
      incomplete++;
    }

    completed++;
    if (completed % 50 === 0) {
      console.log(`    Progress: ${completed}/${cycles.length} cycles`);
    }
  }

  const withIndicators = cycles.filter(c => c.entryIndicators);
  console.log(`  Computed: ${withIndicators.length} with indicators, ${incomplete} incomplete`);
}

// ═══════════════════════════════════════════════════════
// STEP 5: STATISTICAL ANALYSIS
// ═══════════════════════════════════════════════════════

function runAnalysis(cycles: EnrichedCycle[]): any {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 5: STATISTICAL ANALYSIS');
  console.log('═'.repeat(70));

  const valid = cycles.filter(c => c.entryIndicators && !c.incompleteData);
  const winners = valid.filter(c => c.pnlPct > 0);
  const losers = valid.filter(c => c.pnlPct <= 0);

  console.log(`\n  Analyzable cycles: ${valid.length} (${winners.length} winners, ${losers.length} losers)`);

  // ── 5a: Indicator distributions at entry ──

  console.log('\n' + '─'.repeat(70));
  console.log('5a. INDICATOR DISTRIBUTIONS AT ENTRY (Winners vs Losers)');
  console.log('─'.repeat(70));

  type IndicatorKey = 'rsi14' | 'macdHist' | 'bbPosition' | 'adx' | 'stochK' | 'roc12' | 'atr14Pct' | 'priceChange1h' | 'priceChange4h' | 'priceChange24h';

  const indicatorKeys: { key: IndicatorKey; label: string }[] = [
    { key: 'rsi14', label: 'RSI(14)' },
    { key: 'macdHist', label: 'MACD Hist' },
    { key: 'bbPosition', label: 'BB Position' },
    { key: 'adx', label: 'ADX' },
    { key: 'stochK', label: 'Stoch %K' },
    { key: 'roc12', label: 'ROC(12)' },
    { key: 'atr14Pct', label: 'ATR14 %' },
    { key: 'priceChange1h', label: '1h Change%' },
    { key: 'priceChange4h', label: '4h Change%' },
    { key: 'priceChange24h', label: '24h Change%' },
  ];

  const indicatorStats: Record<string, { winMedian: number; loseMedian: number; winP25: number; winP75: number; loseP25: number; loseP75: number }> = {};

  for (const { key, label } of indicatorKeys) {
    const winVals = winners.map(c => c.entryIndicators![key]).filter(v => v !== null && isFinite(v as number)) as number[];
    const loseVals = losers.map(c => c.entryIndicators![key]).filter(v => v !== null && isFinite(v as number)) as number[];

    if (winVals.length < 5 || loseVals.length < 5) continue;

    const stats = {
      winMedian: median(winVals),
      loseMedian: median(loseVals),
      winP25: percentile(winVals, 25),
      winP75: percentile(winVals, 75),
      loseP25: percentile(loseVals, 25),
      loseP75: percentile(loseVals, 75),
    };
    indicatorStats[key] = stats;

    console.log(`\n  ${label}:`);
    console.log(`    Winners  (n=${winVals.length}):  median=${stats.winMedian.toFixed(2)}, IQR=[${stats.winP25.toFixed(2)}, ${stats.winP75.toFixed(2)}]`);
    console.log(`    Losers   (n=${loseVals.length}):  median=${stats.loseMedian.toFixed(2)}, IQR=[${stats.loseP25.toFixed(2)}, ${stats.loseP75.toFixed(2)}]`);
  }

  // ── 5b: Multi-factor combinations ──

  console.log('\n' + '─'.repeat(70));
  console.log('5b. MULTI-FACTOR INDICATOR COMBINATIONS');
  console.log('─'.repeat(70));

  function categorize(cycle: EnrichedCycle): string {
    const ind = cycle.entryIndicators!;
    const parts: string[] = [];

    // MACD
    if (ind.macdHist !== null) parts.push(ind.macdHist > 0 ? 'MACD+' : 'MACD-');

    // RSI zone
    if (ind.rsi14 !== null) {
      if (ind.rsi14 < 30) parts.push('RSI<30');
      else if (ind.rsi14 < 50) parts.push('RSI30-50');
      else if (ind.rsi14 < 70) parts.push('RSI50-70');
      else parts.push('RSI>70');
    }

    // BB position
    if (ind.bbPosition !== null) {
      if (ind.bbPosition < 0.2) parts.push('BB<0.2');
      else if (ind.bbPosition < 0.5) parts.push('BB0.2-0.5');
      else if (ind.bbPosition < 0.8) parts.push('BB0.5-0.8');
      else parts.push('BB>0.8');
    }

    // EMA alignment
    if (ind.ema9 !== null && ind.ema21 !== null) {
      parts.push(ind.ema9 > ind.ema21 ? 'EMA+' : 'EMA-');
    }

    // BTC regime
    parts.push('BTC:' + ind.btcMacroRegime);

    // Momentum
    if (ind.priceChange1h !== null) {
      parts.push(ind.priceChange1h > 0.5 ? 'Mom+' : ind.priceChange1h < -0.5 ? 'Mom-' : 'Mom=');
    }

    return parts.join('|');
  }

  const comboCounts = new Map<string, { wins: number; total: number; totalPnl: number }>();

  for (const cycle of valid) {
    const combo = categorize(cycle);
    const entry = comboCounts.get(combo) || { wins: 0, total: 0, totalPnl: 0 };
    entry.total++;
    if (cycle.pnlPct > 0) entry.wins++;
    entry.totalPnl += cycle.pnlPct;
    comboCounts.set(combo, entry);
  }

  const sortedCombos = [...comboCounts.entries()]
    .filter(([_, d]) => d.total >= 5)
    .sort((a, b) => (b[1].totalPnl / b[1].total) - (a[1].totalPnl / a[1].total));

  console.log(`\n  Top combinations (min 5 samples, by avg P&L):`);
  console.log(`  ${'Combination'.padEnd(50)} ${'N'.padStart(5)} ${'Win%'.padStart(6)} ${'AvgP&L'.padStart(8)}`);
  console.log('  ' + '─'.repeat(72));

  for (const [combo, data] of sortedCombos.slice(0, 20)) {
    const wr = (data.wins / data.total * 100).toFixed(0);
    const avgPnl = (data.totalPnl / data.total).toFixed(2);
    console.log(`  ${combo.padEnd(50)} ${String(data.total).padStart(5)} ${(wr + '%').padStart(6)} ${(avgPnl + '%').padStart(8)}`);
  }

  console.log('\n  Worst combinations:');
  for (const [combo, data] of sortedCombos.slice(-10)) {
    const wr = (data.wins / data.total * 100).toFixed(0);
    const avgPnl = (data.totalPnl / data.total).toFixed(2);
    console.log(`  ${combo.padEnd(50)} ${String(data.total).padStart(5)} ${(wr + '%').padStart(6)} ${(avgPnl + '%').padStart(8)}`);
  }

  // ── 5c: Exit signal analysis ──

  console.log('\n' + '─'.repeat(70));
  console.log('5c. EXIT SIGNAL ANALYSIS');
  console.log('─'.repeat(70));

  const validExits = valid.filter(c => c.exitIndicators);

  for (const { key, label } of indicatorKeys) {
    const profitExitVals = validExits.filter(c => c.pnlPct > 0).map(c => c.exitIndicators![key]).filter(v => v !== null && isFinite(v as number)) as number[];
    const lossExitVals = validExits.filter(c => c.pnlPct <= 0).map(c => c.exitIndicators![key]).filter(v => v !== null && isFinite(v as number)) as number[];

    if (profitExitVals.length < 5 || lossExitVals.length < 5) continue;

    console.log(`  ${label} at exit:`);
    console.log(`    Profit exits: median=${median(profitExitVals).toFixed(2)}, IQR=[${percentile(profitExitVals, 25).toFixed(2)}, ${percentile(profitExitVals, 75).toFixed(2)}]`);
    console.log(`    Loss exits:   median=${median(lossExitVals).toFixed(2)}, IQR=[${percentile(lossExitVals, 25).toFixed(2)}, ${percentile(lossExitVals, 75).toFixed(2)}]`);
  }

  // ── 5d: Position sizing ──

  console.log('\n' + '─'.repeat(70));
  console.log('5d. POSITION SIZING');
  console.log('─'.repeat(70));

  const singleFill = valid.filter(c => c.entryFillCount === 1);
  const multiFill = valid.filter(c => c.entryFillCount > 1);
  const heavyTwap = valid.filter(c => c.entryFillCount >= 5);

  console.log(`  Single-fill entries: ${singleFill.length}, win rate: ${singleFill.length > 0 ? (singleFill.filter(c => c.pnlPct > 0).length / singleFill.length * 100).toFixed(1) : 0}%, avg P&L: ${avg(singleFill.map(c => c.pnlPct)).toFixed(2)}%`);
  console.log(`  Multi-fill (TWAP):   ${multiFill.length}, win rate: ${multiFill.length > 0 ? (multiFill.filter(c => c.pnlPct > 0).length / multiFill.length * 100).toFixed(1) : 0}%, avg P&L: ${avg(multiFill.map(c => c.pnlPct)).toFixed(2)}%`);
  console.log(`  Heavy TWAP (5+):     ${heavyTwap.length}, win rate: ${heavyTwap.length > 0 ? (heavyTwap.filter(c => c.pnlPct > 0).length / heavyTwap.length * 100).toFixed(1) : 0}%, avg P&L: ${avg(heavyTwap.map(c => c.pnlPct)).toFixed(2)}%`);

  // ── 5e: Symbol performance ──

  console.log('\n' + '─'.repeat(70));
  console.log('5e. SYMBOL PERFORMANCE');
  console.log('─'.repeat(70));

  const symPerf = new Map<string, { n: number; wins: number; totalPnl: number; avgHold: number }>();
  for (const c of valid) {
    const s = symPerf.get(c.symbol) || { n: 0, wins: 0, totalPnl: 0, avgHold: 0 };
    s.n++;
    if (c.pnlPct > 0) s.wins++;
    s.totalPnl += c.pnlPct;
    s.avgHold += c.holdTimeH;
    symPerf.set(c.symbol, s);
  }

  const sortedSymPerf = [...symPerf.entries()]
    .filter(([_, d]) => d.n >= 3)
    .sort((a, b) => (b[1].totalPnl / b[1].n) - (a[1].totalPnl / a[1].n));

  console.log(`  ${'Symbol'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(6)} ${'AvgP&L'.padStart(8)} ${'AvgHold'.padStart(8)}`);
  console.log('  ' + '─'.repeat(42));

  for (const [sym, d] of sortedSymPerf.slice(0, 25)) {
    console.log(`  ${sym.padEnd(12)} ${String(d.n).padStart(5)} ${((d.wins / d.n * 100).toFixed(0) + '%').padStart(6)} ${((d.totalPnl / d.n).toFixed(2) + '%').padStart(8)} ${((d.avgHold / d.n).toFixed(1) + 'h').padStart(8)}`);
  }

  // ── 5f: Session & timing ──

  console.log('\n' + '─'.repeat(70));
  console.log('5f. SESSION & TIMING');
  console.log('─'.repeat(70));

  for (const session of ['asia', 'europe', 'us']) {
    const sc = valid.filter(c => c.entrySession === session);
    if (sc.length < 3) continue;
    const wr = sc.filter(c => c.pnlPct > 0).length / sc.length * 100;
    const ap = avg(sc.map(c => c.pnlPct));
    const longPct = sc.filter(c => c.direction === 'long').length / sc.length * 100;
    console.log(`  ${session.padEnd(8)} n=${sc.length}, win rate: ${wr.toFixed(1)}%, avg P&L: ${ap.toFixed(2)}%, long: ${longPct.toFixed(0)}%`);
  }

  // By direction
  console.log('');
  for (const dir of ['long', 'short'] as const) {
    const dc = valid.filter(c => c.direction === dir);
    if (dc.length < 3) continue;
    const wr = dc.filter(c => c.pnlPct > 0).length / dc.length * 100;
    console.log(`  ${dir.padEnd(8)} n=${dc.length}, win rate: ${wr.toFixed(1)}%, avg P&L: ${avg(dc.map(c => c.pnlPct)).toFixed(2)}%`);
  }

  // ── 5g: BTC correlation ──

  console.log('\n' + '─'.repeat(70));
  console.log('5g. BTC MACRO REGIME CORRELATION');
  console.log('─'.repeat(70));

  for (const regime of ['bull', 'bear', 'neutral'] as const) {
    const rc = valid.filter(c => c.entryIndicators?.btcMacroRegime === regime);
    if (rc.length < 3) continue;
    const wr = rc.filter(c => c.pnlPct > 0).length / rc.length * 100;
    const longPct = rc.filter(c => c.direction === 'long').length / rc.length * 100;
    console.log(`  ${regime.padEnd(8)} n=${rc.length}, win rate: ${wr.toFixed(1)}%, avg P&L: ${avg(rc.map(c => c.pnlPct)).toFixed(2)}%, long: ${longPct.toFixed(0)}%`);
  }

  return {
    totalCycles: cycles.length,
    analyzable: valid.length,
    winRate: winners.length / valid.length,
    avgPnl: avg(valid.map(c => c.pnlPct)),
    indicatorStats,
    topCombos: sortedCombos.slice(0, 20).map(([combo, d]) => ({
      combo, n: d.total, winRate: d.wins / d.total, avgPnl: d.totalPnl / d.total,
    })),
    symbolPerformance: sortedSymPerf.map(([sym, d]) => ({
      symbol: sym, n: d.n, winRate: d.wins / d.n, avgPnl: d.totalPnl / d.n,
    })),
  };
}

// ═══════════════════════════════════════════════════════
// STEP 6: OUTPUT
// ═══════════════════════════════════════════════════════

async function saveOutput(cycles: EnrichedCycle[], analysisResults: any): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 6: SAVE OUTPUT');
  console.log('═'.repeat(70));

  const outputDir = path.join(__dirname, 'output');

  // Save enriched cycles
  const cyclesPath = path.join(outputDir, 'enriched-cycles.json');
  fs.writeFileSync(cyclesPath, JSON.stringify(cycles, null, 2));
  console.log(`  Saved ${cycles.length} enriched cycles to ${cyclesPath}`);

  // Save trading rules
  const rulesPath = path.join(outputDir, 'trading-rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify(analysisResults, null, 2));
  console.log(`  Saved trading rules to ${rulesPath}`);

  // Save to DB
  try {
    const saved = await prisma.analysisReport.create({
      data: {
        type: 'historical-trade-analysis-jan-mar-2026',
        timestamp: new Date(),
        data: analysisResults as any,
        summary: `Analysis of ${cycles.length} position cycles from Jan 1 - Mar 10, 2026. ${analysisResults.analyzable} with indicator data. Win rate: ${(analysisResults.winRate * 100).toFixed(1)}%, avg P&L: ${analysisResults.avgPnl.toFixed(2)}%.`,
      },
    });
    console.log(`  Saved to AnalysisReport: ${saved.id}`);
  } catch (error: any) {
    console.log(`  DB save failed: ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HISTORICAL TRADE ANALYSIS — Target Vault Strategy Extraction       ║');
  console.log('║  Vault: 0x4cb5...49f0 | Period: Jan 1 - Mar 10, 2026               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Step 1: Verify and backfill fills
  const fills = await verifyAndBackfillFills();
  if (fills.length === 0) {
    console.log('No fills found. Exiting.');
    return;
  }

  // Step 2: Reconstruct position cycles
  const cycles = reconstructCycles(fills);
  if (cycles.length === 0) {
    console.log('No cycles reconstructed. Exiting.');
    return;
  }

  // Step 3: Fetch historical candles
  const uniqueSymbols = [...new Set(cycles.map(c => c.symbol))];
  await fetchHistoricalCandles(uniqueSymbols);

  // Step 4: Compute indicators at entry/exit
  await computeIndicators(cycles);

  // Step 5: Statistical analysis
  const analysisResults = runAnalysis(cycles);

  // Step 6: Save output
  await saveOutput(cycles, analysisResults);

  console.log('\n' + '═'.repeat(70));
  console.log('DONE');
  console.log('═'.repeat(70));

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
