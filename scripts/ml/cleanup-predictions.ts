/**
 * Cleanup Historical Predictions
 *
 * Archives and removes predictions from the old mean-reversion strategy
 * to start fresh with the new momentum-based approach.
 *
 * Usage: npx ts-node scripts/ml/cleanup-predictions.ts
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
  console.log('🧹 Cleaning up historical predictions...\n');

  // Get stats before cleanup
  const totalBefore = await prisma.prediction.count();
  const validatedBefore = await prisma.prediction.count({
    where: { validatedAt: { not: null } }
  });

  const oldModelPredictions = await prisma.prediction.count({
    where: { modelVersion: 'pattern-v1' }
  });

  console.log('Before cleanup:');
  console.log(`  Total predictions:     ${totalBefore}`);
  console.log(`  Validated:             ${validatedBefore}`);
  console.log(`  Old model (pattern-v1): ${oldModelPredictions}`);

  // Archive summary to AnalysisReport before deleting
  const pnlStats = await prisma.prediction.aggregate({
    where: { validatedAt: { not: null }, modelVersion: 'pattern-v1' },
    _sum: { paperPnl: true, paperPnlPct: true },
    _avg: { paperPnlPct: true, prediction: true },
    _count: true,
  });

  const archive = {
    archivedAt: new Date().toISOString(),
    modelVersion: 'pattern-v1',
    totalPredictions: oldModelPredictions,
    validatedPredictions: pnlStats._count,
    totalPaperPnl: pnlStats._sum.paperPnl,
    totalPaperPnlPct: pnlStats._sum.paperPnlPct,
    avgPaperPnlPct: pnlStats._avg.paperPnlPct,
    avgScore: pnlStats._avg.prediction,
    reason: 'Strategy mismatch - old model used mean reversion signals, target uses momentum/breakout',
    newModelVersion: 'momentum-v2',
  };

  // Save archive record
  await prisma.analysisReport.create({
    data: {
      type: 'prediction-cleanup-archive',
      timestamp: new Date(),
      data: archive as any,
      summary: `Archived ${oldModelPredictions} predictions from pattern-v1 model. Total paper P&L was ${(pnlStats._sum.paperPnlPct ?? 0).toFixed(2)}% (avg ${(pnlStats._avg.paperPnlPct ?? 0).toFixed(3)}%). Cleaning up to start fresh with momentum-v2 model.`,
    },
  });

  console.log('\n📦 Archive saved to AnalysisReport');

  // Delete old predictions
  console.log('\n🗑️  Deleting old predictions...');

  const deleted = await prisma.prediction.deleteMany({
    where: { modelVersion: 'pattern-v1' }
  });

  console.log(`  Deleted: ${deleted.count} predictions`);

  // Verify cleanup
  const totalAfter = await prisma.prediction.count();
  console.log(`\nAfter cleanup:`);
  console.log(`  Total predictions:     ${totalAfter}`);

  console.log('\n✅ Cleanup complete! Ready for momentum-v2 predictions.');

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (error) => {
  console.error('Error:', error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
