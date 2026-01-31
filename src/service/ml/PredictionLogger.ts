/**
 * Prediction Logger - Momentum Strategy v2
 *
 * Based on target vault analysis (Jan 2026):
 * - Breakout/momentum buying (65% of entries at upper price range)
 * - BTC correlation (77% same direction as BTC)
 * - More active when BTC is calm (8x more trades)
 * - Session pattern: Accumulate Asia/EU (89%/78% buys), trim US (65% buys)
 * - TWAP accumulation style
 * - Long-biased (64%)
 *
 * Integrates with CopyTradingManager to:
 * 1. Run predictions BEFORE copy actions
 * 2. Log predictions with entry prices
 * 3. Validate predictions after 4 hours (not 1 hour)
 * 4. Track paper P&L for shadow mode validation
 */

import { prisma } from '../utils/db';
import { logger } from '../utils/logger';

// Strategy parameters based on target vault analysis
const STRATEGY = {
  // Top symbols from target (by fill count)
  TOP_SYMBOLS: ['HYPE', 'VVV', 'SKY', 'MON', 'SPX', 'FARTCOIN', 'PUMP'],

  // Symbols they often trade together
  CORRELATED_BASKET: ['FARTCOIN', 'SPX', 'HYPE', 'PUMP', 'MON'],

  // Session definitions (UTC)
  ASIA_HOURS: [0, 1, 2, 3, 4, 5, 6, 7],        // 89% buys
  EUROPE_HOURS: [8, 9, 10, 11, 12, 13, 14, 15], // 78% buys
  US_HOURS: [16, 17, 18, 19, 20, 21, 22, 23],   // 65% buys

  // Breakout thresholds
  BREAKOUT_THRESHOLD: 0.7,  // Price in upper 30% of recent range
  DIP_THRESHOLD: 0.3,       // Price in lower 30% of recent range

  // BTC calm threshold (they trade 8x more when BTC moves < 1%)
  BTC_CALM_THRESHOLD: 1.0,  // % move in 1h

  // High confidence threshold
  HIGH_CONFIDENCE_THRESHOLD: 65,
};

// Validation window: 4 hours (target holds positions longer)
const VALIDATION_WINDOW_MS = 4 * 60 * 60 * 1000;

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
  // Price position in recent range (0 = at low, 1 = at high)
  pricePosition?: number | null;
  // Recent price changes
  priceChange1h?: number | null;
  priceChange4h?: number | null;
  // Momentum indicators
  rsi14?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  macdHist?: number | null;
  // Volatility
  atrPercent?: number | null;
  // BTC context
  btcChange1h?: number | null;
  btcChange4h?: number | null;
  btcIsCalm?: boolean;
  // Funding
  fundingRate?: number | null;
}

/**
 * Score a prediction using momentum/breakout signals
 * Based on target vault behavior analysis
 */
