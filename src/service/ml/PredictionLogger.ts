/**
 * Prediction Logger
 *
 * Integrates with CopyTradingManager to:
 * 1. Run predictions BEFORE copy actions
 * 2. Log predictions with entry prices
 * 3. Validate predictions after copy actions
 * 4. Track paper P&L for shadow mode validation
 */

import { prisma } from '../utils/db';
import { logger } from '../utils/logger';

// Pattern thresholds (from analysis)
const PATTERNS = {
  RSI_OVERSOLD_THRESHOLD: 30,
  RSI_OVERBOUGHT_THRESHOLD: 70,
  ACTIVE_HOURS: [8, 9, 10, 14, 15, 16, 20, 21, 22],
  BEST_SYMBOLS: ['PUMP', 'VVV', 'ETH', 'IP', 'kPEPE', 'SPX', 'SOL', 'FARTCOIN', 'HYPE'],
  WORST_SYMBOLS: ['XMR', 'AVNT', 'SKY', 'DYM', 'kBONK', 'GRASS', 'RESOLV'],
};

// Validation window (validate predictions after this time)
const VALIDATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// In-memory prediction cache for current scan
const currentScanPredictions = new Map<string, {
  id: string;
  symbol: string;
  score: number;
  direction: number | null;
  reasons: string[];
  entryPrice: number;
}>();

interface MarketState {
  symbol: string;
  price: number;
  rsi14?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  bbPosition?: number | null;
  bbWidth?: number | null;
  atrPercent?: number | null;
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  btcChange1h?: number | null;
  fundingRate?: number | null;
}

/**
 * Score a prediction based on market state
 */
function scorePrediction(symbol: string, state: MarketState): { score: number; direction: number | null; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  let longSignals = 0;
  let shortSignals = 0;

  // Symbol quality
  if (PATTERNS.BEST_SYMBOLS.includes(symbol)) {
    score += 15;
    reasons.push('best_symbol');
  } else if (PATTERNS.WORST_SYMBOLS.includes(symbol)) {
    score -= 15;
    reasons.push('worst_symbol');
  }

  // RSI signals
  if (state.rsi14 !== null && state.rsi14 !== undefined) {
    if (state.rsi14 < PATTERNS.RSI_OVERSOLD_THRESHOLD) {
      score += 15;
      reasons.push('rsi_oversold');
      longSignals++;
    } else if (state.rsi14 > PATTERNS.RSI_OVERBOUGHT_THRESHOLD) {
      score += 10;
      reasons.push('rsi_overbought');
      shortSignals++;
    }
  }

  // BB position
  if (state.bbPosition !== null && state.bbPosition !== undefined) {
    if (state.bbPosition < 0.2) {
      score += 10;
      reasons.push('bb_lower');
      longSignals++;
    } else if (state.bbPosition > 0.8) {
      score += 10;
      reasons.push('bb_upper');
      shortSignals++;
    }
  }

  // Volatility
  if (state.atrPercent !== null && state.atrPercent !== undefined && state.atrPercent > 5) {
    score += 10;
    reasons.push('high_volatility');
  }

  // Active trading hours
  const hour = new Date().getUTCHours();
  if (PATTERNS.ACTIVE_HOURS.includes(hour)) {
    score += 5;
    reasons.push('active_hour');
  }

  // BTC movement
  if (state.btcChange1h !== null && state.btcChange1h !== undefined && Math.abs(state.btcChange1h) > 1) {
    score += 5;
    reasons.push('btc_moving');
    if (state.btcChange1h > 0) longSignals++;
    else shortSignals++;
  }

  // Funding rate extremes
  if (state.fundingRate !== null && state.fundingRate !== undefined && Math.abs(state.fundingRate) > 0.01) {
    score += 5;
    reasons.push('funding_extreme');
    // High positive funding = shorts paying longs = potential short squeeze = long signal
    if (state.fundingRate > 0) longSignals++;
    else shortSignals++;
  }

  // Determine direction based on signals
  let direction: number | null = null;
  if (longSignals > shortSignals) direction = 1;
  else if (shortSignals > longSignals) direction = -1;

  return { score, direction, reasons };
}

