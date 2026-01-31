/**
 * Deep Strategy Analysis
 *
 * Analyzes entry/exit patterns, hold times, and position evolution
 * to understand the target vault's actual trading strategy.
 *
 * Usage: npx ts-node scripts/ml/deep-strategy-analysis.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_TRADER = process.env.COPY_TRADER;

async function main() {
  console.log('═'.repeat(70));
  console.log('🔬 DEEP STRATEGY ANALYSIS');
  console.log('═'.repeat(70));

  // === 1. Trade-Level Analysis (Entry to Exit) ===
  await tradeAnalysis();

  // === 2. Position Building Patterns ===
  await positionBuildingPatterns();

  // === 3. Entry Timing Relative to Price Movement ===
  await entryTimingAnalysis();

  // === 4. BTC Correlation Analysis ===
  await btcCorrelationAnalysis();

  // === 5. Symbol Rotation Patterns ===
  await symbolRotationAnalysis();

  // === 6. Session-Based Performance ===
  await sessionPerformanceAnalysis();

  await prisma.$disconnect();
  await pool.end();
}

async function tradeAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('📊 TRADE-LEVEL ANALYSIS (Entry → Exit)');
  console.log('─'.repeat(70));

  const trades = await prisma.trade.findMany({
    where: {
      trader: 'target',
      exitPrice: { not: null },
      holdTimeSeconds: { not: null },
    },
    select: {
      symbol: true,
      side: true,
      entryPrice: true,
      exitPrice: true,
      size: true,
      leverage: true,
      pnl: true,
      pnlPercent: true,
      holdTimeSeconds: true,
      isTwapOrder: true,
      fillCount: true,
    },
  });

  if (trades.length === 0) {
    console.log('  No completed trades with exit data found.');
    console.log('  This is normal if we\'re only tracking fills, not full trade lifecycle.');
    return;
  }

  console.log(`\nAnalyzing ${trades.length} completed trades...\n`);

  // Hold time distribution
  const holdTimes = trades.map(t => t.holdTimeSeconds!).filter(h => h > 0);
  if (holdTimes.length > 0) {
    holdTimes.sort((a, b) => a - b);
    const median = holdTimes[Math.floor(holdTimes.length / 2)];
    const avg = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
    const p25 = holdTimes[Math.floor(holdTimes.length * 0.25)];
    const p75 = holdTimes[Math.floor(holdTimes.length * 0.75)];

    console.log('Hold Time Distribution:');
    console.log(`  Median:   ${formatDuration(median)}`);
    console.log(`  Average:  ${formatDuration(avg)}`);
    console.log(`  25th %:   ${formatDuration(p25)}`);
    console.log(`  75th %:   ${formatDuration(p75)}`);

    // Buckets
    console.log('\nHold Time Buckets:');
    const buckets = [
      { min: 0, max: 60, label: '< 1 min' },
      { min: 60, max: 300, label: '1-5 min' },
      { min: 300, max: 900, label: '5-15 min' },
      { min: 900, max: 3600, label: '15-60 min' },
      { min: 3600, max: 14400, label: '1-4 hours' },
      { min: 14400, max: 86400, label: '4-24 hours' },
      { min: 86400, max: Infinity, label: '> 24 hours' },
    ];

    for (const bucket of buckets) {
      const count = holdTimes.filter(h => h >= bucket.min && h < bucket.max).length;
      const pct = ((count / holdTimes.length) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round((count / holdTimes.length) * 40));
      console.log(`  ${bucket.label.padEnd(14)} ${bar} ${count} (${pct}%)`);
    }
  }

  // Win rate by hold time
  const tradesWithPnl = trades.filter(t => t.pnlPercent !== null);
  if (tradesWithPnl.length > 0) {
    console.log('\nPerformance:');
    const wins = tradesWithPnl.filter(t => (t.pnlPercent ?? 0) > 0);
    const winRate = (wins.length / tradesWithPnl.length) * 100;
    const avgPnl = tradesWithPnl.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0) / tradesWithPnl.length;

    console.log(`  Win rate:   ${winRate.toFixed(1)}%`);
    console.log(`  Avg P&L:    ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
  }
}

async function positionBuildingPatterns() {
  console.log('\n' + '─'.repeat(70));
  console.log('🔨 POSITION BUILDING PATTERNS');
  console.log('─'.repeat(70));

  // Analyze how positions are built over time using fills
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: {
      timestamp: true,
      symbol: true,
      side: true,
      size: true,
      price: true,
      positionSzi: true, // Signed position size after fill
    },
    orderBy: { timestamp: 'asc' },
  });

  if (fills.length < 100) {
    console.log('  Not enough fill data for pattern analysis');
    return;
  }

  // Track position changes per symbol
  const symbolPositions = new Map<string, {
    fills: typeof fills;
    direction: string;
    buildups: number;
    reductions: number;
  }>();

  for (const fill of fills) {
    if (!symbolPositions.has(fill.symbol)) {
      symbolPositions.set(fill.symbol, {
        fills: [],
        direction: '',
        buildups: 0,
        reductions: 0,
      });
    }
    const pos = symbolPositions.get(fill.symbol)!;
    pos.fills.push(fill);

    // Determine if this fill is building or reducing
    const prevFill = pos.fills.length > 1 ? pos.fills[pos.fills.length - 2] : null;
    if (prevFill) {
      const prevPos = Math.abs(prevFill.positionSzi);
      const newPos = Math.abs(fill.positionSzi);
      if (newPos > prevPos) pos.buildups++;
      else if (newPos < prevPos) pos.reductions++;
    }
  }

  // Analyze patterns across symbols
  let totalBuildups = 0;
  let totalReductions = 0;

  for (const [, data] of symbolPositions) {
    totalBuildups += data.buildups;
    totalReductions += data.reductions;
  }

  const buildRatio = totalBuildups / (totalBuildups + totalReductions);
  console.log(`\nPosition Change Patterns:`);
  console.log(`  Buildups (increasing):   ${totalBuildups} (${(buildRatio * 100).toFixed(1)}%)`);
  console.log(`  Reductions (decreasing): ${totalReductions} (${((1 - buildRatio) * 100).toFixed(1)}%)`);

  // Analyze accumulation sequences (consecutive buys)
  console.log('\nAccumulation Behavior:');

  let maxConsecutive = 0;
  let currentConsecutive = 0;
  let lastSide = '';
  let lastSymbol = '';
  const consecutiveSequences: number[] = [];

  for (const fill of fills) {
    if (fill.symbol === lastSymbol && fill.side === lastSide) {
      currentConsecutive++;
    } else {
      if (currentConsecutive > 1) {
        consecutiveSequences.push(currentConsecutive);
      }
      currentConsecutive = 1;
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    lastSide = fill.side;
    lastSymbol = fill.symbol;
  }

  if (consecutiveSequences.length > 0) {
    const avgSequence = consecutiveSequences.reduce((a, b) => a + b, 0) / consecutiveSequences.length;
    console.log(`  Avg consecutive same-direction fills: ${avgSequence.toFixed(1)}`);
    console.log(`  Max consecutive same-direction fills: ${maxConsecutive}`);
    console.log(`  Number of accumulation sequences:     ${consecutiveSequences.length}`);
  }
}

async function entryTimingAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('⏱️  ENTRY TIMING VS PRICE MOVEMENT');
  console.log('─'.repeat(70));

  // Get fills grouped by symbol
  const topSymbols = ['HYPE', 'VVV', 'SKY', 'SPX', 'BTC'];

  for (const symbol of topSymbols) {
    const fills = await prisma.fill.findMany({
      where: { traderAddress: TARGET_TRADER, symbol },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, side: true, price: true, size: true },
      take: 500,
    });

    if (fills.length < 10) continue;

    // Analyze: Are they buying dips or breakouts?
    // Compare entry price to recent price range
    let dipBuys = 0;
    let breakoutBuys = 0;
    let dipSells = 0;
    let breakoutSells = 0;

    for (let i = 10; i < fills.length; i++) {
      const fill = fills[i];
      const recentPrices = fills.slice(i - 10, i).map(f => f.price);
      const recentHigh = Math.max(...recentPrices);
      const recentLow = Math.min(...recentPrices);
      const range = recentHigh - recentLow;

      if (range === 0) continue;

      const position = (fill.price - recentLow) / range;

      if (fill.side === 'B') {
        if (position < 0.3) dipBuys++;
        else if (position > 0.7) breakoutBuys++;
      } else {
        if (position > 0.7) dipSells++; // Selling at highs
        else if (position < 0.3) breakoutSells++; // Selling at lows (stops)
      }
    }

    const totalBuys = dipBuys + breakoutBuys;
    const totalSells = dipSells + breakoutSells;

    if (totalBuys > 5 || totalSells > 5) {
      console.log(`\n${symbol}:`);
      if (totalBuys > 5) {
        console.log(`  Buys at dips (lower 30%):      ${dipBuys} (${((dipBuys / totalBuys) * 100).toFixed(0)}%)`);
        console.log(`  Buys at breakouts (upper 30%): ${breakoutBuys} (${((breakoutBuys / totalBuys) * 100).toFixed(0)}%)`);
      }
      if (totalSells > 5) {
        console.log(`  Sells at highs (upper 30%):    ${dipSells} (${((dipSells / totalSells) * 100).toFixed(0)}%)`);
        console.log(`  Sells at lows (lower 30%):     ${breakoutSells} (${((breakoutSells / totalSells) * 100).toFixed(0)}%)`);
      }
    }
  }
}

async function btcCorrelationAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('₿ BTC CORRELATION ANALYSIS');
  console.log('─'.repeat(70));

  // Get BTC fills for reference
  const btcFills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER, symbol: 'BTC' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true, side: true },
    take: 100,
  });

  // Get non-BTC fills around the same time
  const altFills = await prisma.fill.findMany({
    where: {
      traderAddress: TARGET_TRADER,
      symbol: { notIn: ['BTC', 'ETH'] },
    },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true, symbol: true, side: true },
    take: 5000,
  });

  if (btcFills.length < 10) {
    console.log('  Not enough BTC fills for correlation analysis');
    return;
  }

  // Analyze: Do they buy alts when buying BTC? Or inverse?
  let sameDirection = 0;
  let oppositeDirection = 0;

  for (const btcFill of btcFills) {
    // Find alt fills within 5 minutes of BTC fill
    const windowStart = btcFill.timestamp.getTime() - 5 * 60 * 1000;
    const windowEnd = btcFill.timestamp.getTime() + 5 * 60 * 1000;

    const nearbyAltFills = altFills.filter(f =>
      f.timestamp.getTime() >= windowStart && f.timestamp.getTime() <= windowEnd
    );

    for (const altFill of nearbyAltFills) {
      if (altFill.side === btcFill.side) sameDirection++;
      else oppositeDirection++;
    }
  }

  const total = sameDirection + oppositeDirection;
  if (total > 0) {
    console.log(`\nAlt trades within 5 min of BTC trades:`);
    console.log(`  Same direction as BTC:     ${sameDirection} (${((sameDirection / total) * 100).toFixed(1)}%)`);
    console.log(`  Opposite direction:        ${oppositeDirection} (${((oppositeDirection / total) * 100).toFixed(1)}%)`);
  }

  // Check if they trade more during BTC moves
  const btcCandles = await prisma.candle.findMany({
    where: { symbol: 'BTC', timeframe: '1h' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true, open: true, close: true },
    take: 200,
  });

  if (btcCandles.length > 50) {
    let tradesInBigMoves = 0;
    let tradesInSmallMoves = 0;

    for (const candle of btcCandles) {
      const movePercent = Math.abs((candle.close - candle.open) / candle.open) * 100;
      const hourStart = candle.timestamp.getTime();
      const hourEnd = hourStart + 60 * 60 * 1000;

      const tradesInHour = altFills.filter(f =>
        f.timestamp.getTime() >= hourStart && f.timestamp.getTime() < hourEnd
      ).length;

      if (movePercent > 1) {
        tradesInBigMoves += tradesInHour;
      } else {
        tradesInSmallMoves += tradesInHour;
      }
    }

    const bigMoveHours = btcCandles.filter(c =>
      Math.abs((c.close - c.open) / c.open) * 100 > 1
    ).length;
    const smallMoveHours = btcCandles.length - bigMoveHours;

    if (bigMoveHours > 0 && smallMoveHours > 0) {
      const avgTradesInBigMove = tradesInBigMoves / bigMoveHours;
      const avgTradesInSmallMove = tradesInSmallMoves / smallMoveHours;

      console.log(`\nTrading Activity vs BTC Volatility:`);
      console.log(`  Avg trades/hour when BTC moves >1%: ${avgTradesInBigMove.toFixed(1)}`);
      console.log(`  Avg trades/hour when BTC moves <1%: ${avgTradesInSmallMove.toFixed(1)}`);

      if (avgTradesInBigMove > avgTradesInSmallMove * 1.2) {
        console.log('  → More active during volatile BTC periods');
      } else if (avgTradesInSmallMove > avgTradesInBigMove * 1.2) {
        console.log('  → More active during calm BTC periods');
      } else {
        console.log('  → Activity independent of BTC volatility');
      }
    }
  }
}

async function symbolRotationAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('🔄 SYMBOL ROTATION PATTERNS');
  console.log('─'.repeat(70));

  // Analyze how they rotate between symbols
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, symbol: true },
  });

  if (fills.length < 100) {
    console.log('  Not enough data for rotation analysis');
    return;
  }

  // Group by day
  const daySymbols = new Map<string, Set<string>>();
  for (const fill of fills) {
    const day = fill.timestamp.toISOString().split('T')[0];
    if (!daySymbols.has(day)) daySymbols.set(day, new Set());
    daySymbols.get(day)!.add(fill.symbol);
  }

  const symbolCountsPerDay = Array.from(daySymbols.values()).map(s => s.size);
  const avgSymbolsPerDay = symbolCountsPerDay.reduce((a, b) => a + b, 0) / symbolCountsPerDay.length;
  const maxSymbolsPerDay = Math.max(...symbolCountsPerDay);

  console.log(`\nSymbol Diversity:`);
  console.log(`  Avg unique symbols per day: ${avgSymbolsPerDay.toFixed(1)}`);
  console.log(`  Max unique symbols per day: ${maxSymbolsPerDay}`);

  // Find symbols that appear together frequently
  console.log(`\nSymbol Co-occurrence (same day):`);
  const coOccurrence = new Map<string, Map<string, number>>();

  for (const [, symbols] of daySymbols) {
    const symbolArray = Array.from(symbols);
    for (let i = 0; i < symbolArray.length; i++) {
      for (let j = i + 1; j < symbolArray.length; j++) {
        const s1 = symbolArray[i];
        const s2 = symbolArray[j];
        const key = [s1, s2].sort().join('|');

        if (!coOccurrence.has(key)) {
          coOccurrence.set(key, new Map([[s1, 0], [s2, 0]]));
        }
        const pair = coOccurrence.get(key)!;
        pair.set(s1, (pair.get(s1) ?? 0) + 1);
      }
    }
  }

  // Find top pairs
  const pairs = Array.from(coOccurrence.entries())
    .map(([key, ]) => {
      const [s1, s2] = key.split('|');
      const days = Array.from(daySymbols.values()).filter(
        symbols => symbols.has(s1) && symbols.has(s2)
      ).length;
      return { s1, s2, days };
    })
    .filter(p => p.days >= 5)
    .sort((a, b) => b.days - a.days)
    .slice(0, 10);

  for (const pair of pairs) {
    console.log(`  ${pair.s1} + ${pair.s2}: ${pair.days} days together`);
  }

  // Consecutive symbol switches
  let switches = 0;
  let sameSymbol = 0;
  for (let i = 1; i < fills.length; i++) {
    if (fills[i].symbol !== fills[i - 1].symbol) switches++;
    else sameSymbol++;
  }

  const switchRate = (switches / (switches + sameSymbol)) * 100;
  console.log(`\nTrade-to-Trade Symbol Switches: ${switchRate.toFixed(1)}%`);
}

async function sessionPerformanceAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('🌍 SESSION-BASED ANALYSIS');
  console.log('─'.repeat(70));

  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true, symbol: true, side: true, size: true, price: true },
  });

  if (fills.length < 100) {
    console.log('  Not enough data');
    return;
  }

  // Define sessions (UTC)
  const sessions = [
    { name: 'Asia', start: 0, end: 8 },
    { name: 'Europe', start: 8, end: 16 },
    { name: 'US', start: 16, end: 24 },
  ];

  console.log('\nFills by Session:');
  for (const session of sessions) {
    const sessionFills = fills.filter(f => {
      const hour = f.timestamp.getUTCHours();
      if (session.end > session.start) {
        return hour >= session.start && hour < session.end;
      } else {
        return hour >= session.start || hour < session.end;
      }
    });

    const buys = sessionFills.filter(f => f.side === 'B').length;
    const sells = sessionFills.filter(f => f.side === 'A').length;
    const buyRatio = sessionFills.length > 0 ? ((buys / sessionFills.length) * 100).toFixed(0) : '0';

    console.log(`  ${session.name.padEnd(8)} ${sessionFills.length.toString().padStart(6)} fills (${buyRatio}% buys)`);
  }

  // Volume by session
  console.log('\nNotional Volume by Session:');
  for (const session of sessions) {
    const sessionFills = fills.filter(f => {
      const hour = f.timestamp.getUTCHours();
      if (session.end > session.start) {
        return hour >= session.start && hour < session.end;
      } else {
        return hour >= session.start || hour < session.end;
      }
    });

    const volume = sessionFills.reduce((sum, f) => sum + Math.abs(f.size * f.price), 0);
    console.log(`  ${session.name.padEnd(8)} $${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