function scorePrediction(symbol: string, state: MarketState): { score: number; direction: number | null; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  let longSignals = 0;
  let shortSignals = 0;

  const hour = new Date().getUTCHours();

  // === 1. BREAKOUT DETECTION (most important - 65% of entries are breakouts) ===
  if (state.pricePosition !== null && state.pricePosition !== undefined) {
    if (state.pricePosition > STRATEGY.BREAKOUT_THRESHOLD) {
      // Price breaking out (upper 30% of recent range)
      score += 20;
      reasons.push('breakout');
      longSignals += 2;
    } else if (state.pricePosition < STRATEGY.DIP_THRESHOLD) {
      // Price at dip - target still buys some dips (35%)
      score += 5;
      reasons.push('dip');
      longSignals++;
    }
  }

  // === 2. MOMENTUM CONFIRMATION ===
  if (state.priceChange1h !== null && state.priceChange1h !== undefined) {
    if (state.priceChange1h > 0.5) {
      // Positive momentum (they buy strength)
      score += 15;
      reasons.push('momentum_up');
      longSignals++;
    } else if (state.priceChange1h < -0.5) {
      // Negative momentum
      score += 5;
      reasons.push('momentum_down');
      shortSignals++;
    }
  }

  // 4h momentum for trend confirmation
  if (state.priceChange4h !== null && state.priceChange4h !== undefined) {
    if (state.priceChange4h > 1) {
      score += 10;
      reasons.push('trend_up_4h');
      longSignals++;
    } else if (state.priceChange4h < -1) {
      score += 5;
      reasons.push('trend_down_4h');
      shortSignals++;
    }
  }

  // === 3. BTC CORRELATION (77% trade same direction as BTC) ===
  if (state.btcChange1h !== null && state.btcChange1h !== undefined) {
    // They're more active when BTC is calm
    if (state.btcIsCalm) {
      score += 10;
      reasons.push('btc_calm');
    }

    // Same direction as BTC (77% correlation)
    if (state.btcChange1h > 0.3) {
      longSignals++;
      if (state.btcIsCalm) {
        score += 5;
        reasons.push('btc_bullish');
      }
    } else if (state.btcChange1h < -0.3) {
      shortSignals++;
      if (state.btcIsCalm) {
        reasons.push('btc_bearish');
      }
    }
  }

  // === 4. SESSION AWARENESS ===
  if (STRATEGY.ASIA_HOURS.includes(hour)) {
    // Asia session: 89% buys - strong long bias
    score += 10;
    reasons.push('asia_session');
    longSignals++;
  } else if (STRATEGY.EUROPE_HOURS.includes(hour)) {
    // Europe session: 78% buys - long bias
    score += 8;
    reasons.push('europe_session');
    longSignals++;
  } else if (STRATEGY.US_HOURS.includes(hour)) {
    // US session: 65% buys - more balanced
    score += 3;
    reasons.push('us_session');
  }

  // === 5. SYMBOL QUALITY ===
  if (STRATEGY.TOP_SYMBOLS.includes(symbol)) {
    score += 10;
    reasons.push('top_symbol');
  }

  if (STRATEGY.CORRELATED_BASKET.includes(symbol)) {
    score += 5;
    reasons.push('basket_symbol');
  }

  // === 6. MACD MOMENTUM ===
  if (state.macdHist !== null && state.macdHist !== undefined) {
    if (state.macdHist > 0) {
      score += 5;
      reasons.push('macd_bullish');
      longSignals++;
    } else if (state.macdHist < 0) {
      reasons.push('macd_bearish');
      shortSignals++;
    }
  }

  // === 7. VOLATILITY (they like volatile assets) ===
  if (state.atrPercent !== null && state.atrPercent !== undefined) {
    if (state.atrPercent > 5) {
      score += 5;
      reasons.push('high_volatility');
    }
  }

  // === 8. FUNDING (contrarian signal) ===
  if (state.fundingRate !== null && state.fundingRate !== undefined) {
    if (state.fundingRate > 0.02) {
      // High positive funding = potential short squeeze
      reasons.push('high_funding_long_bias');
      longSignals++;
    } else if (state.fundingRate < -0.01) {
      // Negative funding = longs getting paid
      reasons.push('neg_funding_short_bias');
      shortSignals++;
    }
  }

  // === DIRECTION DETERMINATION ===
  // Target is 64% long-biased, so tie goes to long
  let direction: number | null = null;
  if (longSignals > shortSignals) {
    direction = 1; // Long
  } else if (shortSignals > longSignals) {
    direction = -1; // Short
  } else if (longSignals > 0) {
    // Tie with signals present - bias to long (64% historical)
    direction = 1;
  }

  return { score, direction, reasons };
}

/**
 * Calculate price position in recent range (0 = at low, 1 = at high)
 */