export class PredictionLogger {
  /**
   * Run predictions for all symbols BEFORE copy trading executes
   * Called at the start of each scan cycle
   */
  static async logPredictions(
    symbols: string[],
    marketPrices: Record<string, string>
  ): Promise<void> {
    currentScanPredictions.clear();
    const timestamp = new Date();

    for (const symbol of symbols) {
      try {
        const price = Number(marketPrices[symbol]);
        if (!price || isNaN(price)) continue;

        // Get latest indicators from DB
        const indicator = await prisma.technicalIndicator.findFirst({
          where: { symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
        });

        // Get latest candles for price changes
        const candles = await prisma.candle.findMany({
          where: { symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
          take: 25,
        });

        // Get BTC for context
        const btcCandles = await prisma.candle.findMany({
          where: { symbol: 'BTC', timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
          take: 2,
        });

        // Get funding rate
        const funding = await prisma.fundingRate.findFirst({
          where: { symbol },
          orderBy: { timestamp: 'desc' },
        });

        // Calculate market state
        const currentCandle = candles[0];
        const candle1h = candles[1];
        const candle24h = candles[24];

        const marketState: MarketState = {
          symbol,
          price,
          rsi14: indicator?.rsi14 ?? null,
          macd: indicator?.macd ?? null,
          macdSignal: indicator?.macdSignal ?? null,
          bbPosition: indicator?.bbUpper && indicator?.bbLower && currentCandle
            ? (currentCandle.close - indicator.bbLower) / (indicator.bbUpper - indicator.bbLower)
            : null,
          bbWidth: indicator?.bbWidth ?? null,
          atrPercent: indicator?.atr14 && currentCandle
            ? (indicator.atr14 / currentCandle.close) * 100
            : null,
          priceChange1h: currentCandle && candle1h
            ? ((currentCandle.close - candle1h.close) / candle1h.close) * 100
            : null,
          priceChange24h: currentCandle && candle24h
            ? ((currentCandle.close - candle24h.close) / candle24h.close) * 100
            : null,
          btcChange1h: btcCandles.length >= 2
            ? ((btcCandles[0].close - btcCandles[1].close) / btcCandles[1].close) * 100
            : null,
          fundingRate: funding?.rate ?? null,
        };

        // Score prediction
        const { score, direction, reasons } = scorePrediction(symbol, marketState);

        // Store prediction in database
        const prediction = await prisma.prediction.create({
          data: {
            timestamp,
            symbol,
            prediction: score,
            confidence: Math.min(score, 100) / 100,
            direction,
            reasons,
            entryPrice: price,
            features: marketState as any,
            modelVersion: 'pattern-v1',
          },
        });

        // Cache for later validation
        currentScanPredictions.set(symbol, {
          id: prediction.id,
          symbol,
          score,
          direction,
          reasons,
          entryPrice: price,
        });

      } catch (error: any) {
        logger.error(`Prediction error for ${symbol}: ${error.message}`);
      }
    }

    // Log summary
    const highConfidence = Array.from(currentScanPredictions.values())
      .filter(p => p.score >= 65)
      .map(p => `${p.symbol}(${p.score})`);

    if (highConfidence.length > 0) {
      logger.info(`🔮 Predictions: ${highConfidence.join(', ')}`);
    }
  }

  /**
   * Update prediction with actual copy action taken
   * Called after each copy trade executes
   */
  static async logCopyAction(
    symbol: string,
    action: string,  // 'open' | 'close' | 'flip' | 'increase' | 'decrease' | 'none'
    side: string | null,
    size: number
  ): Promise<void> {
    const cached = currentScanPredictions.get(symbol);
    if (!cached) return;

    try {
      await prisma.prediction.update({
        where: { id: cached.id },
        data: {
          copyAction: action,
          copySide: side,
          copySize: size,
          actualLabel: action !== 'none' ? 1 : 0,
        },
      });
    } catch (error: any) {
      logger.error(`Failed to update prediction for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Mark symbols with no copy action as "none"
   * Called at the end of scan cycle
   */
  static async finalizeScanPredictions(tradedSymbols: Set<string>): Promise<void> {
    for (const [symbol, cached] of currentScanPredictions.entries()) {
      if (!tradedSymbols.has(symbol)) {
        try {
          await prisma.prediction.update({
            where: { id: cached.id },
            data: {
              copyAction: 'none',
              actualLabel: 0,
            },
          });
        } catch (error: any) {
          // Ignore - prediction may already be updated
        }
      }
    }
  }

  /**
   * Validate past predictions by checking price movement
   * Should be called periodically (e.g., hourly)
   */
  static async validatePastPredictions(): Promise<void> {
    const cutoff = new Date(Date.now() - VALIDATION_WINDOW_MS);

    // Find unvalidated predictions older than 1 hour
    const unvalidated = await prisma.prediction.findMany({
      where: {
        validatedAt: null,
        timestamp: { lt: cutoff },
        entryPrice: { not: null },
      },
      take: 100,
    });

    if (unvalidated.length === 0) return;

    logger.info(`📊 Validating ${unvalidated.length} past predictions...`);

    let validated = 0;
    let profitable = 0;

    for (const pred of unvalidated) {
      try {
        // Get current price
        const latestCandle = await prisma.candle.findFirst({
          where: { symbol: pred.symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
        });

        if (!latestCandle || !pred.entryPrice) continue;

        const exitPrice = latestCandle.close;
        const priceDiff = exitPrice - pred.entryPrice;

        // Calculate paper P&L based on predicted direction
        let paperPnl = 0;
        if (pred.direction === 1) {
          // Long prediction
          paperPnl = priceDiff;
        } else if (pred.direction === -1) {
          // Short prediction
          paperPnl = -priceDiff;
        }

        const paperPnlPct = (paperPnl / pred.entryPrice) * 100;

        // Determine if prediction was "correct"
        // Correct if: high confidence + copyAction matched + profitable
        // OR: low confidence + no action + would have been unprofitable
        const highConfidence = pred.prediction >= 65;
        const actionTaken = pred.copyAction && pred.copyAction !== 'none';
        const wasProfitable = paperPnlPct > 0;

        let correct = false;
        if (highConfidence && actionTaken && wasProfitable) {
          correct = true;
        } else if (!highConfidence && !actionTaken && !wasProfitable) {
          correct = true;
        }

        await prisma.prediction.update({
          where: { id: pred.id },
          data: {
            exitPrice,
            paperPnl,
            paperPnlPct,
            correct,
            validatedAt: new Date(),
          },
        });

        validated++;
        if (wasProfitable) profitable++;

      } catch (error: any) {
        // Skip this prediction
      }
    }

    if (validated > 0) {
      logger.info(`✅ Validated ${validated} predictions, ${profitable} would have been profitable`);
    }
  }

  /**
   * Get prediction stats for reporting
   */
  static async getStats(): Promise<{
    total: number;
    validated: number;
    correct: number;
    accuracy: number;
    totalPaperPnl: number;
    avgPaperPnlPct: number;
  }> {
    const total = await prisma.prediction.count();
    const validated = await prisma.prediction.count({
      where: { validatedAt: { not: null } },
    });
    const correct = await prisma.prediction.count({
      where: { correct: true },
    });

    const pnlAgg = await prisma.prediction.aggregate({
      where: { validatedAt: { not: null } },
      _sum: { paperPnl: true },
      _avg: { paperPnlPct: true },
    });

    return {
      total,
      validated,
      correct,
      accuracy: validated > 0 ? (correct / validated) * 100 : 0,
      totalPaperPnl: pnlAgg._sum.paperPnl ?? 0,
      avgPaperPnlPct: pnlAgg._avg.paperPnlPct ?? 0,
    };
  }
}
