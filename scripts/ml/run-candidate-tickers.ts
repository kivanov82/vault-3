/**
 * Whitelist-candidate evaluation: run the CURRENT live strategy (v6 scoring,
 * symmetric 90/90, live exit rules, -10% stop) per symbol, one symbol at a time,
 * and compare candidates against the current whitelist symbols as benchmark.
 *
 * Candidates need backfilled candles+indicators first:
 *   npx tsx scripts/ml/backfill-candidate-tickers.ts
 *
 * Usage: npx tsx scripts/ml/run-candidate-tickers.ts
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

const CURRENT_WHITELIST = ['HYPE', 'SOL', 'VVV', 'ETH', 'FARTCOIN'];
const CANDIDATES = ['ZEC', 'XMR', 'PENGU', 'NEAR', 'PUMP', 'SPX', 'BLUR'];

const NOTIONAL_USD = 100;
const LEVERAGE = 5;

const WINDOWS = [
  { name: 'full (Dec1–Jun12)', start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-06-12T00:00:00Z') },
  { name: 'recent (Apr1–Jun12)', start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-06-12T00:00:00Z') },
];

const cfgFor = (symbol: string, start: Date, end: Date): BacktestConfig => ({
  symbols: [symbol],
  windowStart: start,
  windowEnd: end,
  leverage: LEVERAGE,
  notionalUsdPerTrade: NOTIONAL_USD,
  entry: { ...DEFAULT_ENTRY_CONFIG },
  exit: { ...DEFAULT_EXIT_CONFIG },
  scorer: 'v6',
});

function sideSplit(trades: SimulatedTrade[]) {
  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');
  const pnl = (arr: SimulatedTrade[]) => arr.reduce((s, t) => s + t.realizedPnl, 0);
  return { nL: longs.length, pL: pnl(longs), nS: shorts.length, pS: pnl(shorts) };
}

async function candleCount(symbol: string, start: Date, end: Date): Promise<number> {
  return prisma.candle.count({
    where: { symbol, timeframe: '1h', timestamp: { gte: start, lte: end } },
  });
}

async function main() {
  console.log(`\n🧪 Candidate ticker evaluation — current live strategy (v6, 90/90, live exits)`);
  console.log(`   $${NOTIONAL_USD} notional/trade, ${LEVERAGE}x. Benchmark: current whitelist.\n`);

  for (const w of WINDOWS) {
    console.log(`\n══════ ${w.name} ══════`);
    console.log('symbol      cover    trades   L/S        P&L $    win%   avg%    maxDD   stops');
    console.log('─'.repeat(84));

    for (const group of [CURRENT_WHITELIST, CANDIDATES]) {
      for (const sym of group) {
        const candles = await candleCount(sym, w.start, w.end);
        if (candles === 0) {
          console.log(`${sym.padEnd(11)} ${'0'.padStart(5)}    (no data)`);
          continue;
        }
        const trades = await runBacktest(prisma, cfgFor(sym, w.start, w.end));
        const stats = computeStats(trades);
        const split = sideSplit(trades);
        const stops = trades.filter((t) => t.exitReason === 'hard_stop').length;
        const pnlStr = (stats.totalPnl >= 0 ? '+$' : '-$') + Math.abs(stats.totalPnl).toFixed(2);
        console.log(
          sym.padEnd(11) +
          String(candles).padStart(5) +
          String(stats.totalTrades).padStart(9) +
          `   ${split.nL}/${split.nS}`.padEnd(11) +
          pnlStr.padStart(9) +
          `${stats.winRate.toFixed(0)}%`.padStart(8) +
          `${stats.avgPnlPct >= 0 ? '+' : ''}${stats.avgPnlPct.toFixed(2)}`.padStart(7) +
          `${stats.maxDrawdownPct.toFixed(1)}%`.padStart(9) +
          String(stops).padStart(8)
        );
      }
      if (group === CURRENT_WHITELIST) console.log('─'.repeat(84));
    }
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
