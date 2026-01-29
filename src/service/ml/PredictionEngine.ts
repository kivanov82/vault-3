/**
 * Prediction Engine
 *
 * Predicts whether the target vault will trade a symbol in the next hour.
 * Uses pattern matching based on historical analysis + simple scoring.
 *
 * Predictions are stored in the Prediction table for validation.
 */

import { prisma } from '../utils/db';

const TARGET_VAULT = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

// Thresholds from analysis
const PATTERNS = {
  // RSI patterns (from entry-signals analysis)
  RSI_OVERSOLD_THRESHOLD: 30,
  RSI_OVERBOUGHT_THRESHOLD: 70,
  RSI_SHORT_ENTRY_AVG: 39,  // Shorts enter at lower RSI

  // BB patterns (winners enter higher in BB)
  BB_WINNING_POSITION: 0.42,
  BB_LOSING_POSITION: 0.35,

  // Leverage patterns
  AVG_LEVERAGE_SHORTS: 6.4,
  AVG_LEVERAGE_LONGS: 4.4,

  // Time patterns (would need from trading-patterns analysis)
  ACTIVE_HOURS: [8, 9, 10, 14, 15, 16, 20, 21, 22],  // Peak trading hours UTC

  // Best symbols (from performance analysis)
  BEST_SYMBOLS: ['PUMP', 'VVV', 'ETH', 'IP', 'kPEPE', 'SPX', 'SOL', 'FARTCOIN'],
  WORST_SYMBOLS: ['XMR', 'AVNT', 'SKY', 'DYM', 'kBONK', 'GRASS', 'RESOLV']
};

interface PredictionInput {
  symbol: string;
  timestamp: Date;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  bbPosition: number | null;
  bbWidth: number | null;
  atrPercent: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  btcChange1h: number | null;
  fundingRate: number | null;
  hourOfDay: number;
  targetTradesLast24h: number;
}

interface PredictionResult {
  willTrade: boolean;
  confidence: number;  // 0-100
  direction: 'long' | 'short' | null;
  reasons: string[];
  score: number;
}

export class PredictionEngine {
  private modelVersion = 'v1.0-pattern-matching';

  /**
   * Predict if target will trade this symbol in the next hour
   */
  async predict(input: PredictionInput): Promise<PredictionResult> {
    const reasons: string[] = [];
    let score = 50;  // Start neutral

    // 1. Symbol quality (±15 points)
    if (PATTERNS.BEST_SYMBOLS.includes(input.symbol)) {
      score += 15;
      reasons.push(`${input.symbol} is a top performer`);
    } else if (PATTERNS.WORST_SYMBOLS.includes(input.symbol)) {
      score -= 15;
      reasons.push(`${input.symbol} is underperforming`);
    }

    // 2. RSI signal (±20 points)
    if (input.rsi14 !== null) {
      if (input.rsi14 < PATTERNS.RSI_OVERSOLD_THRESHOLD) {
        score += 15;
        reasons.push(`RSI ${input.rsi14.toFixed(1)} oversold - potential long`);
      } else if (input.rsi14 > PATTERNS.RSI_OVERBOUGHT_THRESHOLD) {
        score += 10;
        reasons.push(`RSI ${input.rsi14.toFixed(1)} overbought - potential short`);
      } else if (input.rsi14 < 45) {
        score += 5;
        reasons.push(`RSI ${input.rsi14.toFixed(1)} below average`);
      }
    }

    // 3. BB position (±10 points)
    if (input.bbPosition !== null) {
      if (input.bbPosition < 0.2) {
        score += 10;
        reasons.push(`Near lower BB (${(input.bbPosition * 100).toFixed(0)}%)`);
      } else if (input.bbPosition > 0.8) {
        score += 5;
        reasons.push(`Near upper BB (${(input.bbPosition * 100).toFixed(0)}%)`);
      }
    }

    // 4. Volatility (±10 points) - trades happen in volatility
    if (input.atrPercent !== null) {
      if (input.atrPercent > 5) {
        score += 10;
        reasons.push(`High volatility (ATR ${input.atrPercent.toFixed(1)}%)`);
      } else if (input.atrPercent < 2) {
        score -= 5;
        reasons.push(`Low volatility`);
      }
    }

    // 5. Time of day (±10 points)
    if (PATTERNS.ACTIVE_HOURS.includes(input.hourOfDay)) {
      score += 10;
      reasons.push(`Active trading hour (${input.hourOfDay}:00 UTC)`);
    }

    // 6. Recent activity (±10 points)
    if (input.targetTradesLast24h > 0) {
      score += 10;
      reasons.push(`Target traded ${input.symbol} ${input.targetTradesLast24h}x in last 24h`);
    }

    // 7. BTC correlation (±5 points)
    if (input.btcChange1h !== null) {
      if (Math.abs(input.btcChange1h) > 1) {
        score += 5;
        reasons.push(`BTC moving ${input.btcChange1h > 0 ? 'up' : 'down'} ${Math.abs(input.btcChange1h).toFixed(1)}%`);
      }
    }

    // 8. Funding rate (±5 points)
    if (input.fundingRate !== null) {
      if (Math.abs(input.fundingRate) > 50) {  // Annualized > 50%
        score += 5;
        reasons.push(`High funding ${input.fundingRate > 0 ? 'positive' : 'negative'}`);
      }
    }

    // Determine direction
    let direction: 'long' | 'short' | null = null;
    if (input.rsi14 !== null) {
      if (input.rsi14 < 40) {
        direction = 'long';
      } else if (input.rsi14 > 60) {
        direction = 'short';
      } else if (input.bbPosition !== null && input.bbPosition < 0.3) {
        direction = 'long';
      } else if (input.bbPosition !== null && input.bbPosition > 0.7) {
        direction = 'short';
      }
    }

    // Normalize score to 0-100
    score = Math.max(0, Math.min(100, score));

    // Determine prediction
    const willTrade = score >= 65;
    const confidence = score;

    return {
      willTrade,
      confidence,
      direction: willTrade ? direction : null,
      reasons,
      score
    };
  }

