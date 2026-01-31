/**
 * Save Strategy Analysis Report
 *
 * Runs comprehensive analysis and saves findings to AnalysisReport table.
 *
 * Usage: npx ts-node scripts/ml/save-strategy-report.ts
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
  console.log('📊 Generating and saving strategy analysis report...\n');

  const report = await generateReport();

  // Save to database
  const saved = await prisma.analysisReport.create({
    data: {
      type: 'target-strategy-profile',
      timestamp: new Date(),
      data: report as any,
      summary: generateSummary(report),
    },
  });

  console.log(`✅ Report saved with ID: ${saved.id}`);
  console.log(`\n${'═'.repeat(70)}`);
  console.log('STRATEGY SUMMARY');
  console.log('═'.repeat(70));
  console.log(saved.summary);

  await prisma.$disconnect();
  await pool.end();
}

async function generateReport() {
  // Data overview
  const dataOverview = await getDataOverview();

  // Symbol analysis
  const symbolAnalysis = await getSymbolAnalysis();

  // Timing patterns
  const timingPatterns = await getTimingPatterns();

  // Position sizing
  const positionSizing = await getPositionSizing();

  // Entry patterns (breakout vs dip)
  const entryPatterns = await getEntryPatterns();

  // BTC correlation
  const btcCorrelation = await getBtcCorrelation();

  // Session analysis
  const sessionAnalysis = await getSessionAnalysis();

  // Execution patterns
  const executionPatterns = await getExecutionPatterns();

  return {
    generatedAt: new Date().toISOString(),
    targetTrader: TARGET_TRADER,
    dataOverview,
    symbolAnalysis,
    timingPatterns,
    positionSizing,
    entryPatterns,
    btcCorrelation,
    sessionAnalysis,
    executionPatterns,
    strategyProfile: {
      type: 'Momentum/Breakout Accumulator',
      entryStyle: 'Breakout buying (65% at upper price range)',
      execution: 'TWAP accumulation (avg 9.5 consecutive fills)',
      leverage: 'Conservative (avg 4.8x)',
      btcBehavior: 'Trade alts when BTC calm, same direction',
      sessionBias: 'Accumulate Asia/EU, trim US',
      directionalBias: 'Long-heavy (64%)',
      focus: 'Memecoins/altcoins (HYPE, VVV, SPX, FARTCOIN)',
    },
    recommendations: {
      predictionSignals: [
        'Breakout detection (price > recent high)',
        'BTC stability check (calm periods = accumulation)',
        'Session-aware scoring (Asia/EU = long bias)',
        'Momentum confirmation (price change positive)',
        'Volume surge detection',
      ],
      validationWindow: '4-24 hours (not 1 hour)',
      skipSignals: [
        'RSI oversold/overbought (mean reversion)',
        'BB lower/upper extremes (mean reversion)',
      ],
    },
  };
}

async function getDataOverview() {
  const tradeCount = await prisma.trade.count({ where: { trader: 'target' } });
  const fillCount = await prisma.fill.count({ where: { traderAddress: TARGET_TRADER } });
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

  const days = dateRange._min.timestamp && dateRange._max.timestamp
    ? Math.ceil((dateRange._max.timestamp.getTime() - dateRange._min.timestamp.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    trades: tradeCount,
    fills: fillCount,
    predictions: predictionCount,
    uniqueSymbols: symbols.length,
    startDate: dateRange._min.timestamp?.toISOString(),
    endDate: dateRange._max.timestamp?.toISOString(),
    days,
  };
}

async function getSymbolAnalysis() {
  const symbolFills = await prisma.fill.groupBy({
    by: ['symbol'],
    where: { traderAddress: TARGET_TRADER },
    _count: true,
    orderBy: { _count: { symbol: 'desc' } },
    take: 20,
  });

  const totalFills = symbolFills.reduce((sum, s) => sum + s._count, 0);
  const top5Fills = symbolFills.slice(0, 5).reduce((sum, s) => sum + s._count, 0);

  return {
    topSymbols: symbolFills.map(s => ({ symbol: s.symbol, fills: s._count })),
    top5Concentration: ((top5Fills / totalFills) * 100).toFixed(1) + '%',
  };
}

async function getTimingPatterns() {
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true },
  });

  const hourCounts = new Array(24).fill(0);
  for (const fill of fills) {
    hourCounts[fill.timestamp.getUTCHours()]++;
  }

  const sortedHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count);

  return {
    peakHours: sortedHours.slice(0, 5).map(h => h.hour),
    hourDistribution: hourCounts,
  };
}

async function getPositionSizing() {
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { size: true, price: true },
  });

  const notionalValues = fills.map(f => Math.abs(f.size * f.price));
  notionalValues.sort((a, b) => a - b);

  return {
    min: notionalValues[0],
    p25: notionalValues[Math.floor(notionalValues.length * 0.25)],
    median: notionalValues[Math.floor(notionalValues.length / 2)],
    p75: notionalValues[Math.floor(notionalValues.length * 0.75)],
    max: notionalValues[notionalValues.length - 1],
    avg: notionalValues.reduce((a, b) => a + b, 0) / notionalValues.length,
  };
}

async function getEntryPatterns() {
  const results: Record<string, { breakoutBuys: number; dipBuys: number }> = {};
  const topSymbols = ['HYPE', 'VVV', 'SKY', 'SPX', 'BTC'];

  for (const symbol of topSymbols) {
    const fills = await prisma.fill.findMany({
      where: { traderAddress: TARGET_TRADER, symbol },
      orderBy: { timestamp: 'asc' },
      select: { price: true, side: true },
      take: 500,
    });

    if (fills.length < 10) continue;

    let dipBuys = 0;
    let breakoutBuys = 0;

    for (let i = 10; i < fills.length; i++) {
      const fill = fills[i];
      if (fill.side !== 'B') continue;

      const recentPrices = fills.slice(i - 10, i).map(f => f.price);
      const recentHigh = Math.max(...recentPrices);
      const recentLow = Math.min(...recentPrices);
      const range = recentHigh - recentLow;
      if (range === 0) continue;

      const position = (fill.price - recentLow) / range;
      if (position < 0.3) dipBuys++;
      else if (position > 0.7) breakoutBuys++;
    }

    results[symbol] = { breakoutBuys, dipBuys };
  }

  return results;
}

async function getBtcCorrelation() {
  const btcFills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER, symbol: 'BTC' },
    select: { timestamp: true, side: true },
    take: 100,
  });

  const altFills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER, symbol: { notIn: ['BTC', 'ETH'] } },
    select: { timestamp: true, side: true },
    take: 5000,
  });

  let sameDirection = 0;
  let oppositeDirection = 0;

  for (const btcFill of btcFills) {
    const windowStart = btcFill.timestamp.getTime() - 5 * 60 * 1000;
    const windowEnd = btcFill.timestamp.getTime() + 5 * 60 * 1000;

    for (const altFill of altFills) {
      const t = altFill.timestamp.getTime();
      if (t >= windowStart && t <= windowEnd) {
        if (altFill.side === btcFill.side) sameDirection++;
        else oppositeDirection++;
      }
    }
  }

  return {
    sameDirectionPercent: ((sameDirection / (sameDirection + oppositeDirection)) * 100).toFixed(1),
    oppositeDirectionPercent: ((oppositeDirection / (sameDirection + oppositeDirection)) * 100).toFixed(1),
  };
}

async function getSessionAnalysis() {
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true, side: true },
  });

  const sessions = [
    { name: 'Asia', start: 0, end: 8 },
    { name: 'Europe', start: 8, end: 16 },
    { name: 'US', start: 16, end: 24 },
  ];

  const results: Record<string, { fills: number; buyPercent: string }> = {};

  for (const session of sessions) {
    const sessionFills = fills.filter(f => {
      const hour = f.timestamp.getUTCHours();
      return hour >= session.start && hour < session.end;
    });

    const buys = sessionFills.filter(f => f.side === 'B').length;
    results[session.name] = {
      fills: sessionFills.length,
      buyPercent: sessionFills.length > 0 ? ((buys / sessionFills.length) * 100).toFixed(0) + '%' : '0%',
    };
  }

  return results;
}

async function getExecutionPatterns() {
  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { timestamp: true, symbol: true, side: true },
    orderBy: { timestamp: 'asc' },
  });

  // Track consecutive same-direction fills
  let maxConsecutive = 0;
  let currentConsecutive = 0;
  let lastSide = '';
  let lastSymbol = '';

  for (const fill of fills) {
    if (fill.symbol === lastSymbol && fill.side === lastSide) {
      currentConsecutive++;
    } else {
      currentConsecutive = 1;
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    lastSide = fill.side;
    lastSymbol = fill.symbol;
  }

  // Track buildups vs reductions
  const symbolPositions = new Map<string, number>();
  let buildups = 0;
  let reductions = 0;

  const fillsWithPos = await prisma.fill.findMany({
    where: { traderAddress: TARGET_TRADER },
    select: { symbol: true, positionSzi: true },
    orderBy: { timestamp: 'asc' },
  });

  for (const fill of fillsWithPos) {
    const prevPos = symbolPositions.get(fill.symbol) ?? 0;
    const newPos = Math.abs(fill.positionSzi);
    const oldPos = Math.abs(prevPos);

    if (newPos > oldPos) buildups++;
    else if (newPos < oldPos) reductions++;

    symbolPositions.set(fill.symbol, fill.positionSzi);
  }

  return {
    maxConsecutiveFills: maxConsecutive,
    buildupPercent: ((buildups / (buildups + reductions)) * 100).toFixed(1) + '%',
    reductionPercent: ((reductions / (buildups + reductions)) * 100).toFixed(1) + '%',
  };
}

function generateSummary(report: any): string {
  return `
TARGET VAULT STRATEGY PROFILE
Generated: ${report.generatedAt}

TYPE: ${report.strategyProfile.type}

KEY CHARACTERISTICS:
- Entry Style: ${report.strategyProfile.entryStyle}
- Execution: ${report.strategyProfile.execution}
- Leverage: ${report.strategyProfile.leverage}
- BTC Behavior: ${report.strategyProfile.btcBehavior}
- Session Pattern: ${report.strategyProfile.sessionBias}
- Directional Bias: ${report.strategyProfile.directionalBias}
- Focus Assets: ${report.strategyProfile.focus}

DATA ANALYZED:
- ${report.dataOverview.fills} fills over ${report.dataOverview.days} days
- ${report.dataOverview.uniqueSymbols} unique symbols
- Top 5 concentration: ${report.symbolAnalysis.top5Concentration}

ENTRY BEHAVIOR:
${Object.entries(report.entryPatterns).map(([sym, data]: [string, any]) => {
  const total = data.breakoutBuys + data.dipBuys;
  const breakoutPct = total > 0 ? ((data.breakoutBuys / total) * 100).toFixed(0) : 0;
  return `- ${sym}: ${breakoutPct}% breakout buys`;
}).join('\n')}

BTC CORRELATION: ${report.btcCorrelation.sameDirectionPercent}% same direction

SESSION PATTERN:
${Object.entries(report.sessionAnalysis).map(([session, data]: [string, any]) => {
  return `- ${session}: ${data.fills} fills, ${data.buyPercent} buys`;
}).join('\n')}

EXECUTION:
- Max consecutive same-direction fills: ${report.executionPatterns.maxConsecutiveFills}
- Buildups: ${report.executionPatterns.buildupPercent}
- Reductions: ${report.executionPatterns.reductionPercent}

RECOMMENDED PREDICTION SIGNALS:
${report.recommendations.predictionSignals.map((s: string) => `- ${s}`).join('\n')}

SIGNALS TO AVOID (mean reversion):
${report.recommendations.skipSignals.map((s: string) => `- ${s}`).join('\n')}

VALIDATION WINDOW: ${report.recommendations.validationWindow}
`.trim();
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
