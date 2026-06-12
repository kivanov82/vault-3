/**
 * Independent trading stats across multiple lookback windows (7 / 30 / 90 days).
 * P&L attributed by closedAt (realization date). Usage: npx tsx scripts/ml/independent-windows.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WINDOWS = [
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
  { label: 'Last 90d', days: 90 },
];

const usd = (n: number) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const pct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

async function main() {
  const now = Date.now();
  const maxSince = new Date(now - 90 * 86400_000);

  // Closed positions in the last 90d (by closedAt = when P&L realized)
  const closed = await prisma.independentPosition.findMany({
    where: { status: 'closed', closedAt: { gte: maxSince } },
    orderBy: { closedAt: 'asc' },
  });
  // Currently open / confirmed (unrealized, count only)
  const openNow = await prisma.independentPosition.findMany({
    where: { status: { in: ['open', 'confirmed'] } },
  });

  console.log(`\n🎯 Independent Trading — windows ending ${new Date(now).toISOString().slice(0, 16)}Z`);
  console.log(`   Closed positions (90d) loaded: ${closed.length} | currently open/confirmed: ${openNow.length}\n`);

  const rows: string[] = [];
  const header =
    'Window'.padEnd(10) +
    'Trades'.padStart(8) +
    'Total $'.padStart(12) +
    'Avg/trade'.padStart(11) +
    'Win%'.padStart(7) +
    'AvgWin'.padStart(9) +
    'AvgLoss'.padStart(9) +
    'Expect'.padStart(9) +
    'L/S'.padStart(8);
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const w of WINDOWS) {
    const since = new Date(now - w.days * 86400_000);
    const c = closed.filter((p) => p.closedAt && p.closedAt >= since);
    if (c.length === 0) {
      console.log(w.label.padEnd(10) + '0'.padStart(8) + '  (no closed trades)');
      continue;
    }
    const totalPnl = c.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const avgPct = c.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / c.length;
    const wins = c.filter((p) => (p.realizedPnl ?? 0) > 0);
    const losses = c.filter((p) => (p.realizedPnl ?? 0) <= 0);
    const winRate = (wins.length / c.length) * 100;
    const avgWin = wins.length ? wins.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / losses.length : 0;
    const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;
    const longs = c.filter((p) => p.side === 'long').length;
    const shorts = c.filter((p) => p.side === 'short').length;

    console.log(
      w.label.padEnd(10) +
        c.length.toString().padStart(8) +
        usd(totalPnl).padStart(12) +
        pct(avgPct).padStart(11) +
        (winRate.toFixed(0) + '%').padStart(7) +
        pct(avgWin).padStart(9) +
        pct(avgLoss).padStart(9) +
        pct(expectancy).padStart(9) +
        `${longs}/${shorts}`.padStart(8)
    );
  }

  // Per-window symbol + side breakdown for the 90d window (most context)
  const c90 = closed;
  if (c90.length) {
    console.log('\n' + '═'.repeat(60));
    console.log('By Symbol (90d, closed)');
    console.log('═'.repeat(60));
    const symMap = new Map<string, typeof c90>();
    for (const p of c90) {
      if (!symMap.has(p.symbol)) symMap.set(p.symbol, [] as any);
      symMap.get(p.symbol)!.push(p);
    }
    const sorted = Array.from(symMap.entries()).sort(
      (a, b) => b[1].reduce((s, p) => s + (p.realizedPnl ?? 0), 0) - a[1].reduce((s, p) => s + (p.realizedPnl ?? 0), 0)
    );
    console.log('Symbol'.padEnd(10) + 'Trades'.padStart(8) + 'Total $'.padStart(12) + 'Avg %'.padStart(10) + 'Win%'.padStart(7));
    console.log('─'.repeat(47));
    for (const [sym, ps] of sorted) {
      const t = ps.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const a = ps.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / ps.length;
      const wr = (ps.filter((p) => (p.realizedPnl ?? 0) > 0).length / ps.length) * 100;
      console.log(sym.padEnd(10) + ps.length.toString().padStart(8) + usd(t).padStart(12) + pct(a).padStart(10) + (wr.toFixed(0) + '%').padStart(7));
    }

    console.log('\n' + '═'.repeat(60));
    console.log('By Exit Reason (90d, closed)');
    console.log('═'.repeat(60));
    const rMap = new Map<string, typeof c90>();
    for (const p of c90) {
      const r = p.exitReason ?? 'unknown';
      if (!rMap.has(r)) rMap.set(r, [] as any);
      rMap.get(r)!.push(p);
    }
    const rSorted = Array.from(rMap.entries()).sort((a, b) => b[1].length - a[1].length);
    console.log('Reason'.padEnd(22) + 'Count'.padStart(7) + 'Total $'.padStart(12) + 'Avg %'.padStart(10) + 'Win%'.padStart(7));
    console.log('─'.repeat(58));
    for (const [r, ps] of rSorted) {
      const t = ps.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const a = ps.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / ps.length;
      const wr = (ps.filter((p) => (p.realizedPnl ?? 0) > 0).length / ps.length) * 100;
      console.log(r.padEnd(22) + ps.length.toString().padStart(7) + usd(t).padStart(12) + pct(a).padStart(10) + (wr.toFixed(0) + '%').padStart(7));
    }
  }

  if (openNow.length) {
    console.log('\n' + '═'.repeat(60));
    console.log('Currently Open / Confirmed (unrealized)');
    console.log('═'.repeat(60));
    for (const p of openNow) {
      const ageH = ((now - p.createdAt.getTime()) / 3_600_000).toFixed(1);
      console.log(`  ${p.symbol.padEnd(9)} ${p.side.padEnd(6)} score ${(p.predictionScore?.toFixed(0) ?? '-').padStart(4)}  age ${ageH}h  status=${p.status}`);
    }
  }

  console.log('');
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error('Error:', e.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
