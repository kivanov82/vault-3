/**
 * Past Week Independent Trading Analysis
 *
 * Usage: npx tsx scripts/ml/weekly-independent-analysis.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DAYS = 7;
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
}

async function main() {
  console.log(`\n🎯 Independent Trading — Past ${DAYS} Days`);
  console.log(`   Since: ${since.toISOString()}\n`);

  // All positions created in window (by createdAt)
  const all = await prisma.independentPosition.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
  });

  const closed = all.filter((p) => p.status === 'closed');
  const open = all.filter((p) => p.status === 'open');
  const confirmed = all.filter((p) => p.status === 'confirmed');

  console.log('═'.repeat(70));
  console.log('Position Counts');
  console.log('═'.repeat(70));
  console.log(`  Created in window:     ${all.length}`);
  console.log(`  Closed:                ${closed.length}`);
  console.log(`  Open:                  ${open.length}`);
  console.log(`  Confirmed by target:   ${confirmed.length}`);

  if (all.length === 0) {
    console.log('\n⏳ No positions in the past week.');
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  // By side
  const longs = all.filter((p) => p.side === 'long');
  const shorts = all.filter((p) => p.side === 'short');
  console.log(`  Longs / Shorts:        ${longs.length} / ${shorts.length}`);

  // Overall P&L (closed only)
  if (closed.length > 0) {
    const totalPnl = closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const totalPnlPct = closed.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0);
    const avgPnlPct = totalPnlPct / closed.length;
    const wins = closed.filter((p) => (p.realizedPnl ?? 0) > 0);
    const losses = closed.filter((p) => (p.realizedPnl ?? 0) <= 0);
    const winRate = (wins.length / closed.length) * 100;
    const avgWin =
      wins.length > 0
        ? wins.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / wins.length
        : 0;
    const avgLoss =
      losses.length > 0
        ? losses.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / losses.length
        : 0;
    const bestTrade = closed.reduce(
      (best, p) => ((p.realizedPnlPct ?? -Infinity) > (best.realizedPnlPct ?? -Infinity) ? p : best),
      closed[0]
    );
    const worstTrade = closed.reduce(
      (worst, p) => ((p.realizedPnlPct ?? Infinity) < (worst.realizedPnlPct ?? Infinity) ? p : worst),
      closed[0]
    );

    console.log('\n' + '═'.repeat(70));
    console.log('Overall P&L (Closed Only)');
    console.log('═'.repeat(70));
    console.log(`  Total P&L:             ${fmtUsd(totalPnl)}`);
    console.log(`  Total P&L %:           ${fmtPct(totalPnlPct)}`);
    console.log(`  Avg P&L per trade:     ${fmtPct(avgPnlPct)}`);
    console.log(`  Win rate:              ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
    console.log(`  Avg win:               ${fmtPct(avgWin)}`);
    console.log(`  Avg loss:              ${fmtPct(avgLoss)}`);
    const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;
    console.log(`  Expectancy per trade:  ${fmtPct(expectancy)}`);
    console.log(`  Best:                  ${bestTrade.symbol} ${fmtPct(bestTrade.realizedPnlPct)}`);
    console.log(`  Worst:                 ${worstTrade.symbol} ${fmtPct(worstTrade.realizedPnlPct)}`);
  }

  // By exit reason
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('By Exit Reason');
    console.log('═'.repeat(70));
    console.log(
      'Reason'.padEnd(20) +
        'Count'.padStart(7) +
        'Total $'.padStart(12) +
        'Avg %'.padStart(10) +
        'Win %'.padStart(10)
    );
    console.log('─'.repeat(70));

    const reasons = new Map<string, typeof closed>();
    for (const p of closed) {
      const r = p.exitReason ?? 'unknown';
      if (!reasons.has(r)) reasons.set(r, []);
      reasons.get(r)!.push(p);
    }

    const sorted = Array.from(reasons.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [reason, positions] of sorted) {
      const totalPnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const avgPnlPct =
        positions.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / positions.length;
      const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
      const winRate = (wins / positions.length) * 100;
      console.log(
        reason.padEnd(20) +
          positions.length.toString().padStart(7) +
          fmtUsd(totalPnl).padStart(12) +
          fmtPct(avgPnlPct).padStart(10) +
          (winRate.toFixed(0) + '%').padStart(10)
      );
    }
  }

  // By symbol
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('By Symbol (closed only)');
    console.log('═'.repeat(70));
    console.log(
      'Symbol'.padEnd(12) +
        'Count'.padStart(7) +
        'Total $'.padStart(12) +
        'Avg %'.padStart(10) +
        'Win %'.padStart(10)
    );
    console.log('─'.repeat(70));

    const symMap = new Map<string, typeof closed>();
    for (const p of closed) {
      if (!symMap.has(p.symbol)) symMap.set(p.symbol, []);
      symMap.get(p.symbol)!.push(p);
    }
    const symSorted = Array.from(symMap.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [sym, positions] of symSorted) {
      const totalPnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const avgPnlPct =
        positions.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / positions.length;
      const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
      const winRate = (wins / positions.length) * 100;
      console.log(
        sym.padEnd(12) +
          positions.length.toString().padStart(7) +
          fmtUsd(totalPnl).padStart(12) +
          fmtPct(avgPnlPct).padStart(10) +
          (winRate.toFixed(0) + '%').padStart(10)
      );
    }
  }

  // By prediction score bucket
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('By Prediction Score');
    console.log('═'.repeat(70));
    const buckets = [
      { min: 80, max: 85, label: '80-85' },
      { min: 85, max: 90, label: '85-90' },
      { min: 90, max: 95, label: '90-95' },
      { min: 95, max: 1000, label: '95+  ' },
    ];
    for (const b of buckets) {
      const positions = closed.filter(
        (p) => (p.predictionScore ?? 0) >= b.min && (p.predictionScore ?? 0) < b.max
      );
      if (positions.length === 0) continue;
      const totalPnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const avgPnlPct =
        positions.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / positions.length;
      const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
      const winRate = (wins / positions.length) * 100;
      console.log(
        `  ${b.label}  ${positions.length.toString().padStart(4)} pos   ${fmtUsd(totalPnl).padStart(10)}   avg ${fmtPct(
          avgPnlPct
        ).padStart(8)}   win ${winRate.toFixed(0)}%`
      );
    }
  }

  // By side (long/short)
  if (closed.length > 0 && (longs.length > 0 || shorts.length > 0)) {
    console.log('\n' + '═'.repeat(70));
    console.log('By Side');
    console.log('═'.repeat(70));
    for (const side of ['long', 'short']) {
      const positions = closed.filter((p) => p.side === side);
      if (positions.length === 0) continue;
      const totalPnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
      const avgPnlPct =
        positions.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / positions.length;
      const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
      const winRate = (wins / positions.length) * 100;
      console.log(
        `  ${side.toUpperCase().padEnd(6)} ${positions.length
          .toString()
          .padStart(4)} pos   ${fmtUsd(totalPnl).padStart(10)}   avg ${fmtPct(avgPnlPct).padStart(
          8
        )}   win ${winRate.toFixed(0)}%`
      );
    }
  }

  // Hold time distribution (closed only)
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('Hold Time');
    console.log('═'.repeat(70));
    const holdHoursList = closed
      .filter((p) => p.closedAt)
      .map((p) => (p.closedAt!.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60));
    holdHoursList.sort((a, b) => a - b);
    const median = holdHoursList[Math.floor(holdHoursList.length / 2)] ?? 0;
    const avg = holdHoursList.reduce((s, h) => s + h, 0) / holdHoursList.length;
    const under1h = holdHoursList.filter((h) => h < 1).length;
    const under4h = holdHoursList.filter((h) => h < 4).length;
    console.log(`  Median hold:           ${median.toFixed(2)}h`);
    console.log(`  Avg hold:              ${avg.toFixed(2)}h`);
    console.log(
      `  Under 1h:              ${under1h} (${((under1h / closed.length) * 100).toFixed(0)}%)`
    );
    console.log(
      `  Under 4h:              ${under4h} (${((under4h / closed.length) * 100).toFixed(0)}%)`
    );
  }

  // Instant-close check (entry == exit, 0% P&L)
  if (closed.length > 0) {
    const instant = closed.filter(
      (p) =>
        p.closedAt &&
        p.closedAt.getTime() - p.createdAt.getTime() < 10 * 60 * 1000 &&
        Math.abs(p.realizedPnlPct ?? 0) < 0.5
    );
    if (instant.length > 0) {
      console.log('\n' + '═'.repeat(70));
      console.log(
        `⚠️  Instant closes (< 10 min, |P&L| < 0.5%): ${instant.length} (${(
          (instant.length / closed.length) *
          100
        ).toFixed(0)}%)`
      );
      const byReason = new Map<string, number>();
      for (const p of instant) {
        const r = p.exitReason ?? 'unknown';
        byReason.set(r, (byReason.get(r) ?? 0) + 1);
      }
      for (const [r, c] of byReason) console.log(`    ${r}: ${c}`);
    }
  }

  // Recent 15 closed
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('Last 15 Closed Positions');
    console.log('═'.repeat(70));
    console.log(
      'Date'.padEnd(12) +
        'Symbol'.padEnd(9) +
        'Side'.padEnd(6) +
        'P&L %'.padStart(10) +
        'Hold'.padStart(8) +
        'Reason'.padStart(18) +
        'Score'.padStart(7)
    );
    console.log('─'.repeat(70));
    const recent = [...closed].reverse().slice(0, 15);
    for (const p of recent) {
      const date = p.closedAt?.toISOString().substring(5, 16).replace('T', ' ') ?? '-';
      const hold = p.closedAt
        ? ((p.closedAt.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60)).toFixed(1) + 'h'
        : '-';
      console.log(
        date.padEnd(12) +
          p.symbol.padEnd(9) +
          p.side.padEnd(6) +
          fmtPct(p.realizedPnlPct).padStart(10) +
          hold.padStart(8) +
          (p.exitReason ?? '-').padStart(18) +
          (p.predictionScore?.toFixed(0) ?? '-').padStart(7)
      );
    }
  }

  // Daily P&L
  if (closed.length > 0) {
    console.log('\n' + '═'.repeat(70));
    console.log('Daily P&L');
    console.log('═'.repeat(70));
    const byDay = new Map<string, { pnl: number; count: number; wins: number }>();
    for (const p of closed) {
      const day = p.closedAt?.toISOString().substring(0, 10) ?? 'unknown';
      if (!byDay.has(day)) byDay.set(day, { pnl: 0, count: 0, wins: 0 });
      const entry = byDay.get(day)!;
      entry.pnl += p.realizedPnl ?? 0;
      entry.count += 1;
      if ((p.realizedPnl ?? 0) > 0) entry.wins += 1;
    }
    const daySorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [day, stats] of daySorted) {
      const winRate = (stats.wins / stats.count) * 100;
      console.log(
        `  ${day}   ${stats.count.toString().padStart(3)} trades   ${fmtUsd(stats.pnl).padStart(
          10
        )}   win ${winRate.toFixed(0)}%`
      );
    }
  }

  console.log('');
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  console.error(error.stack);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
