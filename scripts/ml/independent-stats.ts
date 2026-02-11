/**
 * Independent Trading Stats
 *
 * Shows performance metrics for autonomous trading positions.
 *
 * Usage: npm run ml:independent-stats
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
  console.log('🎯 Independent Trading Stats\n');

  // Configuration (v3 defaults - time-based exit)
  const config = {
    maxAllocationPct: parseFloat(process.env.INDEPENDENT_MAX_ALLOCATION_PCT || '0.10'),
    maxPositions: parseInt(process.env.INDEPENDENT_MAX_POSITIONS || '3', 10),
    leverage: parseInt(process.env.INDEPENDENT_LEVERAGE || '5', 10),
    useTimeBasedExit: process.env.INDEPENDENT_USE_TIME_EXIT !== 'false',
    holdHours: parseInt(process.env.INDEPENDENT_HOLD_HOURS || '4', 10),
    tpPct: parseFloat(process.env.INDEPENDENT_TP_PCT || '0.20'),
    slPct: parseFloat(process.env.INDEPENDENT_SL_PCT || '0.12'),
    enabled: process.env.ENABLE_INDEPENDENT_TRADING === 'true',
  };

  console.log('═'.repeat(60));
  console.log('Configuration (v3)');
  console.log('═'.repeat(60));
  console.log(`  Enabled:               ${config.enabled ? '✅ YES' : '❌ NO'}`);
  console.log(`  Max allocation:        ${(config.maxAllocationPct * 100).toFixed(1)}% of vault`);
  console.log(`  Max positions:         ${config.maxPositions}`);
  console.log(`  Leverage:              ${config.leverage}x`);
  if (config.useTimeBasedExit) {
    console.log(`  Exit strategy:         ${config.holdHours}h fixed hold (no TP/SL)`);
  } else {
    console.log(`  Take Profit:           +${(config.tpPct * 100).toFixed(1)}%`);
    console.log(`  Stop Loss:             -${(config.slPct * 100).toFixed(1)}%`);
  }

  // Overall counts
  const total = await prisma.independentPosition.count();
  const open = await prisma.independentPosition.count({ where: { status: 'open' } });
  const confirmed = await prisma.independentPosition.count({ where: { status: 'confirmed' } });
  const closed = await prisma.independentPosition.count({ where: { status: 'closed' } });

  console.log('\n' + '═'.repeat(60));
  console.log('Position Counts');
  console.log('═'.repeat(60));
  console.log(`  Total positions:       ${total}`);
  console.log(`  Open:                  ${open}`);
  console.log(`  Confirmed by target:   ${confirmed}`);
  console.log(`  Closed:                ${closed}`);

  if (total === 0) {
    console.log('\n⏳ No independent positions yet.');
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  // Open positions detail
  if (open > 0 || confirmed > 0) {
    const openPositions = await prisma.independentPosition.findMany({
      where: { status: { in: ['open', 'confirmed'] } },
      orderBy: { createdAt: 'desc' },
    });

    console.log('\n' + '═'.repeat(60));
    console.log('Open Positions');
    console.log('═'.repeat(60));
    console.log('Symbol'.padEnd(10) + 'Entry'.padStart(10) + 'Size $'.padStart(10) + 'TP'.padStart(10) + 'SL'.padStart(10) + 'Status'.padStart(12));
    console.log('─'.repeat(62));

    for (const p of openPositions) {
      const status = p.confirmedByTarget ? 'confirmed' : 'open';
      console.log(
        `${p.symbol.padEnd(10)}${p.entryPrice.toFixed(2).padStart(10)}${p.sizeUsd.toFixed(0).padStart(10)}${p.tpPrice.toFixed(2).padStart(10)}${p.slPrice.toFixed(2).padStart(10)}${status.padStart(12)}`
      );
    }

    // Total current allocation
    const currentAllocation = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
    console.log('─'.repeat(62));
    console.log(`${'Total allocation:'.padEnd(20)}$${currentAllocation.toFixed(2)}`);
  }

  // Closed positions performance
  if (closed > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log('Closed Position Performance');
    console.log('═'.repeat(60));

    // By exit reason
    const byReason = await prisma.independentPosition.groupBy({
      by: ['exitReason'],
      where: { status: 'closed' },
      _count: true,
      _sum: { realizedPnl: true, realizedPnlPct: true },
      _avg: { realizedPnlPct: true },
    });

    console.log('\nBy Exit Reason:');
    console.log('Reason'.padEnd(18) + 'Count'.padStart(8) + 'Total P&L'.padStart(12) + 'Avg P&L %'.padStart(12) + 'Win Rate'.padStart(10));
    console.log('─'.repeat(60));

    for (const r of byReason) {
      const reason = r.exitReason || 'unknown';
      const totalPnl = r._sum.realizedPnl ?? 0;
      const avgPnlPct = r._avg.realizedPnlPct ?? 0;

      // Calculate win rate for this reason
      const wins = await prisma.independentPosition.count({
        where: { status: 'closed', exitReason: r.exitReason, realizedPnl: { gt: 0 } }
      });
      const winRate = ((wins / r._count) * 100).toFixed(0);

      console.log(
        `${reason.padEnd(18)}${r._count.toString().padStart(8)}${('$' + totalPnl.toFixed(2)).padStart(12)}${(avgPnlPct.toFixed(2) + '%').padStart(12)}${(winRate + '%').padStart(10)}`
      );
    }

    // Overall P&L
    const pnlAgg = await prisma.independentPosition.aggregate({
      where: { status: 'closed' },
      _sum: { realizedPnl: true, realizedPnlPct: true },
      _avg: { realizedPnlPct: true },
    });

    const wins = await prisma.independentPosition.count({
      where: { status: 'closed', realizedPnl: { gt: 0 } }
    });

    console.log('\n' + '═'.repeat(60));
    console.log('Overall Performance');
    console.log('═'.repeat(60));
    console.log(`  Total P&L:             $${(pnlAgg._sum.realizedPnl ?? 0).toFixed(2)}`);
    console.log(`  Total P&L %:           ${(pnlAgg._sum.realizedPnlPct ?? 0).toFixed(2)}%`);
    console.log(`  Avg P&L %:             ${(pnlAgg._avg.realizedPnlPct ?? 0).toFixed(2)}%`);
    console.log(`  Win rate:              ${((wins / closed) * 100).toFixed(1)}%`);
    console.log(`  Wins / Losses:         ${wins} / ${closed - wins}`);

    // Target confirmation rate
    const confirmedTotal = await prisma.independentPosition.count({
      where: { confirmedByTarget: true }
    });
    console.log(`  Target confirmation:   ${confirmedTotal} (${((confirmedTotal / total) * 100).toFixed(1)}%)`);
  }

  // By symbol
  const bySymbol = await prisma.independentPosition.groupBy({
    by: ['symbol'],
    _count: true,
    _sum: { realizedPnl: true },
    _avg: { realizedPnlPct: true },
    orderBy: { _count: { symbol: 'desc' } },
    take: 15,
  });

  if (bySymbol.length > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log('By Symbol');
    console.log('═'.repeat(60));
    console.log('Symbol'.padEnd(12) + 'Count'.padStart(8) + 'Total P&L'.padStart(12) + 'Avg P&L %'.padStart(12));
    console.log('─'.repeat(44));

    for (const s of bySymbol) {
      const totalPnl = s._sum.realizedPnl ?? 0;
      const avgPnl = s._avg.realizedPnlPct ?? 0;
      console.log(
        `${s.symbol.padEnd(12)}${s._count.toString().padStart(8)}${('$' + totalPnl.toFixed(2)).padStart(12)}${(avgPnl.toFixed(2) + '%').padStart(12)}`
      );
    }
  }

  // By prediction score
  console.log('\n' + '═'.repeat(60));
  console.log('By Prediction Score');
  console.log('═'.repeat(60));

  for (const { min, max, label } of [
    { min: 80, max: 85, label: '80-85' },
    { min: 85, max: 90, label: '85-90' },
    { min: 90, max: 95, label: '90-95' },
    { min: 95, max: 101, label: '95+' },
  ]) {
    const count = await prisma.independentPosition.count({
      where: { predictionScore: { gte: min, lt: max } }
    });
    const wins = await prisma.independentPosition.count({
      where: { predictionScore: { gte: min, lt: max }, realizedPnl: { gt: 0 } }
    });
    const pnl = await prisma.independentPosition.aggregate({
      where: { predictionScore: { gte: min, lt: max }, status: 'closed' },
      _sum: { realizedPnl: true },
      _avg: { realizedPnlPct: true },
    });

    if (count > 0) {
      const winRate = count > 0 ? ((wins / count) * 100).toFixed(0) : '-';
      const avgPnl = pnl._avg.realizedPnlPct?.toFixed(2) ?? '-';
      console.log(`  Score ${label.padEnd(8)} ${count.toString().padStart(5)} pos, ${winRate.padStart(3)}% win, ${avgPnl.padStart(6)}% avg`);
    }
  }

  // Recent closed positions
  const recentClosed = await prisma.independentPosition.findMany({
    where: { status: 'closed' },
    orderBy: { closedAt: 'desc' },
    take: 10,
  });

  if (recentClosed.length > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log('Recent Closed Positions');
    console.log('═'.repeat(60));
    console.log('Time'.padEnd(8) + 'Symbol'.padEnd(10) + 'Entry'.padStart(10) + 'Exit'.padStart(10) + 'P&L %'.padStart(10) + 'Reason'.padStart(12));
    console.log('─'.repeat(60));

    for (const p of recentClosed) {
      const time = p.closedAt?.toISOString().substring(11, 16) ?? '-';
      const pnlPct = p.realizedPnlPct !== null ? (p.realizedPnlPct >= 0 ? '+' : '') + p.realizedPnlPct.toFixed(2) + '%' : '-';
      console.log(
        `${time.padEnd(8)}${p.symbol.padEnd(10)}${p.entryPrice.toFixed(2).padStart(10)}${(p.exitPrice?.toFixed(2) ?? '-').padStart(10)}${pnlPct.padStart(10)}${(p.exitReason ?? '-').padStart(12)}`
      );
    }
  }

  // Date range
  const dateRange = await prisma.independentPosition.aggregate({
    _min: { createdAt: true },
    _max: { createdAt: true },
  });

  if (dateRange._min.createdAt && dateRange._max.createdAt) {
    console.log('\n' + '═'.repeat(60));
    console.log(`Date range: ${dateRange._min.createdAt.toISOString().split('T')[0]} to ${dateRange._max.createdAt.toISOString().split('T')[0]}`);
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
