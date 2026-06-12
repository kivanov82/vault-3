/**
 * One-off: backtest current live strategy (v6, symmetric 90, -10% stop) with
 * PUMP and ZEC added — both alone and alongside the existing whitelist.
 *
 * Two windows:
 *   - In-sample:    2026-01-01 → 2026-03-15
 *   - OOS extended: 2026-03-16 → 2026-05-07
 *
 * Prints per-variant stats; does NOT persist to BacktestRun.
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
  DEFAULT_ENTRY_CONFIG,
  SimulatedTrade,
} from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'];

const WINDOWS = [
  { name: 'in-sample', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
  { name: 'oos-ext  ', start: new Date('2026-03-16T00:00:00Z'), end: new Date('2026-05-07T00:00:00Z') },
];

const VARIANTS: { name: string; symbols: string[] }[] = [
  { name: 'WL_baseline   ', symbols: WHITELIST },
  { name: 'WL_plus_PUMP  ', symbols: [...WHITELIST, 'PUMP'] },
  { name: 'WL_plus_ZEC   ', symbols: [...WHITELIST, 'ZEC'] },
  { name: 'WL_plus_BOTH  ', symbols: [...WHITELIST, 'PUMP', 'ZEC'] },
  { name: 'PUMP_only     ', symbols: ['PUMP'] },
  { name: 'ZEC_only      ', symbols: ['ZEC'] },
];

function buildCfg(symbols: string[], start: Date, end: Date): BacktestConfig {
  return {
    symbols,
    windowStart: start,
    windowEnd: end,
    leverage: 5,
    notionalUsdPerTrade: 100,
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG },
    scorer: 'v6',
  };
}

function summarise(name: string, trades: SimulatedTrade[]) {
  const stats = computeStats(trades);
  const longs = trades.filter((t) => t.side === 'long').length;
  const shorts = trades.filter((t) => t.side === 'short').length;
  console.log(
    name,
    `n=${String(stats.totalTrades).padStart(4)}`,
    `L/S=${String(longs).padStart(3)}/${String(shorts).padStart(3)}`,
    `pnl=$${stats.totalPnl.toFixed(2).padStart(8)}`,
    `pnl%=${stats.totalPnlPct.toFixed(1).padStart(6)}%`,
    `avg=${stats.avgPnlPct.toFixed(2).padStart(5)}%`,
    `win=${stats.winRate.toFixed(1).padStart(4)}%`,
    `dd=${stats.maxDrawdownPct.toFixed(1).padStart(5)}%`
  );
}

async function symbolBreakdown(name: string, trades: SimulatedTrade[], symbols: string[]) {
  for (const sym of symbols) {
    const tt = trades.filter((t) => t.symbol === sym);
    if (tt.length === 0) continue;
    const stats = computeStats(tt);
    const longs = tt.filter((t) => t.side === 'long').length;
    console.log(
      `   ${sym.padEnd(10)} n=${String(tt.length).padStart(4)} L/S=${longs}/${tt.length - longs}  pnl=$${stats.totalPnl.toFixed(2).padStart(8)}  avg=${stats.avgPnlPct.toFixed(2).padStart(5)}%  win=${stats.winRate.toFixed(1).padStart(4)}%`
    );
  }
}

async function main() {
  for (const w of WINDOWS) {
    console.log('');
    console.log('═'.repeat(110));
    console.log(`Window: ${w.name}   ${w.start.toISOString().slice(0, 10)} → ${w.end.toISOString().slice(0, 10)}`);
    console.log('═'.repeat(110));

    const captured: { name: string; trades: SimulatedTrade[]; symbols: string[] }[] = [];
    for (const v of VARIANTS) {
      const cfg = buildCfg(v.symbols, w.start, w.end);
      const trades = await runBacktest(prisma, cfg);
      summarise(v.name, trades);
      captured.push({ name: v.name, trades, symbols: v.symbols });
    }

    // Detailed per-symbol view for the WL_plus_BOTH variant only (most informative)
    const wlBoth = captured.find((c) => c.name.trim() === 'WL_plus_BOTH');
    if (wlBoth) {
      console.log(`\n  Per-symbol breakdown (WL_plus_BOTH):`);
      await symbolBreakdown(wlBoth.name, wlBoth.trades, wlBoth.symbols);
    }
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); await pool.end(); process.exit(1); });
