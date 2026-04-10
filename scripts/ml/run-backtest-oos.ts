/**
 * Out-of-sample validation backtest.
 *
 * Runs v6 baseline + v6_sentiment_veto on the Mar 16 - Apr 10 window
 * (strictly AFTER the Jan 1 - Mar 15 tuning window).
 *
 * This is the critical test: if the veto helps out-of-sample, it's real.
 * If it hurts, the filter was curve-fit to the in-sample window.
 *
 * Usage: npx tsx scripts/ml/run-backtest-oos.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { runBacktest, computeStats, BacktestConfig, SimulatedTrade, DEFAULT_ENTRY_CONFIG } from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';
import { buildSentimentPanel, SentimentPanel } from './backtest/sentiment';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// OOS window — strictly AFTER the Jan 1 - Mar 15 tuning period
const START = new Date('2026-03-16T00:00:00Z');
const END = new Date('2026-04-10T23:59:59Z');

const WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'];

const NOTIONAL_USD = 100;
const LEVERAGE = 5;

interface Variant {
  name: string;
  description: string;
  build: (panel: SentimentPanel) => BacktestConfig;
}

const VARIANTS: Variant[] = [
  {
    name: 'oos_v6_baseline',
    description: 'v6 baseline on OUT-OF-SAMPLE window',
    build: () => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG },
      scorer: 'v6',
    }),
  },
  {
    name: 'oos_v6_sentiment_veto',
    description: 'v6 + sentiment veto on OUT-OF-SAMPLE window',
    build: (panel) => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG },
      scorer: 'v6_veto',
      sentimentPanel: panel,
    }),
  },
  {
    name: 'oos_v6_sentiment_threshold',
    description: 'v6 + sentiment ±5 threshold on OUT-OF-SAMPLE window',
    build: (panel) => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG },
      scorer: 'v6_threshold',
      sentimentPanel: panel,
    }),
  },
];

function fmt(n: number, dec = 2, sign = false): string {
  const s = n.toFixed(dec);
  return sign && n >= 0 ? '+' + s : s;
}

async function main() {
  console.log(`\n🔬 OUT-OF-SAMPLE backtest — ${START.toISOString().slice(0, 10)} → ${END.toISOString().slice(0, 10)}`);
  console.log(`   Whitelist: ${WHITELIST.join(', ')}`);
  console.log(`   Notional: $${NOTIONAL_USD}, leverage ${LEVERAGE}x`);
  console.log(`   Window is STRICTLY AFTER the in-sample tuning window (Jan 1 - Mar 15)\n`);

  // Clear prior OOS runs
  await prisma.backtestRun.deleteMany({
    where: { name: { in: VARIANTS.map((v) => v.name) } },
  });

  console.log('  Building sentiment panel...');
  const panel = await buildSentimentPanel(prisma, START, END);
  console.log('  Panel ready\n');

  const results: Array<{ variant: Variant; trades: SimulatedTrade[] }> = [];

  for (const variant of VARIANTS) {
    console.log(`━━━ ${variant.name} ━━━`);
    console.log(`    ${variant.description}`);
    const t0 = Date.now();
    const trades = await runBacktest(prisma, variant.build(panel));
    const stats = computeStats(trades);
    console.log(
      `    ${trades.length} trades, win ${stats.winRate.toFixed(1)}%, ` +
      `P&L $${fmt(stats.totalPnl, 2, true)} (${fmt(stats.avgPnlPct, 2, true)}% avg), ` +
      `DD ${fmt(stats.maxDrawdownPct, 2)}%  (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );

    // Persist
    await prisma.backtestRun.create({
      data: {
        name: variant.name,
        description: variant.description,
        strategyVersion: 'momentum-v6',
        windowStart: START,
        windowEnd: END,
        symbols: WHITELIST,
        config: variant.build(panel) as any,
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        totalPnl: stats.totalPnl,
        totalPnlPct: stats.totalPnlPct,
        avgPnlPct: stats.avgPnlPct,
        winRate: stats.winRate,
        maxDrawdownPct: stats.maxDrawdownPct,
      },
    });

    results.push({ variant, trades });
    console.log();
  }

  // Comparison
  console.log('═'.repeat(90));
  console.log('OUT-OF-SAMPLE RESULTS');
  console.log('═'.repeat(90));
  console.log(
    'Variant'.padEnd(32) +
    'Trades'.padStart(8) +
    'WinRt'.padStart(8) +
    'TotalPnl'.padStart(12) +
    'TotalPct'.padStart(10) +
    'AvgPct'.padStart(10) +
    'MaxDD'.padStart(10)
  );
  console.log('─'.repeat(90));
  for (const { variant, trades } of results) {
    const stats = computeStats(trades);
    console.log(
      variant.name.padEnd(32) +
      stats.totalTrades.toString().padStart(8) +
      (stats.winRate.toFixed(0) + '%').padStart(8) +
      ('$' + fmt(stats.totalPnl, 0, true)).padStart(12) +
      (fmt(stats.totalPnlPct, 1, true) + '%').padStart(10) +
      (fmt(stats.avgPnlPct, 2, true) + '%').padStart(10) +
      (fmt(stats.maxDrawdownPct, 1) + '%').padStart(10)
    );
  }

  // Show v6 vs v6_veto symbol breakdown
  const v6 = results.find((r) => r.variant.name === 'oos_v6_baseline')!;
  const veto = results.find((r) => r.variant.name === 'oos_v6_sentiment_veto')!;
  console.log('\n' + '═'.repeat(90));
  console.log('OOS: V6 BASELINE vs V6_VETO — BY SYMBOL');
  console.log('═'.repeat(90));
  console.log(
    'Symbol'.padEnd(12) +
    'v6 cnt'.padStart(9) + 'v6 tot%'.padStart(11) + 'v6 win%'.padStart(10) +
    'veto cnt'.padStart(11) + 'veto tot%'.padStart(11) + 'veto win%'.padStart(11) +
    'Δtot%'.padStart(10)
  );
  console.log('─'.repeat(90));
  const syms = new Set([...v6.trades.map((t) => t.symbol), ...veto.trades.map((t) => t.symbol)]);
  for (const sym of syms) {
    const v6Ts = v6.trades.filter((t) => t.symbol === sym);
    const vtTs = veto.trades.filter((t) => t.symbol === sym);
    const v6Tot = v6Ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    const vtTot = vtTs.reduce((s, t) => s + t.realizedPnlPct, 0);
    const v6Wins = v6Ts.filter((t) => t.realizedPnl > 0).length;
    const vtWins = vtTs.filter((t) => t.realizedPnl > 0).length;
    const v6Wr = v6Ts.length > 0 ? (v6Wins / v6Ts.length) * 100 : 0;
    const vtWr = vtTs.length > 0 ? (vtWins / vtTs.length) * 100 : 0;
    console.log(
      sym.padEnd(12) +
      v6Ts.length.toString().padStart(9) +
      (fmt(v6Tot, 1, true) + '%').padStart(11) +
      (v6Wr.toFixed(0) + '%').padStart(10) +
      vtTs.length.toString().padStart(11) +
      (fmt(vtTot, 1, true) + '%').padStart(11) +
      (vtWr.toFixed(0) + '%').padStart(11) +
      (fmt(vtTot - v6Tot, 1, true) + '%').padStart(10)
    );
  }

  // Exit reason breakdown — veto
  console.log('\n' + '═'.repeat(90));
  console.log('OOS V6_VETO — EXIT REASON BREAKDOWN');
  console.log('═'.repeat(90));
  const byReason = new Map<string, SimulatedTrade[]>();
  for (const t of veto.trades) {
    if (!byReason.has(t.exitReason)) byReason.set(t.exitReason, []);
    byReason.get(t.exitReason)!.push(t);
  }
  console.log('Reason'.padEnd(22) + 'Count'.padStart(8) + 'WinRt'.padStart(8) + 'AvgPct'.padStart(10) + 'TotPct'.padStart(10));
  console.log('─'.repeat(60));
  for (const [r, ts] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const wins = ts.filter((t) => t.realizedPnl > 0).length;
    const wr = (wins / ts.length) * 100;
    const avg = ts.reduce((s, t) => s + t.realizedPnlPct, 0) / ts.length;
    const tot = ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      r.padEnd(22) +
      ts.length.toString().padStart(8) +
      (wr.toFixed(0) + '%').padStart(8) +
      (fmt(avg, 2, true) + '%').padStart(10) +
      (fmt(tot, 1, true) + '%').padStart(10)
    );
  }

  // Same for v6 baseline
  console.log('\n' + '═'.repeat(90));
  console.log('OOS V6 BASELINE — EXIT REASON BREAKDOWN');
  console.log('═'.repeat(90));
  const byReason2 = new Map<string, SimulatedTrade[]>();
  for (const t of v6.trades) {
    if (!byReason2.has(t.exitReason)) byReason2.set(t.exitReason, []);
    byReason2.get(t.exitReason)!.push(t);
  }
  console.log('Reason'.padEnd(22) + 'Count'.padStart(8) + 'WinRt'.padStart(8) + 'AvgPct'.padStart(10) + 'TotPct'.padStart(10));
  console.log('─'.repeat(60));
  for (const [r, ts] of [...byReason2.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const wins = ts.filter((t) => t.realizedPnl > 0).length;
    const wr = (wins / ts.length) * 100;
    const avg = ts.reduce((s, t) => s + t.realizedPnlPct, 0) / ts.length;
    const tot = ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      r.padEnd(22) +
      ts.length.toString().padStart(8) +
      (wr.toFixed(0) + '%').padStart(8) +
      (fmt(avg, 2, true) + '%').padStart(10) +
      (fmt(tot, 1, true) + '%').padStart(10)
    );
  }

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
