/**
 * Target Vault Strategy Analysis
 *
 * Analyzes the target vault's trading patterns to understand their strategy.
 *
 * Usage: npx ts-node scripts/ml/strategy-analysis.ts
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

interface SymbolStats {
  symbol: string;
  tradeCount: number;
  longCount: number;
  shortCount: number;
  avgLeverage: number;
  avgSize: number;
  avgHoldTime: number;
  winRate: number;
  avgPnlPct: number;
  totalPnl: number;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('🎯 TARGET VAULT STRATEGY ANALYSIS');
  console.log('═'.repeat(70));
  console.log(`Target: ${TARGET_TRADER}\n`);

  // === 1. Data Overview ===
  await dataOverview();

  // === 2. Symbol Analysis ===
  await symbolAnalysis();

  // === 3. Timing Analysis ===
  await timingAnalysis();

  // === 4. Position Sizing Patterns ===
  await positionSizingAnalysis();

  // === 5. Leverage Patterns ===
  await leverageAnalysis();

  // === 6. Technical Entry Analysis ===
  await technicalEntryAnalysis();

  // === 7. Trade Behavior Patterns ===
  await tradeBehaviorPatterns();

  // === 8. Fill-Level TWAP Analysis ===
  await twapAnalysis();

  // === 9. Performance Summary ===
  await performanceSummary();

  await prisma.$disconnect();
  await pool.end();
}

async function dataOverview() {
  console.log('\n' + '─'.repeat(70));
  console.log('📊 DATA OVERVIEW');
  console.log('─'.repeat(70));

  const tradeCount = await prisma.trade.count({
    where: { trader: 'target' }
  });

  const fillCount = await prisma.fill.count({
    where: { traderAddress: TARGET_TRADER }
  });

  const predictionCount = await prisma.prediction.count();

  const dateRange = await prisma.fill.aggregate({
    where: { traderAddress: TARGET_TRADER },
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  const symbols = await prisma.fill.groupBy({
    by: ['symbol'],
    where: { traderAddress: TARGET_TRADER },
  });

  console.log(`  Trades logged:        ${tradeCount.toLocaleString()}`);
  console.log(`  Fills logged:         ${fillCount.toLocaleString()}`);
  console.log(`  Predictions:          ${predictionCount.toLocaleString()}`);
  console.log(`  Unique symbols:       ${symbols.length}`);

  if (dateRange._min.timestamp && dateRange._max.timestamp) {
    const days = Math.ceil(
      (dateRange._max.timestamp.getTime() - dateRange._min.timestamp.getTime()) / (1000 * 60 * 60 * 24)
    );
    console.log(`  Date range:           ${dateRange._min.timestamp.toISOString().split('T')[0]} → ${dateRange._max.timestamp.toISOString().split('T')[0]} (${days} days)`);
  }
}

async function symbolAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('📈 SYMBOL ANALYSIS (by fill count)');
  console.log('─'.repeat(70));

  const symbolFills = await prisma.fill.groupBy({
    by: ['symbol'],
    where: { traderAddress: TARGET_TRADER },
    _count: true,
    _avg: { size: true, price: true },
    orderBy: { _count: { symbol: 'desc' } },
    take: 20,
  });

  // Get side distribution per symbol
  console.log('\nSymbol'.padEnd(12) + 'Fills'.padStart(8) + 'Buys'.padStart(8) + 'Sells'.padStart(8) + 'Avg Size'.padStart(12) + 'Avg Price'.padStart(14));
  console.log('─'.repeat(62));

  for (const s of symbolFills) {
    const buys = await prisma.fill.count({
      where: { traderAddress: TARGET_TRADER, symbol: s.symbol, side: 'B' }
    });
    const sells = await prisma.fill.count({
      where: { traderAddress: TARGET_TRADER, symbol: s.symbol, side: 'A' }
    });

    console.log(
      `${s.symbol.padEnd(12)}${s._count.toString().padStart(8)}${buys.toString().padStart(8)}${sells.toString().padStart(8)}${(s._avg.size?.toFixed(4) ?? '-').padStart(12)}${(s._avg.price?.toFixed(2) ?? '-').padStart(14)}`
    );
  }

  // Calculate concentration
  const totalFills = symbolFills.reduce((sum, s) => sum + s._count, 0);
  const top5Fills = symbolFills.slice(0, 5).reduce((sum, s) => sum + s._count, 0);
  console.log(`\n  Top 5 concentration:  ${((top5Fills / totalFills) * 100).toFixed(1)}% of all fills`);
}

async function timingAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('⏰ TIMING ANALYSIS');
  console.log('─'.repeat(70));

  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true },
  });

  // Hour of day distribution
  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const fill of fills) {
    hourCounts[fill.timestamp.getUTCHours()]++;
    dayCounts[fill.timestamp.getUTCDay()]++;
  }

  console.log('\nHour of Day (UTC):');
  const maxHourCount = Math.max(...hourCounts);
  for (let h = 0; h < 24; h++) {
    const bar = '█'.repeat(Math.round((hourCounts[h] / maxHourCount) * 30));
    console.log(`  ${h.toString().padStart(2)}:00  ${bar} ${hourCounts[h]}`);
  }

  // Find peak hours
  const sortedHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count);
  const peakHours = sortedHours.slice(0, 5).map(h => `${h.hour}:00`);
  console.log(`\n  Peak trading hours:   ${peakHours.join(', ')} UTC`);

  // Day of week
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log('\nDay of Week:');
  const maxDayCount = Math.max(...dayCounts);
  for (let d = 0; d < 7; d++) {
    const bar = '█'.repeat(Math.round((dayCounts[d] / maxDayCount) * 30));
    console.log(`  ${days[d]}  ${bar} ${dayCounts[d]}`);
  }
}

async function positionSizingAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('📏 POSITION SIZING PATTERNS');
  console.log('─'.repeat(70));

  // Analyze position sizes from fills
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { symbol: true, size: true, price: true, positionSzi: true },
  });

  if (fills.length === 0) {
    console.log('  No fill data available');
    return;
  }

  // Calculate USD notional values
  const notionalValues = fills.map(f => Math.abs(f.size * f.price));
  notionalValues.sort((a, b) => a - b);

  const min = notionalValues[0];
  const max = notionalValues[notionalValues.length - 1];
  const median = notionalValues[Math.floor(notionalValues.length / 2)];
  const avg = notionalValues.reduce((a, b) => a + b, 0) / notionalValues.length;
  const p25 = notionalValues[Math.floor(notionalValues.length * 0.25)];
  const p75 = notionalValues[Math.floor(notionalValues.length * 0.75)];

  console.log('\nFill Size Distribution (USD notional):');
  console.log(`  Min:      $${min.toFixed(2)}`);
  console.log(`  25th %:   $${p25.toFixed(2)}`);
  console.log(`  Median:   $${median.toFixed(2)}`);
  console.log(`  75th %:   $${p75.toFixed(2)}`);
  console.log(`  Max:      $${max.toFixed(2)}`);
  console.log(`  Average:  $${avg.toFixed(2)}`);

  // Size buckets
  console.log('\nSize Buckets:');
  const buckets = [
    { min: 0, max: 100, label: '$0-100' },
    { min: 100, max: 500, label: '$100-500' },
    { min: 500, max: 1000, label: '$500-1K' },
    { min: 1000, max: 5000, label: '$1K-5K' },
    { min: 5000, max: 10000, label: '$5K-10K' },
    { min: 10000, max: 50000, label: '$10K-50K' },
    { min: 50000, max: Infinity, label: '$50K+' },
  ];

  for (const bucket of buckets) {
    const count = notionalValues.filter(v => v >= bucket.min && v < bucket.max).length;
    const pct = ((count / notionalValues.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((count / notionalValues.length) * 40));
    console.log(`  ${bucket.label.padEnd(12)} ${bar} ${count} (${pct}%)`);
  }
}

async function leverageAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('⚡ LEVERAGE PATTERNS');
  console.log('─'.repeat(70));

  const trades = await prisma.trade.findMany({
    where: { trader: 'target', leverage: { not: null } },
    select: { symbol: true, leverage: true },
  });

  if (trades.length === 0) {
    console.log('  No leverage data in trades. Checking position snapshots...');

    const snapshots = await prisma.positionSnapshot.findMany({
      where: { traderAddress: TARGET_TRADER, leverage: { not: null } },
      select: { symbol: true, leverage: true },
    });

    if (snapshots.length > 0) {
      const leverages = snapshots.map(s => s.leverage!);
      const avg = leverages.reduce((a, b) => a + b, 0) / leverages.length;
      const max = Math.max(...leverages);
      console.log(`  Average leverage: ${avg.toFixed(1)}x`);
      console.log(`  Max leverage:     ${max.toFixed(1)}x`);

      // By symbol
      const bySymbol = new Map<string, number[]>();
      for (const s of snapshots) {
        if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
        bySymbol.get(s.symbol)!.push(s.leverage!);
      }

      console.log('\nAverage Leverage by Symbol (top 10):');
      const symbolAvgs = Array.from(bySymbol.entries())
        .map(([symbol, levs]) => ({
          symbol,
          avg: levs.reduce((a, b) => a + b, 0) / levs.length,
          count: levs.length,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      for (const s of symbolAvgs) {
        console.log(`  ${s.symbol.padEnd(12)} ${s.avg.toFixed(1)}x (${s.count} snapshots)`);
      }
    }
    return;
  }

  const leverages = trades.map(t => t.leverage!);
  const avg = leverages.reduce((a, b) => a + b, 0) / leverages.length;
  const max = Math.max(...leverages);

  console.log(`  Average leverage: ${avg.toFixed(1)}x`);
  console.log(`  Max leverage:     ${max.toFixed(1)}x`);
}

async function technicalEntryAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('📉 TECHNICAL ENTRY ANALYSIS');
  console.log('─'.repeat(70));

  // Get predictions with copyAction (these represent actual entries)
  const entries = await prisma.prediction.findMany({
    where: {
      copyAction: { in: ['open', 'flip'] },
      features: { not: null },
    },
    select: {
      symbol: true,
      copySide: true,
      features: true,
      prediction: true,
      direction: true,
    },
  });

  if (entries.length === 0) {
    console.log('  No entry data with features available yet.');
    console.log('  Keep running the bot to collect more data.');
    return;
  }

  console.log(`\nAnalyzing ${entries.length} entries with features...\n`);

  // Collect RSI values at entry
  const longRsis: number[] = [];
  const shortRsis: number[] = [];
  const allRsis: number[] = [];

  // Collect BB positions
  const longBBs: number[] = [];
  const shortBBs: number[] = [];

  for (const entry of entries) {
    const features = entry.features as any;
    if (!features) continue;

    const rsi = features.rsi14;
    const bbPos = features.bbPosition;

    if (typeof rsi === 'number') {
      allRsis.push(rsi);
      if (entry.copySide === 'long') longRsis.push(rsi);
      else if (entry.copySide === 'short') shortRsis.push(rsi);
    }

    if (typeof bbPos === 'number') {
      if (entry.copySide === 'long') longBBs.push(bbPos);
      else if (entry.copySide === 'short') shortBBs.push(bbPos);
    }
  }

  if (allRsis.length > 0) {
    console.log('RSI at Entry:');
    console.log(`  All entries:   avg ${(allRsis.reduce((a, b) => a + b, 0) / allRsis.length).toFixed(1)}`);
    if (longRsis.length > 0) {
      console.log(`  Long entries:  avg ${(longRsis.reduce((a, b) => a + b, 0) / longRsis.length).toFixed(1)} (${longRsis.length} trades)`);
    }
    if (shortRsis.length > 0) {
      console.log(`  Short entries: avg ${(shortRsis.reduce((a, b) => a + b, 0) / shortRsis.length).toFixed(1)} (${shortRsis.length} trades)`);
    }

    // RSI buckets
    console.log('\nRSI Distribution at Entry:');
    const rsiBuckets = [
      { min: 0, max: 30, label: 'Oversold (0-30)' },
      { min: 30, max: 50, label: 'Neutral-Low (30-50)' },
      { min: 50, max: 70, label: 'Neutral-High (50-70)' },
      { min: 70, max: 100, label: 'Overbought (70+)' },
    ];

    for (const bucket of rsiBuckets) {
      const count = allRsis.filter(r => r >= bucket.min && r < bucket.max).length;
      const pct = ((count / allRsis.length) * 100).toFixed(1);
      console.log(`  ${bucket.label.padEnd(22)} ${count} (${pct}%)`);
    }
  }

  if (longBBs.length > 0 || shortBBs.length > 0) {
    console.log('\nBollinger Band Position at Entry:');
    if (longBBs.length > 0) {
      const avg = longBBs.reduce((a, b) => a + b, 0) / longBBs.length;
      console.log(`  Longs:  avg BB position ${avg.toFixed(2)} (0=lower band, 1=upper band)`);
    }
    if (shortBBs.length > 0) {
      const avg = shortBBs.reduce((a, b) => a + b, 0) / shortBBs.length;
      console.log(`  Shorts: avg BB position ${avg.toFixed(2)}`);
    }
  }
}

async function tradeBehaviorPatterns() {
  console.log('\n' + '─'.repeat(70));
  console.log('🎯 TRADE BEHAVIOR PATTERNS');
  console.log('─'.repeat(70));

  // Analyze copy actions from predictions
  const actions = await prisma.prediction.groupBy({
    by: ['copyAction'],
    _count: true,
    orderBy: { _count: { copyAction: 'desc' } },
  });

  console.log('\nAction Distribution:');
  const totalActions = actions.reduce((sum, a) => sum + a._count, 0);
  for (const a of actions) {
    if (a.copyAction) {
      const pct = ((a._count / totalActions) * 100).toFixed(1);
      console.log(`  ${(a.copyAction).padEnd(12)} ${a._count.toString().padStart(6)} (${pct}%)`);
    }
  }

  // Direction bias
  const longs = await prisma.prediction.count({
    where: { copySide: 'long', copyAction: { not: 'none' } }
  });
  const shorts = await prisma.prediction.count({
    where: { copySide: 'short', copyAction: { not: 'none' } }
  });

  if (longs + shorts > 0) {
    console.log(`\nDirectional Bias:`);
    console.log(`  Longs:  ${longs} (${((longs / (longs + shorts)) * 100).toFixed(1)}%)`);
    console.log(`  Shorts: ${shorts} (${((shorts / (longs + shorts)) * 100).toFixed(1)}%)`);
  }

  // Trade frequency by day
  const predictions = await prisma.prediction.findMany({
    where: { copyAction: { not: 'none' } },
    select: { timestamp: true },
    orderBy: { timestamp: 'asc' },
  });

  if (predictions.length > 1) {
    const dayTrades = new Map<string, number>();
    for (const p of predictions) {
      const day = p.timestamp.toISOString().split('T')[0];
      dayTrades.set(day, (dayTrades.get(day) ?? 0) + 1);
    }

    const tradeCounts = Array.from(dayTrades.values());
    const avgPerDay = tradeCounts.reduce((a, b) => a + b, 0) / tradeCounts.length;
    const maxPerDay = Math.max(...tradeCounts);
    const minPerDay = Math.min(...tradeCounts);

    console.log(`\nTrade Frequency:`);
    console.log(`  Days with data: ${tradeCounts.length}`);
    console.log(`  Avg trades/day: ${avgPerDay.toFixed(1)}`);
    console.log(`  Min trades/day: ${minPerDay}`);
    console.log(`  Max trades/day: ${maxPerDay}`);
  }
}

async function twapAnalysis() {
  console.log('\n' + '─'.repeat(70));
  console.log('🔄 TWAP / EXECUTION ANALYSIS');
  console.log('─'.repeat(70));

  // Analyze fills to detect multi-fill orders
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true, symbol: true, side: true, size: true, price: true },
    orderBy: { timestamp: 'asc' },
  });

  if (fills.length < 10) {
    console.log('  Not enough fill data for TWAP analysis');
    return;
  }

  // Group fills that happen within 60 seconds on same symbol/side
  const clusters: { symbol: string; side: string; fills: typeof fills; }[] = [];
  let currentCluster: typeof fills = [];
  let lastFill: typeof fills[0] | null = null;

  for (const fill of fills) {
    if (
      lastFill &&
      fill.symbol === lastFill.symbol &&
      fill.side === lastFill.side &&
      fill.timestamp.getTime() - lastFill.timestamp.getTime() < 60000
    ) {
      currentCluster.push(fill);
    } else {
      if (currentCluster.length > 0) {
        clusters.push({
          symbol: currentCluster[0].symbol,
          side: currentCluster[0].side,
          fills: [...currentCluster],
        });
      }
      currentCluster = [fill];
    }
    lastFill = fill;
  }

  if (currentCluster.length > 0) {
    clusters.push({
      symbol: currentCluster[0].symbol,
      side: currentCluster[0].side,
      fills: [...currentCluster],
    });
  }

  const singleFills = clusters.filter(c => c.fills.length === 1).length;
  const multiFills = clusters.filter(c => c.fills.length > 1).length;
  const avgFillsPerOrder = fills.length / clusters.length;

  console.log(`\nExecution Pattern:`);
  console.log(`  Total fill events:     ${fills.length}`);
  console.log(`  Logical orders:        ${clusters.length}`);
  console.log(`  Single-fill orders:    ${singleFills} (${((singleFills / clusters.length) * 100).toFixed(1)}%)`);
  console.log(`  Multi-fill orders:     ${multiFills} (${((multiFills / clusters.length) * 100).toFixed(1)}%)`);
  console.log(`  Avg fills per order:   ${avgFillsPerOrder.toFixed(2)}`);

  // Analyze multi-fill orders
  const multiFillClusters = clusters.filter(c => c.fills.length > 1);
  if (multiFillClusters.length > 0) {
    const fillCounts = multiFillClusters.map(c => c.fills.length);
    const durations = multiFillClusters.map(c => {
      const first = c.fills[0].timestamp.getTime();
      const last = c.fills[c.fills.length - 1].timestamp.getTime();
      return (last - first) / 1000;
    });

    console.log(`\nMulti-Fill Order Details:`);
    console.log(`  Avg fills:      ${(fillCounts.reduce((a, b) => a + b, 0) / fillCounts.length).toFixed(1)}`);
    console.log(`  Max fills:      ${Math.max(...fillCounts)}`);
    console.log(`  Avg duration:   ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)}s`);
    console.log(`  Max duration:   ${Math.max(...durations).toFixed(1)}s`);
  }
}

async function performanceSummary() {
  console.log('\n' + '─'.repeat(70));
  console.log('💰 PERFORMANCE SUMMARY (from predictions)');
  console.log('─'.repeat(70));

  const validated = await prisma.prediction.findMany({
    where: {
      validatedAt: { not: null },
      paperPnlPct: { not: null },
      copyAction: { not: 'none' },
    },
    select: {
      symbol: true,
      copySide: true,
      paperPnlPct: true,
      correct: true,
    },
  });

  if (validated.length === 0) {
    console.log('  No validated predictions with P&L data yet.');
    console.log('  Keep running the bot to collect validation data.');
    return;
  }

  const wins = validated.filter(v => (v.paperPnlPct ?? 0) > 0);
  const losses = validated.filter(v => (v.paperPnlPct ?? 0) <= 0);

  const winRate = (wins.length / validated.length) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0) / losses.length : 0;
  const totalPnlPct = validated.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0);

  console.log(`\nOverall (${validated.length} validated trades):`);
  console.log(`  Win rate:       ${winRate.toFixed(1)}%`);
  console.log(`  Avg win:        +${avgWin.toFixed(3)}%`);
  console.log(`  Avg loss:       ${avgLoss.toFixed(3)}%`);
  console.log(`  Total P&L:      ${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(3)}%`);

  // Profit factor
  const grossProfit = wins.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0));
  if (grossLoss > 0) {
    console.log(`  Profit factor:  ${(grossProfit / grossLoss).toFixed(2)}`);
  }

  // By direction
  const longTrades = validated.filter(v => v.copySide === 'long');
  const shortTrades = validated.filter(v => v.copySide === 'short');

  if (longTrades.length > 0) {
    const longWinRate = (longTrades.filter(v => (v.paperPnlPct ?? 0) > 0).length / longTrades.length) * 100;
    const longPnl = longTrades.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0);
    console.log(`\nLongs (${longTrades.length}):`);
    console.log(`  Win rate:       ${longWinRate.toFixed(1)}%`);
    console.log(`  Total P&L:      ${longPnl >= 0 ? '+' : ''}${longPnl.toFixed(3)}%`);
  }

  if (shortTrades.length > 0) {
    const shortWinRate = (shortTrades.filter(v => (v.paperPnlPct ?? 0) > 0).length / shortTrades.length) * 100;
    const shortPnl = shortTrades.reduce((sum, v) => sum + (v.paperPnlPct ?? 0), 0);
    console.log(`\nShorts (${shortTrades.length}):`);
    console.log(`  Win rate:       ${shortWinRate.toFixed(1)}%`);
    console.log(`  Total P&L:      ${shortPnl >= 0 ? '+' : ''}${shortPnl.toFixed(3)}%`);
  }

  // Best/worst symbols
  const symbolStats = new Map<string, { pnl: number; count: number }>();
  for (const v of validated) {
    if (!symbolStats.has(v.symbol)) {
      symbolStats.set(v.symbol, { pnl: 0, count: 0 });
    }
    const stats = symbolStats.get(v.symbol)!;
    stats.pnl += v.paperPnlPct ?? 0;
    stats.count++;
  }

  const sortedSymbols = Array.from(symbolStats.entries())
    .filter(([, stats]) => stats.count >= 3)
    .sort((a, b) => b[1].pnl - a[1].pnl);

  if (sortedSymbols.length > 0) {
    console.log(`\nBest Symbols (≥3 trades):`);
    sortedSymbols.slice(0, 5).forEach(([symbol, stats]) => {
      console.log(`  ${symbol.padEnd(12)} ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(3)}% (${stats.count} trades)`);
    });

    console.log(`\nWorst Symbols (≥3 trades):`);
    sortedSymbols.slice(-5).reverse().forEach(([symbol, stats]) => {
      console.log(`  ${symbol.padEnd(12)} ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(3)}% (${stats.count} trades)`);
    });
  }
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
