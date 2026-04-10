/**
 * Compute baselines for the Jan 1 - Mar 15, 2026 backtest window.
 *
 *  1. Target trader P&L (original profiled target, 0x4cb5...)
 *     — sum of realized P&L on symbols in our backtest scope.
 *
 *  2. Buy-and-hold per symbol — price move from first to last candle.
 *
 * Usage: npx tsx scripts/ml/compute-baselines.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-03-15T00:00:00Z');

// Same scope as backtest
const SYMBOLS = [
  'BTC','ETH','SOL',
  'HYPE','VVV','SPX','SKY','VIRTUAL',
  'MON','PUMP','FARTCOIN','kPEPE',
  'ZEC','ETHFI','AVNT','IP',
];

const ORIGINAL_TARGET = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

function fmt(n: number | null | undefined, dec: number = 2, sign: boolean = false): string {
  if (n === null || n === undefined) return '-';
  const s = n.toFixed(dec);
  return sign && n >= 0 ? '+' + s : s;
}

async function main() {
  console.log(`\n📊 Baselines — ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}\n`);

  // ========== BUY AND HOLD ==========
  console.log('═'.repeat(80));
  console.log('BUY-AND-HOLD PER SYMBOL');
  console.log('═'.repeat(80));
  console.log('Symbol'.padEnd(14) + 'Start $'.padStart(12) + 'End $'.padStart(12) + 'Change %'.padStart(12) + 'Pnl per $100'.padStart(14));
  console.log('─'.repeat(80));

  let bhSumPct = 0;
  let bhCount = 0;
  const bhRows: Array<{ sym: string; pct: number }> = [];
  for (const sym of SYMBOLS) {
    const first = await prisma.candle.findFirst({
      where: { symbol: sym, timeframe: '1h', timestamp: { gte: START, lte: END } },
      orderBy: { timestamp: 'asc' },
    });
    const last = await prisma.candle.findFirst({
      where: { symbol: sym, timeframe: '1h', timestamp: { gte: START, lte: END } },
      orderBy: { timestamp: 'desc' },
    });
    if (!first || !last) continue;
    const pct = ((last.close - first.close) / first.close) * 100;
    bhSumPct += pct;
    bhCount++;
    bhRows.push({ sym, pct });
    console.log(
      sym.padEnd(14) +
      first.close.toFixed(4).padStart(12) +
      last.close.toFixed(4).padStart(12) +
      (fmt(pct, 1, true) + '%').padStart(12) +
      ('$' + fmt((pct / 100) * 100, 2, true)).padStart(14)
    );
  }
  const avgBh = bhSumPct / bhCount;
  console.log('─'.repeat(80));
  console.log(`Avg B&H return (equal-weighted): ${fmt(avgBh, 2, true)}%`);
  console.log(`Best: ${bhRows.sort((a,b)=>b.pct-a.pct)[0].sym} ${fmt(bhRows.sort((a,b)=>b.pct-a.pct)[0].pct, 1, true)}%`);
  console.log(`Worst: ${bhRows.sort((a,b)=>a.pct-b.pct)[0].sym} ${fmt(bhRows.sort((a,b)=>a.pct-b.pct)[0].pct, 1, true)}%`);

  // ========== TARGET TRADER P&L ==========
  console.log('\n' + '═'.repeat(80));
  console.log(`TARGET TRADER P&L  (${ORIGINAL_TARGET.slice(0, 10)}...)`);
  console.log('═'.repeat(80));

  const targetTrades = await prisma.trade.findMany({
    where: {
      traderAddress: ORIGINAL_TARGET,
      symbol: { in: SYMBOLS },
      timestamp: { gte: START, lte: END },
      pnl: { not: null },
    },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`  ${targetTrades.length} trades with P&L recorded\n`);

  console.log('Symbol'.padEnd(14) + 'Count'.padStart(8) + 'Total $'.padStart(12) + 'Avg $'.padStart(12) + 'WinRt'.padStart(8));
  console.log('─'.repeat(60));
  const bySym = new Map<string, typeof targetTrades>();
  for (const t of targetTrades) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
    bySym.get(t.symbol)!.push(t);
  }
  const sorted = [...bySym.entries()].sort((a, b) => b[1].length - a[1].length);
  let grandTotalPnl = 0;
  let grandWins = 0;
  let grandCount = 0;
  for (const [sym, trades] of sorted) {
    const total = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const avg = total / trades.length;
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const wr = (wins / trades.length) * 100;
    grandTotalPnl += total;
    grandWins += wins;
    grandCount += trades.length;
    console.log(
      sym.padEnd(14) +
      trades.length.toString().padStart(8) +
      ('$' + fmt(total, 0, true)).padStart(12) +
      ('$' + fmt(avg, 2, true)).padStart(12) +
      (wr.toFixed(0) + '%').padStart(8)
    );
  }
  console.log('─'.repeat(60));
  console.log(
    'TOTAL'.padEnd(14) +
    grandCount.toString().padStart(8) +
    ('$' + fmt(grandTotalPnl, 0, true)).padStart(12) +
    ('$' + fmt(grandTotalPnl / (grandCount || 1), 2, true)).padStart(12) +
    (((grandWins / (grandCount || 1)) * 100).toFixed(0) + '%').padStart(8)
  );

  // Also total target trader P&L across ALL symbols (not just scope)
  const allTargetTrades = await prisma.trade.findMany({
    where: {
      traderAddress: ORIGINAL_TARGET,
      timestamp: { gte: START, lte: END },
      pnl: { not: null },
    },
  });
  const allTotal = allTargetTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const allWins = allTargetTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  console.log(
    `\n  Target across ALL symbols: ${allTargetTrades.length} trades, ` +
    `$${fmt(allTotal, 0, true)} P&L, ${((allWins / allTargetTrades.length) * 100).toFixed(0)}% WR`
  );

  // ========== BTC regime context ==========
  console.log('\n' + '═'.repeat(80));
  console.log('BTC REGIME CONTEXT');
  console.log('═'.repeat(80));
  const btcFirst = await prisma.candle.findFirst({
    where: { symbol: 'BTC', timeframe: '1h', timestamp: { gte: START } },
    orderBy: { timestamp: 'asc' },
  });
  const btcLast = await prisma.candle.findFirst({
    where: { symbol: 'BTC', timeframe: '1h', timestamp: { lte: END } },
    orderBy: { timestamp: 'desc' },
  });
  const btcMin = await prisma.candle.findFirst({
    where: { symbol: 'BTC', timeframe: '1h', timestamp: { gte: START, lte: END } },
    orderBy: { close: 'asc' },
  });
  const btcMax = await prisma.candle.findFirst({
    where: { symbol: 'BTC', timeframe: '1h', timestamp: { gte: START, lte: END } },
    orderBy: { close: 'desc' },
  });
  if (btcFirst && btcLast && btcMin && btcMax) {
    console.log(`  BTC start:    $${btcFirst.close.toFixed(0)}  (${btcFirst.timestamp.toISOString().slice(0,10)})`);
    console.log(`  BTC end:      $${btcLast.close.toFixed(0)}  (${btcLast.timestamp.toISOString().slice(0,10)})`);
    console.log(`  BTC high:     $${btcMax.close.toFixed(0)}  (${btcMax.timestamp.toISOString().slice(0,10)})`);
    console.log(`  BTC low:      $${btcMin.close.toFixed(0)}  (${btcMin.timestamp.toISOString().slice(0,10)})`);
    console.log(`  Peak-to-trough: ${fmt(((btcMin.close - btcMax.close) / btcMax.close) * 100, 1)}%`);
    console.log(`  Start-to-end:   ${fmt(((btcLast.close - btcFirst.close) / btcFirst.close) * 100, 1, true)}%`);
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
