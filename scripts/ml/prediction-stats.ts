/**
 * Prediction Stats
 *
 * Shows prediction performance metrics for shadow mode validation.
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

async function main() {
  console.log('📊 Prediction Stats\n');

  // Overall counts
  const total = await prisma.prediction.count();
  const withAction = await prisma.prediction.count({
    where: { copyAction: { not: 'none' } }
  });
  const validated = await prisma.prediction.count({
    where: { validatedAt: { not: null } }
  });
  const correct = await prisma.prediction.count({
    where: { correct: true }
  });

  console.log('═'.repeat(50));
  console.log('Overall');
  console.log('═'.repeat(50));
  console.log(`  Total predictions:     ${total.toLocaleString()}`);
  console.log(`  With copy action:      ${withAction.toLocaleString()}`);
  console.log(`  Validated:             ${validated.toLocaleString()}`);
  console.log(`  Correct:               ${correct.toLocaleString()}`);
  if (validated > 0) {
    console.log(`  Accuracy:              ${((correct / validated) * 100).toFixed(1)}%`);
  }

  // Paper P&L
  const pnlAgg = await prisma.prediction.aggregate({
    where: { validatedAt: { not: null }, paperPnl: { not: null } },
    _sum: { paperPnl: true },
    _avg: { paperPnlPct: true },
    _count: true,
  });

  if (pnlAgg._count > 0) {
    console.log('\n' + '═'.repeat(50));
    console.log('Paper Trading P&L');
    console.log('═'.repeat(50));
    console.log(`  Total Paper P&L:       $${(pnlAgg._sum.paperPnl ?? 0).toFixed(2)}`);
    console.log(`  Avg P&L %:             ${(pnlAgg._avg.paperPnlPct ?? 0).toFixed(3)}%`);
  }

  // By confidence level
  console.log('\n' + '═'.repeat(50));
  console.log('By Confidence Level');
  console.log('═'.repeat(50));

  for (const { min, max, label } of [
    { min: 0, max: 50, label: 'Low (0-50)' },
    { min: 50, max: 65, label: 'Medium (50-65)' },
    { min: 65, max: 80, label: 'High (65-80)' },
    { min: 80, max: 100, label: 'Very High (80+)' },
  ]) {
    const count = await prisma.prediction.count({
      where: { prediction: { gte: min, lt: max } }
    });
    const actions = await prisma.prediction.count({
      where: { prediction: { gte: min, lt: max }, copyAction: { not: 'none' } }
    });
    const actionRate = count > 0 ? ((actions / count) * 100).toFixed(1) : '0.0';
    console.log(`  ${label.padEnd(20)} ${count.toString().padStart(6)} predictions, ${actionRate}% had actions`);
  }

  // By copy action type
  console.log('\n' + '═'.repeat(50));
  console.log('By Copy Action');
  console.log('═'.repeat(50));

  const actionTypes = await prisma.prediction.groupBy({
    by: ['copyAction'],
    _count: true,
    orderBy: { _count: { copyAction: 'desc' } }
  });

  for (const action of actionTypes) {
    if (action.copyAction) {
      console.log(`  ${action.copyAction.padEnd(12)} ${action._count.toString().padStart(6)}`);
    }
  }

  // Top symbols with predictions
  console.log('\n' + '═'.repeat(50));
  console.log('Top Symbols (by prediction count)');
  console.log('═'.repeat(50));

  const symbolStats = await prisma.prediction.groupBy({
    by: ['symbol'],
    _count: true,
    _avg: { prediction: true, paperPnlPct: true },
    orderBy: { _count: { symbol: 'desc' } },
    take: 15,
  });

  console.log('Symbol'.padEnd(12) + 'Count'.padStart(8) + 'Avg Score'.padStart(12) + 'Avg P&L %'.padStart(12));
  for (const s of symbolStats) {
    const avgScore = s._avg.prediction?.toFixed(1) ?? '-';
    const avgPnl = s._avg.paperPnlPct !== null ? s._avg.paperPnlPct.toFixed(3) + '%' : '-';
    console.log(
      `${s.symbol.padEnd(12)}${s._count.toString().padStart(8)}${avgScore.padStart(12)}${avgPnl.padStart(12)}`
    );
  }

  // Recent predictions
  console.log('\n' + '═'.repeat(50));
  console.log('Recent Predictions (last 10)');
  console.log('═'.repeat(50));

  const recent = await prisma.prediction.findMany({
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      timestamp: true,
      symbol: true,
      prediction: true,
      direction: true,
      copyAction: true,
      paperPnlPct: true,
      correct: true,
    }
  });

  console.log('Time'.padEnd(12) + 'Symbol'.padEnd(10) + 'Score'.padStart(6) + 'Dir'.padStart(6) + 'Action'.padStart(10) + 'P&L %'.padStart(10) + 'OK'.padStart(5));
  for (const p of recent) {
    const time = p.timestamp.toISOString().substring(11, 16);
    const dir = p.direction === 1 ? 'L' : p.direction === -1 ? 'S' : '-';
    const action = p.copyAction ?? '-';
    const pnl = p.paperPnlPct !== null ? p.paperPnlPct.toFixed(2) + '%' : '-';
    const ok = p.correct === true ? '✓' : p.correct === false ? '✗' : '-';
    console.log(
      `${time.padEnd(12)}${p.symbol.padEnd(10)}${p.prediction.toFixed(0).padStart(6)}${dir.padStart(6)}${action.padStart(10)}${pnl.padStart(10)}${ok.padStart(5)}`
    );
  }

  // Date range
  const dateRange = await prisma.prediction.aggregate({
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  if (dateRange._min.timestamp && dateRange._max.timestamp) {
    console.log('\n' + '═'.repeat(50));
    console.log(`Date range: ${dateRange._min.timestamp.toISOString().split('T')[0]} to ${dateRange._max.timestamp.toISOString().split('T')[0]}`);
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
