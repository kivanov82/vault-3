/**
 * Regime-asymmetric threshold backtest.
 *
 * Motivation (2026-06-12): validated momentum-v6 shadow predictions over the last
 * 30/90 days show ALL long score bands negative and ALL short bands positive on the
 * whitelist (4h-forward paper P&L) — direction dominates score in a bear regime.
 * This tests whether raising the LONG threshold only when the scorer's own macro
 * regime is bear (the regime the live bot already computes) improves P&L.
 *
 * Usage: npx tsx scripts/ml/run-regime-asym-test.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { runBacktest, computeStats, BacktestConfig, SimulatedTrade, DEFAULT_ENTRY_CONFIG } from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Current live whitelist (MON removed 2026-06-04)
const WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'FARTCOIN'];
const NOTIONAL_USD = 100;
const LEVERAGE = 5;

const WINDOWS = [
  { name: 'in_sample (Jan1–Mar15)', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
  { name: 'oos (Mar16–Apr30)', start: new Date('2026-03-16T00:00:00Z'), end: new Date('2026-04-30T23:59:59Z') },
  { name: 'recent (May1–Jun12)', start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-12T00:00:00Z') },
  { name: 'full (Dec1–Jun12)', start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-06-12T00:00:00Z') },
];

interface Variant {
  name: string;
  build: (start: Date, end: Date) => BacktestConfig;
}

const base = (start: Date, end: Date): BacktestConfig => ({
  symbols: WHITELIST,
  windowStart: start,
  windowEnd: end,
  leverage: LEVERAGE,
  notionalUsdPerTrade: NOTIONAL_USD,
  entry: { ...DEFAULT_ENTRY_CONFIG },
  exit: { ...DEFAULT_EXIT_CONFIG },
  scorer: 'v6',
});

const VARIANTS: Variant[] = [
  { name: 'baseline_90/90', build: (s, e) => base(s, e) },
  { name: 'sym_95/95', build: (s, e) => ({ ...base(s, e), entry: { ...DEFAULT_ENTRY_CONFIG, minScoreLong: 95, minScoreShort: 95 } }) },
  { name: 'bear_L95', build: (s, e) => ({ ...base(s, e), scorer: 'v6_regime_asym', regimeThresholds: { bear: { long: 95 } } }) },
  { name: 'bear_L100', build: (s, e) => ({ ...base(s, e), scorer: 'v6_regime_asym', regimeThresholds: { bear: { long: 100 } } }) },
  { name: 'bear_noLong', build: (s, e) => ({ ...base(s, e), scorer: 'v6_regime_asym', regimeThresholds: { bear: { long: Infinity } } }) },
  { name: 'bearL100+neutL95', build: (s, e) => ({ ...base(s, e), scorer: 'v6_regime_asym', regimeThresholds: { bear: { long: 100 }, neutral: { long: 95 } } }) },
];

function sideSplit(trades: SimulatedTrade[]) {
  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');
  const pnl = (arr: SimulatedTrade[]) => arr.reduce((s, t) => s + t.realizedPnl, 0);
  return { nL: longs.length, pL: pnl(longs), nS: shorts.length, pS: pnl(shorts) };
}

async function main() {
  console.log(`\n🧪 Regime-asymmetric threshold backtest — whitelist: ${WHITELIST.join(', ')}`);
  console.log(`   $${NOTIONAL_USD} notional/trade, ${LEVERAGE}x, current live exits (-${DEFAULT_EXIT_CONFIG.hardStopPct * 100}% stop)\n`);

  for (const w of WINDOWS) {
    console.log(`\n══════ ${w.name} ══════`);
    console.log('variant            trades   L/S        P&L $    win%   avg%    maxDD   stops');
    console.log('─'.repeat(82));
    for (const v of VARIANTS) {
      const trades = await runBacktest(prisma, v.build(w.start, w.end));
      const stats = computeStats(trades);
      const split = sideSplit(trades);
      const stops = trades.filter((t) => t.exitReason === 'hard_stop').length;
      const pnlStr = (stats.totalPnl >= 0 ? '+$' : '-$') + Math.abs(stats.totalPnl).toFixed(2);
      console.log(
        v.name.padEnd(18) +
        String(stats.totalTrades).padStart(6) +
        `   ${split.nL}/${split.nS}`.padEnd(11) +
        pnlStr.padStart(9) +
        `${stats.winRate.toFixed(0)}%`.padStart(8) +
        `${stats.avgPnlPct >= 0 ? '+' : ''}${stats.avgPnlPct.toFixed(2)}`.padStart(7) +
        `${stats.maxDrawdownPct.toFixed(1)}%`.padStart(9) +
        String(stops).padStart(8)
      );
    }
    // Per-side detail for the baseline, to corroborate the shadow-data asymmetry
    const baseTrades = await runBacktest(prisma, VARIANTS[0].build(w.start, w.end));
    const bs = sideSplit(baseTrades);
    console.log(`  baseline split: longs ${bs.nL} → ${bs.pL >= 0 ? '+' : '-'}$${Math.abs(bs.pL).toFixed(2)}, shorts ${bs.nS} → ${bs.pS >= 0 ? '+' : '-'}$${Math.abs(bs.pS).toFixed(2)}`);
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