function calculatePricePosition(candles: { close: number; high: number; low: number }[]): number | null {
  if (candles.length < 10) return null;

  // Use last 10 candles for recent range
  const recentCandles = candles.slice(0, 10);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);

  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;

  if (range === 0) return 0.5;

  const currentPrice = candles[0].close;
  return (currentPrice - rangeLow) / range;
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

    // Get BTC context once for all predictions
    const btcCandles = await prisma.candle.findMany({
      where: { symbol: 'BTC', timeframe: '1h' },
      orderBy: { timestamp: 'desc' },
      take: 5,
    });

    const btcChange1h = btcCandles.length >= 2
      ? ((btcCandles[0].close - btcCandles[1].close) / btcCandles[1].close) * 100
      : null;

    const btcChange4h = btcCandles.length >= 5
      ? ((btcCandles[0].close - btcCandles[4].close) / btcCandles[4].close) * 100
      : null;

    const btcIsCalm = btcChange1h !== null && Math.abs(btcChange1h) < STRATEGY.BTC_CALM_THRESHOLD;

    for (const symbol of symbols) {
      try {
        const price = Number(marketPrices[symbol]);
        if (!price || isNaN(price)) continue;

        // Get latest candles for price position and momentum
        const candles = await prisma.candle.findMany({
          where: { symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
          take: 25,
        });

        // Get latest indicators
        const indicator = await prisma.technicalIndicator.findFirst({
          where: { symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
        });

        // Get funding rate
        const funding = await prisma.fundingRate.findFirst({
          where: { symbol },
          orderBy: { timestamp: 'desc' },
        });

        // Calculate market state
        const pricePosition = calculatePricePosition(candles);

        const candle1h = candles[1];
        const candle4h = candles[4];

        const marketState: MarketState = {
          symbol,
          price,
          pricePosition,
          priceChange1h: candles[0] && candle1h
            ? ((candles[0].close - candle1h.close) / candle1h.close) * 100
            : null,
          priceChange4h: candles[0] && candle4h
            ? ((candles[0].close - candle4h.close) / candle4h.close) * 100
            : null,
          rsi14: indicator?.rsi14 ?? null,
          macd: indicator?.macd ?? null,
          macdSignal: indicator?.macdSignal ?? null,
          macdHist: indicator?.macdHist ?? null,
          atrPercent: indicator?.atr14 && candles[0]
            ? (indicator.atr14 / candles[0].close) * 100
            : null,
          btcChange1h,
          btcChange4h,
          btcIsCalm,
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
            modelVersion: 'momentum-v2',
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
      .filter(p => p.score >= STRATEGY.HIGH_CONFIDENCE_THRESHOLD)
      .map(p => {
        const dir = p.direction === 1 ? 'L' : p.direction === -1 ? 'S' : '?';
        return `${p.symbol}(${p.score}${dir})`;
      });

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
   * Uses 4-hour window (target holds longer than 1 hour)
   */
  static async validatePastPredictions(): Promise<void> {
    const cutoff = new Date(Date.now() - VALIDATION_WINDOW_MS);

    // Find unvalidated predictions older than 4 hours
    const unvalidated = await prisma.prediction.findMany({
      where: {
        validatedAt: null,
        timestamp: { lt: cutoff },
        entryPrice: { not: null },
        modelVersion: 'momentum-v2',
      },
      take: 100,
    });

    if (unvalidated.length === 0) return;

    logger.info(`📊 Validating ${unvalidated.length} predictions (4h window)...`);

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
        // For momentum strategy: correct if direction matched price movement
        const highConfidence = pred.prediction >= STRATEGY.HIGH_CONFIDENCE_THRESHOLD;
        const actionTaken = pred.copyAction && pred.copyAction !== 'none';
        const directionCorrect = (pred.direction === 1 && priceDiff > 0) ||
                                  (pred.direction === -1 && priceDiff < 0);

        let correct = false;
        if (highConfidence && directionCorrect) {
          correct = true;
        } else if (!highConfidence && !actionTaken) {
          // Low confidence + no action = conservative correct
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
        if (paperPnlPct > 0) profitable++;

      } catch (error: any) {
        // Skip this prediction
      }
    }

    if (validated > 0) {
      const profitRate = ((profitable / validated) * 100).toFixed(1);
      logger.info(`✅ Validated ${validated} predictions, ${profitable} profitable (${profitRate}%)`);
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
    const total = await prisma.prediction.count({
      where: { modelVersion: 'momentum-v2' }
    });
    const validated = await prisma.prediction.count({
      where: { validatedAt: { not: null }, modelVersion: 'momentum-v2' },
    });
    const correct = await prisma.prediction.count({
      where: { correct: true, modelVersion: 'momentum-v2' },
    });

    const pnlAgg = await prisma.prediction.aggregate({
      where: { validatedAt: { not: null }, modelVersion: 'momentum-v2' },
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
