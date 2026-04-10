/**
 * Sentiment threshold sweep — test different (agreeBoost, disagreePenalty) values
 * on both in-sample and out-of-sample windows.
 *
 * Goal: find the sweet spot where sentiment signal meaningfully improves P&L
 * without over-fitting.
 *
 * Usage: npx tsx scripts/ml/run-threshold-sweep.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { runBacktest, computeStats, DEFAULT_ENTRY_CONFIG, SimulatedTrade } from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';
import { buildSentimentPanel } from './backtest/sentiment';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'];
const NOTIONAL_USD = 100;
const LEVERAGE = 5;

const WINDOWS = [
  { label: 'IN-SAMPLE', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
  { label: 'OUT-SAMPLE', start: new Date('2026-03-16T00:00:00Z'), end: new Date('2026-04-10T23:59:59Z') },
];

// (agreeBoost, disagreePenalty) pairs to test
const PARAMS: Array<{ name: string; agree: number; disagree: number }> = [
  { name: 'baseline',        agree: 0,  disagree: 0  },
  { name: '±5  (current)',   agree: 5,  disagree: 5  },
  { name: '±10',             agree: 10, disagree: 10 },
  { name: '±15',             agree: 15, disagree: 15 },
  { name: '±20',             agree: 20, disagree: 20 },
  { name: '±25',             agree: 25, disagree: 25 },
  // Asymmetric — punish disagreement more than reward agreement
  { name: '+5  / -15 (asym)', agree: 5,  disagree: 15 },
  { name: '+10 / -20 (asym)', agree: 10, disagree: 20 },
  { name: '+5  / -25 (asym)', agree: 5,  disagree: 25 },
  // Opposite asymmetry — trust agreement more, be more forgiving
  { name: '+15 / -5  (asym)', agree: 15, disagree: 5  },
];

function fmt(n: number, dec = 2, sign = false): string {
  const s = n.toFixed(dec);
  return sign && n >= 0 ? '+' + s : s;
}

async function runParam(windowStart: Date, windowEnd: Date, agree: number, disagree: number, panel: any): Promise<SimulatedTrade[]> {
  const isBaseline = agree === 0 && disagree === 0;
  return runBacktest(prisma, {
    symbols: WHITELIST,
    windowStart,
    windowEnd,
    leverage: LEVERAGE,
    notionalUsdPerTrade: NOTIONAL_USD,
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG },
    scorer: isBaseline ? 'v6' : 'v6_threshold',
    sentimentPanel: panel,
    sentimentAgreeBoost: agree,
    sentimentDisagreePenalty: disagree,
  });
}

async function main() {
  console.log(`\n🔬 Sentiment threshold sweep\n`);

  const results: Array<{
    param: string;
    inSample: ReturnType<typeof computeStats>;
    oos: ReturnType<typeof computeStats>;
    combinedPnl: number;
    combinedTrades: number;
  }> = [];

  // Build sentiment panels for each window once
  console.log('Building sentiment panels...');
  const panels = new Map<string, any>();
  for (const w of WINDOWS) {
    panels.set(w.label, await buildSentimentPanel(prisma, w.start, w.end));
  }
  console.log('Panels ready\n');

  for (const p of PARAMS) {
    console.log(`  Running ${p.name}...`);
    const inTrades = await runParam(WINDOWS[0].start, WINDOWS[0].end, p.agree, p.disagree, panels.get('IN-SAMPLE'));
    const oosTrades = await runParam(WINDOWS[1].start, WINDOWS[1].end, p.agree, p.disagree, panels.get('OUT-SAMPLE'));
    const inStats = computeStats(inTrades);
    const oosStats = computeStats(oosTrades);
    results.push({
      param: p.name,
      inSample: inStats,
      oos: oosStats,
      combinedPnl: inStats.totalPnl + oosStats.totalPnl,
      combinedTrades: inStats.totalTrades + oosStats.totalTrades,
    });
  }

  // Report
  console.log('\n' + '═'.repeat(110));
  console.log('SENTIMENT THRESHOLD SWEEP');
  console.log('═'.repeat(110));
  console.log(
    'Param'.padEnd(20) +
    '│ IN-SAMPLE'.padStart(10) + ' trades'.padStart(10) + ' WR'.padStart(6) + ' P&L$'.padStart(10) + ' avg%'.padStart(9) + ' DD%'.padStart(8) +
    '│ OOS'.padStart(8)       + ' trades'.padStart(10) + ' WR'.padStart(6) + ' P&L$'.padStart(10) + ' avg%'.padStart(9) + ' DD%'.padStart(8) +
    '│ Σ P&L$'.padStart(10)
  );
  console.log('─'.repeat(160));
  for (const r of results) {
    console.log(
      r.param.padEnd(20) +
      '│ '.padStart(10) + r.inSample.totalTrades.toString().padStart(10) +
      (r.inSample.winRate.toFixed(0) + '%').padStart(6) +
      fmt(r.inSample.totalPnl, 0, true).padStart(10) +
      (fmt(r.inSample.avgPnlPct, 2, true) + '%').padStart(9) +
      (fmt(r.inSample.maxDrawdownPct, 0) + '%').padStart(8) +
      '│ '.padStart(8)  + r.oos.totalTrades.toString().padStart(10) +
      (r.oos.winRate.toFixed(0) + '%').padStart(6) +
      fmt(r.oos.totalPnl, 0, true).padStart(10) +
      (fmt(r.oos.avgPnlPct, 2, true) + '%').padStart(9) +
      (fmt(r.oos.maxDrawdownPct, 0) + '%').padStart(8) +
      '│ '.padStart(10) + fmt(r.combinedPnl, 0, true).padStart(8)
    );
  }

  // Winners
  console.log('\n' + '═'.repeat(110));
  console.log('WINNERS');
  console.log('═'.repeat(110));
  const bestIn = results.reduce((best, r) => (r.inSample.totalPnl > best.inSample.totalPnl ? r : best));
  const bestOos = results.reduce((best, r) => (r.oos.totalPnl > best.oos.totalPnl ? r : best));
  const bestCombined = results.reduce((best, r) => (r.combinedPnl > best.combinedPnl ? r : best));
  const lowestDdOos = results.reduce((best, r) => (r.oos.maxDrawdownPct < best.oos.maxDrawdownPct ? r : best));
  console.log(`  Best in-sample P&L:    ${bestIn.param.padEnd(20)} $${fmt(bestIn.inSample.totalPnl, 0, true)}`);
  console.log(`  Best OOS P&L:          ${bestOos.param.padEnd(20)} $${fmt(bestOos.oos.totalPnl, 0, true)}`);
  console.log(`  Best combined P&L:     ${bestCombined.param.padEnd(20)} $${fmt(bestCombined.combinedPnl, 0, true)}`);
  console.log(`  Lowest OOS drawdown:   ${lowestDdOos.param.padEnd(20)} ${fmt(lowestDdOos.oos.maxDrawdownPct, 1)}%`);

  console.log('');
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
