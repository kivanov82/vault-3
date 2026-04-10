/**
 * Quick sanity check: remove VVV from the whitelist and see if the strategy
 * has any edge on the remaining 5 symbols, both in-sample and out-of-sample.
 *
 * Usage: npx tsx scripts/ml/run-no-vvv-test.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { runBacktest, computeStats, DEFAULT_ENTRY_CONFIG } from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const NO_VVV = ['HYPE', 'SOL', 'ETH', 'MON', 'FARTCOIN'];
const WITH_VVV = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'];

const WINDOWS = [
  { name: 'IN-SAMPLE  (Jan 1 - Mar 15)', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
  { name: 'OUT-SAMPLE (Mar 16 - Apr 10)', start: new Date('2026-03-16T00:00:00Z'), end: new Date('2026-04-10T23:59:59Z') },
];

async function main() {
  console.log('\n🔬 No-VVV sanity check — does the strategy have edge on the other 5 symbols?\n');

  for (const w of WINDOWS) {
    console.log('━━━ ' + w.name + ' ━━━');
    const t0 = Date.now();

    const withVvv = await runBacktest(prisma, {
      symbols: WITH_VVV,
      windowStart: w.start, windowEnd: w.end,
      leverage: 5, notionalUsdPerTrade: 100,
      entry: { ...DEFAULT_ENTRY_CONFIG }, exit: { ...DEFAULT_EXIT_CONFIG }, scorer: 'v6',
    });
    const noVvv = await runBacktest(prisma, {
      symbols: NO_VVV,
      windowStart: w.start, windowEnd: w.end,
      leverage: 5, notionalUsdPerTrade: 100,
      entry: { ...DEFAULT_ENTRY_CONFIG }, exit: { ...DEFAULT_EXIT_CONFIG }, scorer: 'v6',
    });

    const vvvOnly = withVvv.filter((t) => t.symbol === 'VVV');
    const otherOnly = withVvv.filter((t) => t.symbol !== 'VVV');

    const sumPct = (ts: typeof withVvv) => ts.reduce((s, t) => s + t.realizedPnlPct, 0);
    const wins = (ts: typeof withVvv) => ts.filter((t) => t.realizedPnl > 0).length;

    console.log(
      '  With VVV:       ' + withVvv.length.toString().padStart(4) + ' trades, ' +
      ((wins(withVvv) / withVvv.length) * 100).toFixed(0) + '% WR, ' +
      sumPct(withVvv).toFixed(1).padStart(7) + '% total'
    );
    console.log(
      '  VVV only:       ' + vvvOnly.length.toString().padStart(4) + ' trades, ' +
      ((wins(vvvOnly) / (vvvOnly.length || 1)) * 100).toFixed(0) + '% WR, ' +
      sumPct(vvvOnly).toFixed(1).padStart(7) + '% total'
    );
    console.log(
      '  5 syms ex-VVV:  ' + otherOnly.length.toString().padStart(4) + ' trades, ' +
      ((wins(otherOnly) / (otherOnly.length || 1)) * 100).toFixed(0) + '% WR, ' +
      sumPct(otherOnly).toFixed(1).padStart(7) + '% total'
    );
    console.log(
      '  NO_VVV run:     ' + noVvv.length.toString().padStart(4) + ' trades, ' +
      ((wins(noVvv) / (noVvv.length || 1)) * 100).toFixed(0) + '% WR, ' +
      sumPct(noVvv).toFixed(1).padStart(7) + '% total'
    );
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
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
