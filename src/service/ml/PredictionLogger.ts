/**
 * Prediction Logger - Momentum Strategy v4
 *
 * Based on deep target vault analysis (Nov 2025 - Mar 2026, 43K+ fills, 649 position events):
 *
 * KEY INSIGHT: Target is a portfolio hedger, not a directional trader.
 * - 43% of time holds both longs AND shorts simultaneously
 * - Hedging periods last 1-3 days (median 48h)
 * - Short side is where the money is (10-30x larger notional)
 *
 * Symbol roles (from hedging analysis):
 * - Always long: ENA, IP, SKY, RESOLV, VIRTUAL, AERO, JUP, FARTCOIN, ZEC
 * - Always short: SKR, PUMP(75%), MON(75%)
 * - Switches direction: BTC, ETH, SOL, HYPE, VVV, kPEPE
 *
 * Indicator profile at entries (454 matched events):
 * - LONG entries: RSI broad (median 50), 12% at RSI>70 (breakout buying)
 *   BB position spread across band, 14% above upper band
 *   MACD 51% bullish (not a strong filter)
 * - SHORT entries: RSI 47.6 median, clusters 50-60 (41%)
 *   BB position in lower half (38% in 0.2-0.4)
 *   MACD 91% bearish — strongest directional signal
 * - CLOSES: RSI 40-60 (71%), BB middle, MACD 32% bullish
 *
 * v4 changes (Mar 2026):
 * - Added RSI, Bollinger Band, EMA signals (now with live data collection)
 * - MACD heavily weighted for short signals (91% accuracy)
 * - RSI scoring adjusted: >70 is long signal (breakout), not short
 * - BB lower touch is strong long signal, upper zone is weak short
 * - BTC RSI for macro regime detection
 * - Symbol roles updated from hedging analysis
 */

import { prisma } from '../utils/db';
import { logger } from '../utils/logger';

// Strategy parameters based on deep target vault analysis (43K+ fills, hedging analysis)
const STRATEGY = {
  // Symbols the target always longs during hedging (>90% long)
  ALWAYS_LONG_SYMBOLS: ['ENA', 'IP', 'SKY', 'RESOLV', 'VIRTUAL', 'AERO', 'JUP', 'FARTCOIN', 'ZEC', 'AXS', 'BERA', 'XMR', 'AIXBT', 'AVNT'],

  // Symbols the target switches direction on (these are the interesting ones)
  DIRECTIONAL_SYMBOLS: ['BTC', 'ETH', 'SOL', 'HYPE', 'VVV', 'kPEPE', 'SPX'],

  // Symbols the target mostly shorts (>70% short)
  MOSTLY_SHORT_SYMBOLS: ['SKR', 'PUMP', 'MON', 'LIT', 'BNB'],

  // Top performers for independent trading
  TOP_SYMBOLS: ['HYPE', 'ETH', 'SOL', 'VVV', 'MON', 'FARTCOIN'],

  // Secondary symbols
  SECONDARY_SYMBOLS: ['PUMP', 'kPEPE', 'SPX', 'SKY'],

  // Session definitions (UTC) - scored by entry WIN RATE from cycle analysis
  ASIA_HOURS: [0, 1, 2, 3, 4, 5, 6, 7],
  EUROPE_HOURS: [8, 9, 10, 11, 12, 13, 14, 15],
  US_HOURS: [16, 17, 18, 19, 20, 21, 22, 23],

  // Breakout thresholds
  BREAKOUT_THRESHOLD: 0.7,
  DIP_THRESHOLD: 0.3,

  // BTC calm threshold
  BTC_CALM_THRESHOLD: 1.0,

  // High confidence threshold
  HIGH_CONFIDENCE_THRESHOLD: 65,
};

// Validation window: 36 hours (target's sweet spot is 1-3 days)
const VALIDATION_WINDOW_MS = 36 * 60 * 60 * 1000;

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
  // Bollinger Bands
  bbUpper?: number | null;
  bbLower?: number | null;
  bbMiddle?: number | null;
  bbWidth?: number | null;
  // EMAs
  ema9?: number | null;
  ema21?: number | null;
  // Volatility
  atrPercent?: number | null;
  // BTC context
  btcChange1h?: number | null;
  btcChange4h?: number | null;
  btcIsCalm?: boolean;
  // BTC indicators (for regime detection)
  btcRsi14?: number | null;
  btcBbPosition?: number | null;
  // Funding
  fundingRate?: number | null;
}

/**
 * Score a prediction using momentum/breakout signals + technical indicators
 *
 * Based on 454 matched indicator events at target position changes:
 * - MACD is strongest short filter (91% bearish when target shorts)
 * - RSI > 70 = long signal (breakout buying), NOT short
 * - BB lower touch = strong long, BB upper = weak short
 * - Target is a portfolio hedger (43% of time has both longs and shorts)
 */
