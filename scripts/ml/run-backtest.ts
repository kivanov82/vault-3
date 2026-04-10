/**
 * Run the backtest for the Jan 1 - Mar 15, 2026 window, across 5 strategy
 * variations, persist everything to BacktestRun/BacktestTrade, and print a
 * comparison report.
 *
 * Usage: npx tsx scripts/ml/run-backtest.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  runBacktest,
  computeStats,
  BacktestConfig,
  SimulatedTrade,
  DEFAULT_ENTRY_CONFIG,
} from './backtest/engine';
import { DEFAULT_EXIT_CONFIG, ExitConfig } from './backtest/strategy';
import { buildSentimentPanel, SentimentPanel } from './backtest/sentiment';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-03-15T00:00:00Z');

// LIVE WHITELIST — matches IndependentTrader.ts CONFIG.WHITELIST exactly.
// This is what the current strategy would actually trade in production.
const WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'];

// Extended scope (whitelist + other well-covered symbols the target traded).
// Used only for the "expanded_whitelist" variant to show what we'd miss.
const EXTENDED = [
  ...WHITELIST,
  'BTC','SPX','SKY','VIRTUAL','PUMP','kPEPE','ZEC','ETHFI','AVNT','IP',
];

const NOTIONAL_USD = 100;  // fixed $100 notional per trade
const LEVERAGE = 5;         // matches live config

// =============================================================================

interface Variant {
  name: string;
  description: string;
  build: (sentimentPanel?: SentimentPanel) => BacktestConfig;
}

const VARIANTS: Variant[] = [
  {
    name: 'v6_current_live',
    description: 'v6 baseline: current live strategy (whitelist, symmetric 90, all exits, -10% stop)',
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
    name: 'v7_sentiment',
    description: 'v7 with sentiment rule table (Archangel + Bitcoin MA direction) replacing the EMA regime block',
    build: (panel) => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG },
      scorer: 'v7',
      sentimentPanel: panel,
    }),
  },
  {
    name: 'v7_sentiment_expanded',
    description: 'v7 scoring on 16-symbol expanded scope (non-whitelist extras)',
    build: (panel) => ({
      symbols: EXTENDED,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG },
      scorer: 'v7',
      sentimentPanel: panel,
    }),
  },
  {
    name: 'v7_sentiment_tight_stop',
    description: 'v7 scoring + tighter -5% hard stop',
    build: (panel) => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG, hardStopPct: 0.05 },
      scorer: 'v7',
      sentimentPanel: panel,
    }),
  },
  {
    name: 'v6_sentiment_veto',
    description: 'v6 scoring, reject entries where v6 direction contradicts sentiment rule',
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
    name: 'v6_sentiment_veto_tight_stop',
    description: 'v6 + sentiment veto + tight -5% hard stop',
    build: (panel) => ({
      symbols: WHITELIST,
      windowStart: START,
      windowEnd: END,
      leverage: LEVERAGE,
      notionalUsdPerTrade: NOTIONAL_USD,
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_EXIT_CONFIG, hardStopPct: 0.05 },
      scorer: 'v6_veto',
      sentimentPanel: panel,
    }),
  },
  {
    name: 'v6_sentiment_threshold',
    description: 'v6 scoring, ±5 threshold adjustment based on sentiment agreement',
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

// =============================================================================

async function persistRun(
  name: string,
  description: string,
  cfg: BacktestConfig,
  trades: SimulatedTrade[]
): Promise<string> {
  const stats = computeStats(trades);

  const run = await prisma.backtestRun.create({
    data: {
      name,
      description,
      strategyVersion: 'momentum-v6',
      windowStart: cfg.windowStart,
      windowEnd: cfg.windowEnd,
      symbols: cfg.symbols,
      config: {
        entry: cfg.entry as any,
        exit: cfg.exit as any,
        leverage: cfg.leverage,
        notionalUsdPerTrade: cfg.notionalUsdPerTrade,
      } as any,
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

  // Persist trades in chunks
  for (let i = 0; i < trades.length; i += 500) {
    const chunk = trades.slice(i, i + 500);
    await prisma.backtestTrade.createMany({
      data: chunk.map((t) => ({
        runId: run.id,
        symbol: t.symbol,
        side: t.side,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason,
        holdHours: t.holdHours,
        sizeUsd: cfg.notionalUsdPerTrade,
        leverage: cfg.leverage,
        realizedPnl: t.realizedPnl,
        realizedPnlPct: t.realizedPnlPct,
        predictionScore: t.predictionScore,
        predictionReasons: t.predictionReasons,
        entryRsi14: t.entryRsi14,
        entryBbPos: t.entryBbPos,
        entryMacdHist: t.entryMacdHist,
        entryEma9: t.entryEma9,
        entryEma21: t.entryEma21,
      })),
    });
  }

  return run.id;
}

// =============================================================================

function fmt(n: number, dec: number = 2, sign: boolean = false): string {
  const s = n.toFixed(dec);
  if (sign && n >= 0) return '+' + s;
  return s;
}

async function main() {
  console.log(`\n🔬 Backtest — ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}`);
  console.log(`   Whitelist: ${WHITELIST.join(', ')}`);
  console.log(`   Notional per trade: $${NOTIONAL_USD}, leverage ${LEVERAGE}x`);
  console.log(`   Variants: ${VARIANTS.length}\n`);

  // Optional: clear prior runs with the same name (+ cleanup of older experiment names)
  const existingNames = VARIANTS.map((v) => v.name);
  const deletedRuns = await prisma.backtestRun.deleteMany({
    where: {
      name: {
        in: [
          ...existingNames,
          'baseline_v5.1', 'shorts_enabled', 'rsi_only_exit',
          'live_baseline', 'longs_only', 'no_hard_stop',
          'tight_stop_5pct', 'wide_stop_15pct', 'score_capped_90_95', 'no_ema_tp',
          'current_live', 'current_live_longs_only', 'expanded_whitelist',
        ],
      },
    },
  });

  // Pre-build sentiment panel once (used by all v7 variants)
  console.log('  Building sentiment panel from Archangel + Bitcoin MA fills...');
  const sentimentPanel = await buildSentimentPanel(prisma, START, END);
  console.log('  Sentiment panel ready');
  if (deletedRuns.count > 0) {
    console.log(`  Cleared ${deletedRuns.count} prior runs with matching names\n`);
  }

  const results: Array<{ variant: Variant; trades: SimulatedTrade[]; runId: string }> = [];

  for (const variant of VARIANTS) {
    console.log(`━━━ ${variant.name} ━━━`);
    console.log(`    ${variant.description}`);
    const t0 = Date.now();
    const cfg = variant.build(sentimentPanel);
    const trades = await runBacktest(prisma, cfg);
    const stats = computeStats(trades);
    console.log(
      `    ${trades.length} trades, win ${stats.winRate.toFixed(1)}%, ` +
      `P&L $${fmt(stats.totalPnl, 2, true)} (${fmt(stats.avgPnlPct, 2, true)}% avg), ` +
      `DD ${fmt(stats.maxDrawdownPct, 2)}%  (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
    const runId = await persistRun(variant.name, variant.description, cfg, trades);
    results.push({ variant, trades, runId });
    console.log();
  }

  // =========================================================================
  // COMPARISON REPORT
  // =========================================================================
  console.log('═'.repeat(90));
  console.log('STRATEGY VARIATIONS — COMPARISON');
  console.log('═'.repeat(90));
  console.log(
    'Variant'.padEnd(22) +
    'Trades'.padStart(8) +
    'WinRt'.padStart(8) +
    'TotalPnl'.padStart(12) +
    'TotalPct'.padStart(10) +
    'AvgPct'.padStart(10) +
    'MaxDD'.padStart(9) +
    'Best'.padStart(12)
  );
  console.log('─'.repeat(90));

  for (const { variant, trades } of results) {
    const stats = computeStats(trades);
    const best = trades.reduce<SimulatedTrade | null>((b, t) => (!b || t.realizedPnlPct > b.realizedPnlPct ? t : b), null);
    const bestStr = best ? `${best.symbol}+${best.realizedPnlPct.toFixed(1)}%` : '-';
    console.log(
      variant.name.padEnd(22) +
      stats.totalTrades.toString().padStart(8) +
      (stats.winRate.toFixed(0) + '%').padStart(8) +
      ('$' + fmt(stats.totalPnl, 0, true)).padStart(12) +
      (fmt(stats.totalPnlPct, 1, true) + '%').padStart(10) +
      (fmt(stats.avgPnlPct, 2, true) + '%').padStart(10) +
      (fmt(stats.maxDrawdownPct, 1) + '%').padStart(9) +
      bestStr.padStart(12)
    );
  }

  // =========================================================================
  // BASELINE BREAKDOWN
  // =========================================================================
  // Report breakdown for both v6 baseline and the best v7 variant
  const v6 = results.find((r) => r.variant.name === 'v6_current_live')!;
  const v7 = results.find((r) => r.variant.name === 'v7_sentiment')!;
  const baseline = v7; // use v7 as the "main" breakdown since that's the new strategy
  console.log('\n' + '═'.repeat(90));
  console.log('V7 SENTIMENT — EXIT REASON BREAKDOWN');
  console.log('═'.repeat(90));
  const byReason = new Map<string, SimulatedTrade[]>();
  for (const t of baseline.trades) {
    if (!byReason.has(t.exitReason)) byReason.set(t.exitReason, []);
    byReason.get(t.exitReason)!.push(t);
  }
  const rsorted = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log('Reason'.padEnd(22) + 'Count'.padStart(8) + 'WinRt'.padStart(8) + 'AvgPct'.padStart(10) + 'TotPct'.padStart(10));
  console.log('─'.repeat(60));
  for (const [reason, ts] of rsorted) {
    const wins = ts.filter((t) => t.realizedPnl > 0).length;
    const wr = (wins / ts.length) * 100;
    const avg = ts.reduce((s, t) => s + t.realizedPnlPct, 0) / ts.length;
    const tot = ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      reason.padEnd(22) +
      ts.length.toString().padStart(8) +
      (wr.toFixed(0) + '%').padStart(8) +
      (fmt(avg, 2, true) + '%').padStart(10) +
      (fmt(tot, 1, true) + '%').padStart(10)
    );
  }

  console.log('\n' + '═'.repeat(90));
  console.log('V7 SENTIMENT — BY SYMBOL');
  console.log('═'.repeat(90));
  const bySym = new Map<string, SimulatedTrade[]>();
  for (const t of baseline.trades) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
    bySym.get(t.symbol)!.push(t);
  }
  const ssorted = [...bySym.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log('Symbol'.padEnd(14) + 'Count'.padStart(8) + 'WinRt'.padStart(8) + 'AvgPct'.padStart(10) + 'TotPct'.padStart(10));
  console.log('─'.repeat(60));
  for (const [sym, ts] of ssorted) {
    const wins = ts.filter((t) => t.realizedPnl > 0).length;
    const wr = (wins / ts.length) * 100;
    const avg = ts.reduce((s, t) => s + t.realizedPnlPct, 0) / ts.length;
    const tot = ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      sym.padEnd(14) +
      ts.length.toString().padStart(8) +
      (wr.toFixed(0) + '%').padStart(8) +
      (fmt(avg, 2, true) + '%').padStart(10) +
      (fmt(tot, 1, true) + '%').padStart(10)
    );
  }

  // Side-by-side v6 vs v7 symbol comparison
  console.log('\n' + '═'.repeat(90));
  console.log('V6 vs V7 — SYMBOL COMPARISON');
  console.log('═'.repeat(90));
  const allSymbols = new Set([...v6.trades.map((t) => t.symbol), ...v7.trades.map((t) => t.symbol)]);
  console.log(
    'Symbol'.padEnd(12) +
    'v6 trades'.padStart(11) + 'v6 tot%'.padStart(11) +
    'v7 trades'.padStart(11) + 'v7 tot%'.padStart(11) +
    'Δ trades'.padStart(11) + 'Δ tot%'.padStart(11)
  );
  console.log('─'.repeat(80));
  for (const sym of allSymbols) {
    const v6Ts = v6.trades.filter((t) => t.symbol === sym);
    const v7Ts = v7.trades.filter((t) => t.symbol === sym);
    const v6Tot = v6Ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    const v7Tot = v7Ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      sym.padEnd(12) +
      v6Ts.length.toString().padStart(11) +
      fmt(v6Tot, 1, true).padStart(10) + '%' +
      v7Ts.length.toString().padStart(11) +
      fmt(v7Tot, 1, true).padStart(10) + '%' +
      (v7Ts.length - v6Ts.length).toString().padStart(11) +
      fmt(v7Tot - v6Tot, 1, true).padStart(10) + '%'
    );
  }

  console.log('\n' + '═'.repeat(90));
  console.log('V7 SENTIMENT — BY SCORE BUCKET');
  console.log('═'.repeat(90));
  const buckets = [
    { min: 90, max: 95, label: '90-95' },
    { min: 95, max: 100, label: '95-100' },
    { min: 100, max: 200, label: '100+' },
  ];
  for (const b of buckets) {
    const ts = baseline.trades.filter((t) => t.predictionScore >= b.min && t.predictionScore < b.max);
    if (ts.length === 0) continue;
    const wins = ts.filter((t) => t.realizedPnl > 0).length;
    const wr = (wins / ts.length) * 100;
    const avg = ts.reduce((s, t) => s + t.realizedPnlPct, 0) / ts.length;
    const tot = ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    console.log(
      `  ${b.label.padEnd(8)} ${ts.length.toString().padStart(4)} trades   win ${wr.toFixed(0)}%   avg ${fmt(avg, 2, true)}%   total ${fmt(tot, 1, true)}%`
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
