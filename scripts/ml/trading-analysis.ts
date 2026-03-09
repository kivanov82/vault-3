/**
 * Trading Analysis - Combined copy trading and independent trading performance
 *
 * Usage: npm run ml:analysis
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const OUR_ADDR = '0xc94376c6e3e85dfbe22026d9fe39b000bcf649f0';
const TARGET_ADDR = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

async function analyzeCopyTrading() {
  console.log('\n' + '═'.repeat(60));
  console.log('COPY TRADING PERFORMANCE (Our Vault)');
  console.log('═'.repeat(60));

  const ourFills = await prisma.fill.findMany({
    where: { traderAddress: OUR_ADDR },
    orderBy: { timestamp: 'asc' },
  });

  if (ourFills.length === 0) {
    console.log('No fills found for our vault');
    return;
  }

  let totalPnl = 0;
  let totalFees = 0;
  const symbolPnl = new Map<string, { pnl: number; fees: number; fills: number; closeFills: number }>();
  const monthlyPnl = new Map<string, { pnl: number; fees: number }>();
  const weeklyPnl = new Map<string, { pnl: number; fees: number }>();
  const dailyPnl = new Map<string, { pnl: number; fees: number }>();

  for (const fill of ourFills) {
    const raw = fill.rawData as any;
    const closedPnl = parseFloat(raw?.closedPnl || '0');
    const fee = parseFloat(raw?.fee || '0');

    totalPnl += closedPnl;
    totalFees += fee;

    // By symbol
    const sym = fill.symbol;
    const s = symbolPnl.get(sym) || { pnl: 0, fees: 0, fills: 0, closeFills: 0 };
    s.pnl += closedPnl;
    s.fees += fee;
    s.fills++;
    if (closedPnl !== 0) s.closeFills++;
    symbolPnl.set(sym, s);

    // By month
    const month = fill.timestamp.toISOString().slice(0, 7);
    const m = monthlyPnl.get(month) || { pnl: 0, fees: 0 };
    m.pnl += closedPnl;
    m.fees += fee;
    monthlyPnl.set(month, m);

    // By week
    const d = fill.timestamp;
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const week = weekStart.toISOString().slice(0, 10);
    const w = weeklyPnl.get(week) || { pnl: 0, fees: 0 };
    w.pnl += closedPnl;
    w.fees += fee;
    weeklyPnl.set(week, w);

    // By day
    const day = fill.timestamp.toISOString().slice(0, 10);
    const dd = dailyPnl.get(day) || { pnl: 0, fees: 0 };
    dd.pnl += closedPnl;
    dd.fees += fee;
    dailyPnl.set(day, dd);
  }

  const netPnl = totalPnl - totalFees;
  const dateFrom = ourFills[0].timestamp.toISOString().slice(0, 10);
  const dateTo = ourFills[ourFills.length - 1].timestamp.toISOString().slice(0, 10);

  console.log(`  Total fills:        ${ourFills.length}`);
  console.log(`  Date range:         ${dateFrom} to ${dateTo}`);
  console.log(`  Closed P&L:         $${totalPnl.toFixed(2)}`);
  console.log(`  Total fees:         $${totalFees.toFixed(2)}`);
  console.log(`  Net P&L:            $${netPnl.toFixed(2)}`);

  // Monthly breakdown
  console.log('\n' + '─'.repeat(60));
  console.log('Monthly P&L');
  console.log('─'.repeat(60));
  for (const [month, data] of [...monthlyPnl.entries()].sort()) {
    const net = data.pnl - data.fees;
    console.log(`  ${month}:  P&L $${data.pnl.toFixed(2).padStart(10)}  Fees $${data.fees.toFixed(2).padStart(8)}  Net $${net.toFixed(2).padStart(10)}`);
  }

  // Weekly breakdown
  console.log('\n' + '─'.repeat(60));
  console.log('Weekly P&L');
  console.log('─'.repeat(60));
  for (const [week, data] of [...weeklyPnl.entries()].sort()) {
    const net = data.pnl - data.fees;
    console.log(`  ${week}:  P&L $${data.pnl.toFixed(2).padStart(10)}  Fees $${data.fees.toFixed(2).padStart(8)}  Net $${net.toFixed(2).padStart(10)}`);
  }

  // Symbol breakdown (sorted by P&L)
  console.log('\n' + '─'.repeat(60));
  console.log('P&L by Symbol');
  console.log('─'.repeat(60));
  const sorted = [...symbolPnl.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  console.log('  ' + 'Symbol'.padEnd(12) + 'Fills'.padStart(6) + 'Closes'.padStart(8) + 'P&L'.padStart(12) + 'Fees'.padStart(10) + 'Net'.padStart(12));
  console.log('  ' + '─'.repeat(58));
  for (const [sym, data] of sorted) {
    const net = data.pnl - data.fees;
    console.log('  ' +
      sym.padEnd(12) +
      String(data.fills).padStart(6) +
      String(data.closeFills).padStart(8) +
      `$${data.pnl.toFixed(2)}`.padStart(12) +
      `$${data.fees.toFixed(2)}`.padStart(10) +
      `$${net.toFixed(2)}`.padStart(12)
    );
  }

  // Daily P&L for last 14 days
  console.log('\n' + '─'.repeat(60));
  console.log('Daily P&L (last 14 days)');
  console.log('─'.repeat(60));
  const recentDays = [...dailyPnl.entries()].sort().slice(-14);
  for (const [day, data] of recentDays) {
    const net = data.pnl - data.fees;
    const bar = net > 0 ? '+'.repeat(Math.min(Math.round(net / 5), 30)) : '-'.repeat(Math.min(Math.round(Math.abs(net) / 5), 30));
    console.log(`  ${day}:  Net $${net.toFixed(2).padStart(10)}  ${bar}`);
  }
}

async function analyzeTargetVault() {
  console.log('\n' + '═'.repeat(60));
  console.log('TARGET VAULT PERFORMANCE (Comparison)');
  console.log('═'.repeat(60));

  const targetFills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_ADDR },
    orderBy: { timestamp: 'asc' },
  });

  if (targetFills.length === 0) {
    console.log('No target fills found');
    return;
  }

  let totalPnl = 0;
  let totalFees = 0;
  const monthlyPnl = new Map<string, { pnl: number; fees: number }>();

  for (const fill of targetFills) {
    const raw = fill.rawData as any;
    totalPnl += parseFloat(raw?.closedPnl || '0');
    totalFees += parseFloat(raw?.fee || '0');

    const month = fill.timestamp.toISOString().slice(0, 7);
    const m = monthlyPnl.get(month) || { pnl: 0, fees: 0 };
    m.pnl += parseFloat(raw?.closedPnl || '0');
    m.fees += parseFloat(raw?.fee || '0');
    monthlyPnl.set(month, m);
  }

  console.log(`  Total fills:        ${targetFills.length}`);
  console.log(`  Closed P&L:         $${totalPnl.toFixed(2)}`);
  console.log(`  Total fees:         $${totalFees.toFixed(2)}`);
  console.log(`  Net P&L:            $${(totalPnl - totalFees).toFixed(2)}`);

  console.log('\n  Monthly:');
  for (const [month, data] of [...monthlyPnl.entries()].sort()) {
    const net = data.pnl - data.fees;
    console.log(`    ${month}:  Net $${net.toFixed(2).padStart(10)}`);
  }
}

async function analyzeIndependent() {
  console.log('\n' + '═'.repeat(60));
  console.log('INDEPENDENT TRADING PERFORMANCE');
  console.log('═'.repeat(60));

  const positions = await prisma.independentPosition.findMany({
    where: { status: 'closed' },
    orderBy: { createdAt: 'asc' },
  });

  if (positions.length === 0) {
    console.log('No closed independent positions');
    return;
  }

  const wins = positions.filter(p => (p.realizedPnl || 0) > 0);
  const losses = positions.filter(p => (p.realizedPnl || 0) <= 0);
  const totalPnl = positions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const avgWin = wins.length ? wins.reduce((s, p) => s + (p.realizedPnlPct || 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + (p.realizedPnlPct || 0), 0) / losses.length : 0;

  console.log(`  Closed positions:   ${positions.length}`);
  console.log(`  Win / Loss:         ${wins.length} / ${losses.length}`);
  console.log(`  Win rate:           ${(wins.length / positions.length * 100).toFixed(1)}%`);
  console.log(`  Total P&L:          $${totalPnl.toFixed(2)}`);
  console.log(`  Avg win:            ${avgWin.toFixed(2)}%`);
  console.log(`  Avg loss:           ${avgLoss.toFixed(2)}%`);

  // By symbol
  const bySymbol = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const p of positions) {
    const s = bySymbol.get(p.symbol) || { count: 0, pnl: 0, wins: 0 };
    s.count++;
    s.pnl += p.realizedPnl || 0;
    if ((p.realizedPnl || 0) > 0) s.wins++;
    bySymbol.set(p.symbol, s);
  }

  console.log('\n  By Symbol:');
  console.log('  ' + 'Symbol'.padEnd(12) + 'Count'.padStart(6) + 'Win%'.padStart(8) + 'P&L'.padStart(12));
  for (const [sym, data] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log('  ' +
      sym.padEnd(12) +
      String(data.count).padStart(6) +
      `${(data.wins / data.count * 100).toFixed(0)}%`.padStart(8) +
      `$${data.pnl.toFixed(2)}`.padStart(12)
    );
  }

  // Weekly
  const weeklyPnl = new Map<string, number>();
  for (const p of positions) {
    const d = p.createdAt;
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const week = weekStart.toISOString().slice(0, 10);
    weeklyPnl.set(week, (weeklyPnl.get(week) || 0) + (p.realizedPnl || 0));
  }

  console.log('\n  Weekly P&L:');
  for (const [week, pnl] of [...weeklyPnl.entries()].sort()) {
    console.log(`    ${week}:  $${pnl.toFixed(2)}`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  VAULT-3 TRADING ANALYSIS');
  console.log('  Generated: ' + new Date().toISOString().slice(0, 19));
  console.log('='.repeat(60));

  await analyzeCopyTrading();
  await analyzeTargetVault();
  await analyzeIndependent();

  console.log('\n' + '═'.repeat(60));
  console.log('ANALYSIS COMPLETE');
  console.log('═'.repeat(60));

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