function scorePrediction(symbol: string, state: MarketState): { score: number; direction: number | null; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  let longSignals = 0;
  let shortSignals = 0;

  const hour = new Date().getUTCHours();

  // === 1. MACD — STRONGEST DIRECTIONAL SIGNAL ===
  // 91% of target's short entries have bearish MACD. This is the #1 filter.
  if (state.macdHist !== null && state.macdHist !== undefined) {
    if (state.macdHist > 0) {
      score += 8;
      reasons.push('macd_bullish');
      longSignals += 2; // Strong long signal
    } else if (state.macdHist < 0) {
      score += 5;
      reasons.push('macd_bearish');
      shortSignals += 2; // Strong short signal (91% accuracy)
    }
  }

  // === 2. RSI — BREAKOUT/OVERSOLD DETECTION ===
  // Target buys at RSI > 70 (breakout buying, 12% of long entries)
  // Target shorts at RSI 40-60 (momentum loss), NOT at overbought
  if (state.rsi14 !== null && state.rsi14 !== undefined) {
    if (state.rsi14 > 70) {
      // RSI > 70 = LONG signal (breakout buyer, not mean reversion)
      score += 8;
      reasons.push('rsi_breakout');
      longSignals += 2;
    } else if (state.rsi14 < 30) {
      // Oversold - dip buy opportunity
      score += 8;
      reasons.push('rsi_oversold');
      longSignals += 2;
    } else if (state.rsi14 >= 40 && state.rsi14 <= 55) {
      // Mid-range RSI - target's short entry zone (41% of shorts at 50-60)
      reasons.push('rsi_mid_range');
      // Don't add signal count — this is confirmatory, not directional
    }
  }

  // === 3. BOLLINGER BAND POSITION ===
  // Longs: 14% above upper band (breakout), spread across band
  // Shorts: 38% in 0.2-0.4, 0% above upper band
  if (state.bbUpper !== null && state.bbLower !== null &&
      state.bbUpper !== undefined && state.bbLower !== undefined && state.price) {
    const bbRange = state.bbUpper - state.bbLower!;
    if (bbRange > 0) {
      const bbPosition = (state.price - state.bbLower!) / bbRange;

      if (bbPosition > 1.0) {
        // Above upper band - strong breakout long (14% of target's long entries)
        score += 10;
        reasons.push('bb_breakout_above');
        longSignals += 2;
      } else if (bbPosition < 0.1) {
        // Below lower band - mean reversion long
        score += 10;
        reasons.push('bb_lower_touch');
        longSignals += 2;
      } else if (bbPosition >= 0.2 && bbPosition <= 0.4) {
        // Target's short entry zone (38% of shorts here)
        reasons.push('bb_short_zone');
        shortSignals++;
      }
    }

    // BB squeeze detection
    if (state.bbWidth !== null && state.bbWidth !== undefined) {
      if (state.bbWidth < 0.02) {
        score += 5;
        reasons.push('bb_squeeze');
      }
    }
  }

  // === 4. EMA TREND ===
  if (state.ema9 !== null && state.ema21 !== null &&
      state.ema9 !== undefined && state.ema21 !== undefined) {
    if (state.ema9 > state.ema21) {
      score += 3;
      reasons.push('ema_bullish');
      longSignals++;
    } else {
      reasons.push('ema_bearish');
      shortSignals++;
    }
  }

  // === 5. MOMENTUM CONFIRMATION ===
  if (state.priceChange1h !== null && state.priceChange1h !== undefined) {
    if (state.priceChange1h > 0.5) {
      score += 10;
      reasons.push('momentum_up');
      longSignals++;
    } else if (state.priceChange1h < -0.5) {
      score += 5;
      reasons.push('momentum_down');
      shortSignals++;
    }
  }

  if (state.priceChange4h !== null && state.priceChange4h !== undefined) {
    if (state.priceChange4h > 1) {
      score += 8;
      reasons.push('trend_up_4h');
      longSignals++;
    } else if (state.priceChange4h < -1) {
      score += 5;
      reasons.push('trend_down_4h');
      shortSignals++;
    }
  }

  // === 6. BREAKOUT/DIP from price range ===
  if (state.pricePosition !== null && state.pricePosition !== undefined) {
    if (state.pricePosition > STRATEGY.BREAKOUT_THRESHOLD) {
      score += 10;
      reasons.push('breakout');
      longSignals++;
    } else if (state.pricePosition < STRATEGY.DIP_THRESHOLD) {
      score += 5;
      reasons.push('dip');
      longSignals++;
    }
  }

  // === 7. BTC REGIME DETECTION ===
  // Target flips entire portfolio based on BTC direction
  if (state.btcChange1h !== null && state.btcChange1h !== undefined) {
    if (state.btcIsCalm) {
      score += 5;
      reasons.push('btc_calm');
    }

    if (state.btcChange1h > 0.3) {
      longSignals++;
      reasons.push('btc_bullish');
    } else if (state.btcChange1h < -0.3) {
      shortSignals++;
      reasons.push('btc_bearish');
    }
  }

  // BTC RSI for macro regime
  if (state.btcRsi14 !== null && state.btcRsi14 !== undefined) {
    if (state.btcRsi14 < 30) {
      score += 5;
      reasons.push('btc_oversold');
      longSignals++;
    } else if (state.btcRsi14 > 70) {
      reasons.push('btc_overbought');
      shortSignals++;
    }
  }

  // === 8. SESSION AWARENESS ===
  if (STRATEGY.EUROPE_HOURS.includes(hour)) {
    score += 8;
    reasons.push('europe_session');
  } else if (STRATEGY.US_HOURS.includes(hour)) {
    score += 5;
    reasons.push('us_session');
  } else if (STRATEGY.ASIA_HOURS.includes(hour)) {
    score += 3;
    reasons.push('asia_session');
  }

  // === 9. SYMBOL ROLE AWARENESS ===
  // Based on hedging analysis: some symbols are almost always long or short
  if (STRATEGY.ALWAYS_LONG_SYMBOLS.includes(symbol)) {
    score += 5;
    reasons.push('always_long_symbol');
    longSignals++;
  } else if (STRATEGY.MOSTLY_SHORT_SYMBOLS.includes(symbol)) {
    reasons.push('mostly_short_symbol');
    shortSignals++;
  } else if (STRATEGY.TOP_SYMBOLS.includes(symbol)) {
    score += 5;
    reasons.push('top_symbol');
  } else if (STRATEGY.SECONDARY_SYMBOLS.includes(symbol)) {
    score += 3;
    reasons.push('secondary_symbol');
  }

  // === 10. VOLATILITY ===
  if (state.atrPercent !== null && state.atrPercent !== undefined) {
    if (state.atrPercent > 5) {
      score += 3;
      reasons.push('high_volatility');
    }
  }

  // === 11. FUNDING ===
  if (state.fundingRate !== null && state.fundingRate !== undefined) {
    if (state.fundingRate > 0.02) {
      reasons.push('high_funding_long_bias');
      longSignals++;
    } else if (state.fundingRate < -0.01) {
      reasons.push('neg_funding_short_bias');
      shortSignals++;
    }
  }

  // === DIRECTION DETERMINATION ===
  let direction: number | null = null;
  if (longSignals > shortSignals) {
    direction = 1; // Long
  } else if (shortSignals > longSignals) {
    direction = -1; // Short
    // Short signals get a bonus when MACD confirms (91% accuracy)
    if (shortSignals >= 3 && state.macdHist !== null && state.macdHist !== undefined && state.macdHist < 0) {
      score += 8;
      reasons.push('confirmed_short');
    }
  } else if (longSignals > 0) {
    // Tie → bias to long (target is net long most of the time)
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
   * Get current scan predictions for IndependentTrader
   */
  static getCurrentPredictions(): Map<string, {
    id: string;
    symbol: string;
    score: number;
    direction: number | null;
    reasons: string[];
    entryPrice: number;
  }> {
    return currentScanPredictions;
  }

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

    // Get BTC indicators for regime detection
    const btcIndicator = await prisma.technicalIndicator.findFirst({
      where: { symbol: 'BTC', timeframe: '1h' },
      orderBy: { timestamp: 'desc' },
    });

    const btcRsi14 = btcIndicator?.rsi14 ?? null;
    let btcBbPosition: number | null = null;
    if (btcIndicator?.bbUpper && btcIndicator?.bbLower && btcCandles.length > 0) {
      const bbRange = btcIndicator.bbUpper - btcIndicator.bbLower;
      if (bbRange > 0) {
        btcBbPosition = (btcCandles[0].close - btcIndicator.bbLower) / bbRange;
      }
    }

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
          bbUpper: indicator?.bbUpper ?? null,
          bbLower: indicator?.bbLower ?? null,
          bbMiddle: indicator?.bbMiddle ?? null,
          bbWidth: indicator?.bbWidth ?? null,
          ema9: indicator?.ema9 ?? null,
          ema21: indicator?.ema21 ?? null,
          atrPercent: indicator?.atr14 && candles[0]
            ? (indicator.atr14 / candles[0].close) * 100
            : null,
          btcChange1h,
          btcChange4h,
          btcIsCalm,
          btcRsi14,
          btcBbPosition,
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
            modelVersion: 'momentum-v3',
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
        modelVersion: 'momentum-v3',
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
      where: { modelVersion: 'momentum-v3' }
    });
    const validated = await prisma.prediction.count({
      where: { validatedAt: { not: null }, modelVersion: 'momentum-v3' },
    });
    const correct = await prisma.prediction.count({
      where: { correct: true, modelVersion: 'momentum-v3' },
    });

    const pnlAgg = await prisma.prediction.aggregate({
      where: { validatedAt: { not: null }, modelVersion: 'momentum-v3' },
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
