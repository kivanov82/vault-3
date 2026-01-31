/**
 * Prediction Stats - Momentum v2
 *
 * Shows prediction performance metrics for the momentum-based strategy.
 *
 * Usage: npm run ml:stats
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const MODEL_VERSION = 'momentum-v2';

async function main() {
  console.log('📊 Prediction Stats (Momentum v2)\n');

  // Overall counts
  const total = await prisma.prediction.count({
    where: { modelVersion: MODEL_VERSION }
  });
  const withAction = await prisma.prediction.count({
    where: { modelVersion: MODEL_VERSION, copyAction: { not: 'none' } }
  });
  const validated = await prisma.prediction.count({
    where: { modelVersion: MODEL_VERSION, validatedAt: { not: null } }
  });
  const correct = await prisma.prediction.count({
    where: { modelVersion: MODEL_VERSION, correct: true }
  });

  console.log('═'.repeat(60));
  console.log('Overall');
  console.log('═'.repeat(60));
  console.log(`  Model version:         ${MODEL_VERSION}`);
  console.log(`  Total predictions:     ${total.toLocaleString()}`);
  console.log(`  With copy action:      ${withAction.toLocaleString()}`);
  console.log(`  Validated (4h):        ${validated.toLocaleString()}`);
  console.log(`  Correct:               ${correct.toLocaleString()}`);
  if (validated > 0) {
    console.log(`  Accuracy:              ${((correct / validated) * 100).toFixed(1)}%`);
  }

  if (total === 0) {
    console.log('\n⏳ No predictions yet. Start collecting data!');
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  // Paper P&L
  const pnlAgg = await prisma.prediction.aggregate({
    where: { modelVersion: MODEL_VERSION, validatedAt: { not: null }, paperPnlPct: { not: null } },
    _sum: { paperPnl: true, paperPnlPct: true },
    _avg: { paperPnlPct: true },
    _count: true,
  });

  if (pnlAgg._count > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log('Paper Trading P&L (4h validation window)');
    console.log('═'.repeat(60));
    console.log(`  Total Paper P&L:       $${(pnlAgg._sum.paperPnl ?? 0).toFixed(2)}`);
    console.log(`  Total P&L %:           ${(pnlAgg._sum.paperPnlPct ?? 0).toFixed(2)}%`);
    console.log(`  Avg P&L %:             ${(pnlAgg._avg.paperPnlPct ?? 0).toFixed(3)}%`);

    // Win rate
    const profitable = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, validatedAt: { not: null }, paperPnlPct: { gt: 0 } }
    });
    console.log(`  Win rate:              ${((profitable / pnlAgg._count) * 100).toFixed(1)}%`);
  }

  // By confidence level
  console.log('\n' + '═'.repeat(60));
  console.log('By Confidence Level');
  console.log('═'.repeat(60));

  for (const { min, max, label } of [
    { min: 0, max: 50, label: 'Low (0-50)' },
    { min: 50, max: 65, label: 'Medium (50-65)' },
    { min: 65, max: 80, label: 'High (65-80)' },
    { min: 80, max: 101, label: 'Very High (80+)' },
  ]) {
    const count = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, prediction: { gte: min, lt: max } }
    });
    const actions = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, prediction: { gte: min, lt: max }, copyAction: { not: 'none' } }
    });
    const validatedInRange = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, prediction: { gte: min, lt: max }, validatedAt: { not: null } }
    });
    const profitableInRange = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, prediction: { gte: min, lt: max }, validatedAt: { not: null }, paperPnlPct: { gt: 0 } }
    });

    const actionRate = count > 0 ? ((actions / count) * 100).toFixed(0) : '0';
    const winRate = validatedInRange > 0 ? ((profitableInRange / validatedInRange) * 100).toFixed(0) : '-';

    console.log(`  ${label.padEnd(18)} ${count.toString().padStart(5)} pred, ${actionRate.padStart(3)}% actions, ${winRate.padStart(3)}% win`);
  }

  // By direction
  console.log('\n' + '═'.repeat(60));
  console.log('By Direction');
  console.log('═'.repeat(60));

  for (const { dir, label } of [
    { dir: 1, label: 'Long' },
    { dir: -1, label: 'Short' },
  ]) {
    const count = await prisma.prediction.count({
      where: { modelVersion: MODEL_VERSION, direction: dir }
    });
    const pnl = await prisma.prediction.aggregate({
      where: { modelVersion: MODEL_VERSION, direction: dir, validatedAt: { not: null } },
      _sum: { paperPnlPct: true },
      _avg: { paperPnlPct: true },
      _count: true,
    });

    const avgPnl = pnl._avg.paperPnlPct !== null ? `${pnl._avg.paperPnlPct.toFixed(3)}%` : '-';
    console.log(`  ${label.padEnd(8)} ${count.toString().padStart(6)} predictions, avg P&L: ${avgPnl}`);
  }

  // By copy action type
  console.log('\n' + '═'.repeat(60));
  console.log('By Copy Action');
  console.log('═'.repeat(60));

  const actionTypes = await prisma.prediction.groupBy({
    by: ['copyAction'],
    where: { modelVersion: MODEL_VERSION },
    _count: true,
    orderBy: { _count: { copyAction: 'desc' } }
  });

  for (const action of actionTypes) {
    if (action.copyAction) {
      console.log(`  ${action.copyAction.padEnd(12)} ${action._count.toString().padStart(6)}`);
    }
  }

  // By reason (what signals are firing)
  console.log('\n' + '═'.repeat(60));
  console.log('Signal Frequency (from reasons)');
  console.log('═'.repeat(60));

  const predictions = await prisma.prediction.findMany({
    where: { modelVersion: MODEL_VERSION },
    select: { reasons: true },
  });

  const reasonCounts = new Map<string, number>();
  for (const p of predictions) {
    for (const reason of p.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  const sortedReasons = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  for (const [reason, count] of sortedReasons) {
    const pct = ((count / total) * 100).toFixed(0);
    console.log(`  ${reason.padEnd(20)} ${count.toString().padStart(6)} (${pct}%)`);
  }

  // Top symbols with predictions
  console.log('\n' + '═'.repeat(60));
  console.log('Top Symbols (by prediction count)');
  console.log('═'.repeat(60));

  const symbolStats = await prisma.prediction.groupBy({
    by: ['symbol'],
    where: { modelVersion: MODEL_VERSION },
    _count: true,
    _avg: { prediction: true, paperPnlPct: true },
    orderBy: { _count: { symbol: 'desc' } },
    take: 15,
  });

  console.log('Symbol'.padEnd(12) + 'Count'.padStart(8) + 'Avg Score'.padStart(12) + 'Avg P&L %'.padStart(12));
  console.log('─'.repeat(44));
  for (const s of symbolStats) {
    const avgScore = s._avg.prediction?.toFixed(1) ?? '-';
    const avgPnl = s._avg.paperPnlPct !== null ? s._avg.paperPnlPct.toFixed(3) + '%' : '-';
    console.log(
      `${s.symbol.padEnd(12)}${s._count.toString().padStart(8)}${avgScore.padStart(12)}${avgPnl.padStart(12)}`
    );
  }

  // Recent predictions
  console.log('\n' + '═'.repeat(60));
  console.log('Recent Predictions (last 10)');
  console.log('═'.repeat(60));

  const recent = await prisma.prediction.findMany({
    where: { modelVersion: MODEL_VERSION },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      timestamp: true,
      symbol: true,
      prediction: true,
      direction: true,
      copyAction: true,
      reasons: true,
      paperPnlPct: true,
      correct: true,
    }
  });

  console.log('Time'.padEnd(8) + 'Symbol'.padEnd(10) + 'Score'.padStart(6) + 'Dir'.padStart(5) + 'Action'.padStart(10) + 'P&L %'.padStart(10) + '  Signals');
  console.log('─'.repeat(70));
  for (const p of recent) {
    const time = p.timestamp.toISOString().substring(11, 16);
    const dir = p.direction === 1 ? 'L' : p.direction === -1 ? 'S' : '-';
    const action = p.copyAction ?? '-';
    const pnl = p.paperPnlPct !== null ? p.paperPnlPct.toFixed(2) + '%' : '-';
    const signals = p.reasons.slice(0, 3).join(', ');
    console.log(
      `${time.padEnd(8)}${p.symbol.padEnd(10)}${p.prediction.toFixed(0).padStart(6)}${dir.padStart(5)}${action.padStart(10)}${pnl.padStart(10)}  ${signals}`
    );
  }

  // Date range
  const dateRange = await prisma.prediction.aggregate({
    where: { modelVersion: MODEL_VERSION },
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  if (dateRange._min.timestamp && dateRange._max.timestamp) {
    console.log('\n' + '═'.repeat(60));
    console.log(`Date range: ${dateRange._min.timestamp.toISOString().split('T')[0]} to ${dateRange._max.timestamp.toISOString().split('T')[0]}`);
    console.log(`Validation window: 4 hours`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