  /**
   * Run prediction and store in database
   */
  async predictAndStore(input: PredictionInput): Promise<PredictionResult> {
    const result = await this.predict(input);

    // Store prediction
    await prisma.prediction.create({
      data: {
        timestamp: input.timestamp,
        symbol: input.symbol,
        prediction: result.willTrade ? 1 : 0,
        confidence: result.confidence,
        direction: result.direction === 'long' ? 1 : result.direction === 'short' ? -1 : 0,
        modelVersion: this.modelVersion,
        features: input as any
      }
    });

    return result;
  }

  /**
   * Validate past predictions against actual trades
   */
  async validatePredictions(hoursBack: number = 24): Promise<{
    total: number;
    correct: number;
    accuracy: number;
    precision: number;
    recall: number;
  }> {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    // Get predictions from the period
    const predictions = await prisma.prediction.findMany({
      where: {
        timestamp: { gte: cutoffTime },
        actualLabel: null  // Not yet validated
      }
    });

    let correct = 0;
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const pred of predictions) {
      // Check if target actually traded
      const nextHour = new Date(pred.timestamp.getTime() + 60 * 60 * 1000);
      const actualTrades = await prisma.trade.count({
        where: {
          traderAddress: TARGET_VAULT,
          symbol: pred.symbol,
          timestamp: { gte: pred.timestamp, lt: nextHour }
        }
      });

      const actualLabel = actualTrades > 0 ? 1 : 0;
      const isCorrect = pred.prediction === actualLabel;

      if (isCorrect) correct++;
      if (pred.prediction === 1 && actualLabel === 1) truePositives++;
      if (pred.prediction === 1 && actualLabel === 0) falsePositives++;
      if (pred.prediction === 0 && actualLabel === 1) falseNegatives++;

      // Update prediction with actual outcome
      await prisma.prediction.update({
        where: { id: pred.id },
        data: {
          actualLabel,
          correct: isCorrect
        }
      });
    }

    const total = predictions.length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    const precision = (truePositives + falsePositives) > 0
      ? (truePositives / (truePositives + falsePositives)) * 100
      : 0;
    const recall = (truePositives + falseNegatives) > 0
      ? (truePositives / (truePositives + falseNegatives)) * 100
      : 0;

    return { total, correct, accuracy, precision, recall };
  }

  /**
   * Get prediction stats
   */
  async getStats(): Promise<{
    totalPredictions: number;
    validatedPredictions: number;
    accuracy: number;
    byConfidence: Array<{ range: string; accuracy: number; count: number }>;
  }> {
    const total = await prisma.prediction.count();
    const validated = await prisma.prediction.count({
      where: { actualLabel: { not: null } }
    });

    const correctCount = await prisma.prediction.count({
      where: { correct: true }
    });

    const accuracy = validated > 0 ? (correctCount / validated) * 100 : 0;

    // Accuracy by confidence range
    const byConfidence: Array<{ range: string; accuracy: number; count: number }> = [];

    for (const range of [
      { min: 0, max: 50, label: '0-50%' },
      { min: 50, max: 65, label: '50-65%' },
      { min: 65, max: 80, label: '65-80%' },
      { min: 80, max: 100, label: '80-100%' }
    ]) {
      const inRange = await prisma.prediction.findMany({
        where: {
          confidence: { gte: range.min, lt: range.max },
          actualLabel: { not: null }
        },
        select: { correct: true }
      });

      const rangeCorrect = inRange.filter(p => p.correct).length;
      byConfidence.push({
        range: range.label,
        accuracy: inRange.length > 0 ? (rangeCorrect / inRange.length) * 100 : 0,
        count: inRange.length
      });
    }

    return { totalPredictions: total, validatedPredictions: validated, accuracy, byConfidence };
  }
}

export const predictionEngine = new PredictionEngine();
