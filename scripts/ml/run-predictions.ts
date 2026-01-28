/**
 * Run Predictions
 *
 * Runs the prediction engine on current market conditions
 * and validates past predictions.
 *
 * Usage: npm run ml:predict
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { predictionEngine } from '../../src/service/ml/PredictionEngine';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_VAULT = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

async function getLatestIndicators(symbol: string) {
  return prisma.technicalIndicator.findFirst({
    where: { symbol, timeframe: '1h' },
    orderBy: { timestamp: 'desc' }
  });
}

async function getLatestCandles(symbol: string, count: number = 24) {
  return prisma.candle.findMany({
    where: { symbol, timeframe: '1h' },
    orderBy: { timestamp: 'desc' },
    take: count
  });
}

async function getRecentTrades(symbol: string) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.trade.count({
    where: {
      traderAddress: TARGET_VAULT,
      symbol,
      timestamp: { gte: yesterday }
    }
  });
}

async function runPredictions() {
  console.log('🔮 Running Predictions\n');

  // Get active symbols (traded in last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const activeSymbols = await prisma.trade.findMany({
    where: {
      traderAddress: TARGET_VAULT,
      timestamp: { gte: thirtyDaysAgo }
    },
    select: { symbol: true },
    distinct: ['symbol']
  });

  const symbols = activeSymbols.map(s => s.symbol);
  console.log(`📊 Checking ${symbols.length} active symbols...\n`);

  const now = new Date();
  const predictions: Array<{
    symbol: string;
    willTrade: boolean;
    confidence: number;
    direction: string | null;
    reasons: string[];
  }> = [];

  for (const symbol of symbols) {
    // Get current data
    const indicator = await getLatestIndicators(symbol);
    const candles = await getLatestCandles(symbol);
    const recentTrades = await getRecentTrades(symbol);

    if (!indicator || candles.length < 2) continue;

    // Calculate price changes
    const currentCandle = candles[0];
    const candle1hAgo = candles[1];
    const candle24hAgo = candles[23];

    const priceChange1h = candle1hAgo
      ? ((currentCandle.close - candle1hAgo.close) / candle1hAgo.close) * 100
      : null;
    const priceChange24h = candle24hAgo
      ? ((currentCandle.close - candle24hAgo.close) / candle24hAgo.close) * 100
      : null;

    // BB position
    let bbPosition: number | null = null;
    if (indicator.bbUpper && indicator.bbLower) {
      const range = indicator.bbUpper - indicator.bbLower;
      bbPosition = range > 0 ? (currentCandle.close - indicator.bbLower) / range : 0.5;
    }

    // Get BTC for context
    const btcCandles = await getLatestCandles('BTC', 2);
    const btcChange1h = btcCandles.length >= 2
      ? ((btcCandles[0].close - btcCandles[1].close) / btcCandles[1].close) * 100
      : null;

    // Get funding
    const funding = await prisma.fundingRate.findFirst({
      where: { symbol },
      orderBy: { timestamp: 'desc' }
    });

    // Run prediction
    const result = await predictionEngine.predict({
      symbol,
      timestamp: now,
      rsi14: indicator.rsi14,
      macd: indicator.macd,
      macdSignal: indicator.macdSignal,
      bbPosition,
      bbWidth: indicator.bbWidth,
      atrPercent: indicator.atr14 ? (indicator.atr14 / currentCandle.close) * 100 : null,
      priceChange1h,
      priceChange24h,
      btcChange1h,
      fundingRate: funding?.rate ?? null,
      hourOfDay: now.getUTCHours(),
      targetTradesLast24h: recentTrades
    });

    predictions.push({
      symbol,
      willTrade: result.willTrade,
      confidence: result.confidence,
      direction: result.direction,
      reasons: result.reasons
    });
  }

  // Sort by confidence
  predictions.sort((a, b) => b.confidence - a.confidence);

  // Display results
  console.log('═'.repeat(60));
  console.log('🎯 TRADE PREDICTIONS (Next Hour)');
  console.log('═'.repeat(60));

  const likelyTrades = predictions.filter(p => p.willTrade);
  const unlikelyTrades = predictions.filter(p => !p.willTrade);

  if (likelyTrades.length > 0) {
    console.log('\n✅ LIKELY TO TRADE:');
    console.log('─'.repeat(40));
    for (const p of likelyTrades) {
      console.log(`\n   ${p.symbol} (${p.confidence.toFixed(0)}% confidence)`);
      console.log(`   Direction: ${p.direction || 'unknown'}`);
      console.log(`   Reasons:`);
      p.reasons.forEach(r => console.log(`     • ${r}`));
    }
  } else {
    console.log('\n   No high-confidence trade predictions');
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Symbols analyzed: ${predictions.length}`);
  console.log(`   Likely trades: ${likelyTrades.length}`);
  console.log(`   Avg confidence: ${(predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length).toFixed(1)}%`);

  // Top 5 by confidence (even if not "likely")
  console.log('\n🔝 Top 5 by confidence:');
  for (const p of predictions.slice(0, 5)) {
    const status = p.willTrade ? '✅' : '⚪';
    console.log(`   ${status} ${p.symbol}: ${p.confidence.toFixed(0)}% ${p.direction ? `(${p.direction})` : ''}`);
  }

  console.log('\n' + '═'.repeat(60));
}

async function validatePastPredictions() {
  console.log('\n📈 Validating Past Predictions...\n');

  const stats = await predictionEngine.getStats();

  console.log('═'.repeat(50));
  console.log('📊 PREDICTION PERFORMANCE');
  console.log('═'.repeat(50));
  console.log(`   Total predictions: ${stats.totalPredictions}`);
  console.log(`   Validated: ${stats.validatedPredictions}`);
  console.log(`   Overall accuracy: ${stats.accuracy.toFixed(1)}%`);

  if (stats.byConfidence.length > 0) {
    console.log('\n   Accuracy by confidence:');
    for (const c of stats.byConfidence) {
      if (c.count > 0) {
        console.log(`     ${c.range}: ${c.accuracy.toFixed(1)}% (n=${c.count})`);
      }
    }
  }
}

async function main() {
  try {
    await runPredictions();
    await validatePastPredictions();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(console.error);
