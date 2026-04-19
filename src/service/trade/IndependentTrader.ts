/**
 * IndependentTrader v5 - Indicator-based exit strategy
 *
 * Based on analysis of 43K+ fills, 109 complete position cycles with
 * candle-computed indicators at exit time.
 *
 * Entry criteria (unchanged from v4):
 * - Prediction score >= 90 LONG, >= 95 SHORT
 * - Symbol on whitelist
 * - No existing position (copy or independent)
 * - Under max allocation limit (10% of vault)
 *
 * Exit strategy (v5 - indicator-based, data-driven):
 *
 * LONG exits (from 89 long cycle analysis):
 * - BB position > 0.8: always loses (0% WR, -23% avg) → exit
 * - RSI > 70: bad exits (30% WR, -0.9% avg) → exit
 * - Price below EMA9 AND EMA21: profitable zone (+11.4% avg) → take profit
 *
 * SHORT exits (from 19 short cycle analysis):
 * - BB position 0.4-0.6: best exits (83% WR, +4.2% avg) → take profit at mean
 * - Price below EMA9 AND EMA21: profitable zone (+3.3% avg) → take profit
 *
 * Safety nets (always active):
 * - Hard stop: -10% from entry (from target's loss distribution: median -4%, avg -8%)
 * - Max hold: 72h
 * - Target confirmation/opposite handling
 *
 * v5 changes (2026-03-14):
 * - Replaced trailing stop with indicator-based exits
 * - LONG: exit on BB > 0.8, RSI > 70, or price < both EMAs (after min hold)
 * - SHORT: exit on BB 0.4-0.6 (mean reversion), or price < both EMAs
 * - Kept hard stop and max hold as safety nets
 *
 * v5.1 fix (2026-03-31):
 * - Hard stop changed from -5% to -10% (target median loss -4%, avg -8%)
 * - Skip BB > 0.8 exit when position entered on bb_breakout_above signal
 *   (57% of BB exits were contradicting their own entry signal)
 * - Breakout entries expect price above band — that's the whole point
 */

import dotenv from 'dotenv';
import { prisma } from '../utils/db';
import { logger } from '../utils/logger';
import { HyperliquidConnector } from './HyperliquidConnector';
import { PredictionLogger } from '../ml/PredictionLogger';
import { assetMetadataCache } from './CopyTradingManager';

dotenv.config();

const WALLET = process.env.WALLET as `0x${string}`;

// Configuration (can be overridden via env vars)
const CONFIG = {
  ENABLED: process.env.ENABLE_INDEPENDENT_TRADING === 'true',
  MAX_ALLOCATION_PCT: parseFloat(process.env.INDEPENDENT_MAX_ALLOCATION_PCT || '0.30'),
  MAX_POSITIONS: parseInt(process.env.INDEPENDENT_MAX_POSITIONS || '5', 10),
  LEVERAGE: parseInt(process.env.INDEPENDENT_LEVERAGE || '5', 10),

  // v5: Indicator-based exit strategy
  MAX_HOLD_HOURS: parseInt(process.env.INDEPENDENT_MAX_HOLD_HOURS || '72', 10),
  HARD_STOP_PCT: parseFloat(process.env.INDEPENDENT_HARD_STOP_PCT || '0.10'),          // -10% from entry (target median loss -4%, avg -8%, 11% beyond -10%)

  // Indicator exit thresholds (from 109 cycle analysis)
  EXIT_BB_UPPER: 0.8,    // LONG: BB > 0.8 = 0% WR, -23% avg → exit
  EXIT_RSI_HIGH: 70,     // LONG: RSI > 70 = 30% WR, -0.9% avg → exit
  EXIT_BB_MEAN_LOW: 0.4, // SHORT: BB 0.4-0.6 = 83% WR → take profit at mean
  EXIT_BB_MEAN_HIGH: 0.6,

  // Score thresholds — symmetric for longs and shorts
  MIN_SCORE_LONG: 90,
  MIN_SCORE_SHORT: 90,

  // Whitelist: proven performers from target vault cycle analysis
  WHITELIST: ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'],
};

export class IndependentTrader {
  // Dedup state for noisy per-scan warnings: log once per state change, not every 5 min.
  private static lastSkipExitKey = new Map<string, string>();         // symbol → "dir:reason"
  private static lastInsufficientMarginKey = new Set<string>();       // symbols currently logged

  /**
   * Check if independent trading is enabled
   */
  static isEnabled(): boolean {
    return CONFIG.ENABLED;
  }

  /**
   * Process prediction signals and open new positions if criteria met
   * Called after predictions are logged but before copy trading executes
   */
  static async processSignals(
    allMarkets: Record<string, string>,
    targetPositions: any
  ): Promise<void> {
    if (!CONFIG.ENABLED) {
      return;
    }

    try {
      // Get current predictions from this scan
      const predictions = PredictionLogger.getCurrentPredictions();
      if (predictions.size === 0) {
        return;
      }

      // Get our current positions (copy + independent)
      const ourPositions = await HyperliquidConnector.getOpenPositions(WALLET);
      const ourSymbols = new Set(
        ourPositions.assetPositions
          .filter((ap: any) => ap.position.szi !== '0')
          .map((ap: any) => ap.position.coin)
      );

      // Get target's current symbols
      const targetSymbols = new Set(
        targetPositions.assetPositions
          .filter((ap: any) => ap.position.szi !== '0')
          .map((ap: any) => ap.position.coin)
      );

      // Get open independent positions
      const openIndependent = await prisma.independentPosition.findMany({
        where: { status: { in: ['open', 'confirmed'] } },
      });
      const independentSymbols = new Set(openIndependent.map(p => p.symbol));

      // Check current allocation
      const currentAllocation = await this.getCurrentAllocation();
      const portfolio = await HyperliquidConnector.getPortfolio(WALLET);
      const maxAllocationUsd = portfolio.portfolio * CONFIG.MAX_ALLOCATION_PCT;

      if (openIndependent.length >= CONFIG.MAX_POSITIONS) {
        logger.info(`🎯 Independent: At max positions (${CONFIG.MAX_POSITIONS}), skipping`);
        return;
      }

      // Filter and sort predictions by score (highest first)
      const eligiblePredictions = Array.from(predictions.values())
        .filter(p => {
          // Must be on whitelist
          if (!CONFIG.WHITELIST.includes(p.symbol)) return false;
          // Must not already have position (copy or independent)
          if (ourSymbols.has(p.symbol)) return false;
          if (independentSymbols.has(p.symbol)) return false;
          // Must not be a symbol target already has (defer to copy trading)
          if (targetSymbols.has(p.symbol)) return false;

          // Direction-specific score thresholds
          if (p.direction === 1 && p.score >= CONFIG.MIN_SCORE_LONG) return true;
          if (p.direction === -1 && p.score >= CONFIG.MIN_SCORE_SHORT) return true;
          return false;
        })
        .sort((a, b) => b.score - a.score);

      // Log eligible signals for debugging
      if (eligiblePredictions.length > 0) {
        const eligible = eligiblePredictions.map(p => {
          const dir = p.direction === 1 ? 'L' : 'S';
          return `${p.symbol}(${p.score}${dir})`;
        }).join(', ');
        logger.info(`🎯 Independent: ${eligiblePredictions.length} eligible signals: ${eligible}`);
      }

      if (eligiblePredictions.length === 0) {
        return;
      }

      // Process eligible predictions until allocation limit reached
      for (const pred of eligiblePredictions) {
        // Check if we still have room for more positions
        if (openIndependent.length + 1 > CONFIG.MAX_POSITIONS) {
          break;
        }

        // Calculate position size (equal allocation per position)
        const remainingAllocation = maxAllocationUsd - currentAllocation;
        if (remainingAllocation <= 0) {
          logger.warn(`⚠️  Independent allocation exhausted ($${currentAllocation.toFixed(0)}/$${maxAllocationUsd.toFixed(0)} used), skipping remaining signals`);
          break;
        }
        const positionsRemaining = CONFIG.MAX_POSITIONS - openIndependent.length;
        const positionSizeUsd = Math.min(
          remainingAllocation / positionsRemaining,
          maxAllocationUsd / CONFIG.MAX_POSITIONS
        );

        // Skip if position would be too small
        if (positionSizeUsd < 10) {
          logger.warn(`⚠️  ${pred.symbol}: Independent position too small ($${positionSizeUsd.toFixed(2)}), skipping`);
          continue;
        }

        // Check if we have enough margin
        const marginRequired = positionSizeUsd / CONFIG.LEVERAGE;
        if (marginRequired > portfolio.available * 0.95) {
          if (!this.lastInsufficientMarginKey.has(pred.symbol)) {
            logger.warn(`⚠️  ${pred.symbol}: Insufficient margin for independent position`);
            this.lastInsufficientMarginKey.add(pred.symbol);
          }
          break;
        }
        this.lastInsufficientMarginKey.delete(pred.symbol);

        // Pre-check: don't open if any indicator exit would fire immediately
        const indicators = await this.getLatestIndicators(pred.symbol);
        if (indicators) {
          const dir = pred.direction === 1 ? 'long' : 'short';
          const price = Number(allMarkets[pred.symbol]);
          const exitSignal = this.checkIndicatorExit(dir, price, indicators);
          if (exitSignal) {
            const key = `${dir}:${exitSignal}`;
            if (this.lastSkipExitKey.get(pred.symbol) !== key) {
              logger.info(`⏭️  ${pred.symbol}: Skipping ${dir.toUpperCase()} — exit "${exitSignal}" already active`);
              this.lastSkipExitKey.set(pred.symbol, key);
            }
            continue;
          }
          this.lastSkipExitKey.delete(pred.symbol);
        }

        // Open the position
        await this.openPosition(pred, positionSizeUsd, allMarkets);

        // Update tracking
        independentSymbols.add(pred.symbol);
        openIndependent.push({ symbol: pred.symbol } as any);
      }

    } catch (error: any) {
      logger.error(`IndependentTrader.processSignals error: ${error.message}`);
    }
  }

  /**
   * Manage existing independent positions
   * v5: Indicator-based exits (BB, RSI, EMA), hard stop, max hold
   */
  static async managePositions(
    allMarkets: Record<string, string>,
    targetPositions: any
  ): Promise<void> {
    if (!CONFIG.ENABLED) {
      return;
    }

    try {
      // Get open independent positions
      const openPositions = await prisma.independentPosition.findMany({
        where: { status: { in: ['open', 'confirmed'] } },
      });

      if (openPositions.length === 0) {
        return;
      }

      // Get target's current positions for confirmation check
      const targetPositionMap = new Map<string, { side: string; size: number }>();
      for (const ap of targetPositions.assetPositions) {
        if (ap.position.szi !== '0') {
          const side = HyperliquidConnector.positionSide(ap.position);
          targetPositionMap.set(ap.position.coin, {
            side,
            size: Math.abs(Number(ap.position.szi)),
          });
        }
      }

      for (const pos of openPositions) {
        const currentPrice = Number(allMarkets[pos.symbol]);
        if (!currentPrice || isNaN(currentPrice)) {
          continue;
        }

        // === 1. TARGET CONFIRMATION CHECK ===
        const targetPos = targetPositionMap.get(pos.symbol);
        if (targetPos) {
          if (targetPos.side === pos.side) {
            if (!pos.confirmedByTarget) {
              await prisma.independentPosition.update({
                where: { id: pos.id },
                data: { confirmedByTarget: true, status: 'confirmed' },
              });
              logger.info(`✅ ${pos.symbol}: Independent position CONFIRMED by target (same direction)`);
            }
            continue;
          } else {
            await this.closePosition(pos, currentPrice, 'target_opposite');
            continue;
          }
        }

        // === 2. HARD STOP - always active (-10% price move, configurable via INDEPENDENT_HARD_STOP_PCT) ===
        const pnlFromEntry = pos.side === 'long'
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;

        if (pnlFromEntry <= -CONFIG.HARD_STOP_PCT) {
          await this.closePosition(pos, currentPrice, 'hard_stop');
          continue;
        }

        // === 3. MAX HOLD TIMEOUT ===
        const holdTimeMs = Date.now() - pos.createdAt.getTime();
        const maxHoldMs = CONFIG.MAX_HOLD_HOURS * 60 * 60 * 1000;
        if (holdTimeMs >= maxHoldMs) {
          await this.closePosition(pos, currentPrice, 'timeout');
          continue;
        }

        // === 4. INDICATOR-BASED EXITS ===
        // Skip indicator exits in the first 10 minutes as a safety net
        // (entry pre-check should already block contradictory entries, but this
        // handles edge cases like indicators changing between entry and first manage cycle)
        const MIN_HOLD_FOR_INDICATORS_MS = 10 * 60 * 1000; // 10 minutes
        if (holdTimeMs < MIN_HOLD_FOR_INDICATORS_MS) {
          continue;
        }

        const indicators = await this.getLatestIndicators(pos.symbol);
        if (!indicators) {
          continue; // No indicator data yet, rely on hard stop / timeout
        }

        // For existing positions: profit-taking exits (EMA TP, BB mean) require pnlFromEntry > 0
        // BB breakout exception: skip BB > 0.8 exit if entered on breakout signal
        const enteredOnBbBreakout = (pos as any).predictionReasons?.includes('bb_breakout_above');
        const exitSignal = this.checkIndicatorExit(
          pos.side, currentPrice, indicators, pnlFromEntry, enteredOnBbBreakout
        );

        if (exitSignal) {
          logger.info(`📊 ${pos.symbol}: Exit signal "${exitSignal}" → close ${pos.side}`);
          await this.closePosition(pos, currentPrice, exitSignal);
          continue;
        }
      }

    } catch (error: any) {
      logger.error(`IndependentTrader.managePositions error: ${error.message}`);
    }
  }

  /**
   * Fetch latest indicators for a symbol from the DB
   * Returns BB position, RSI, EMAs computed by MarketDataCollector
   */
  private static async getLatestIndicators(symbol: string): Promise<{
    rsi14: number | null;
    bbPosition: number | null;
    ema9: number | null;
    ema21: number | null;
  } | null> {
    try {
      const indicator = await prisma.technicalIndicator.findFirst({
        where: { symbol, timeframe: '1h' },
        orderBy: { timestamp: 'desc' },
      });

      if (!indicator) return null;

      // Check freshness — indicator should be less than 2 hours old
      const ageMs = Date.now() - indicator.timestamp.getTime();
      if (ageMs > 2 * 60 * 60 * 1000) return null;

      const bbUpper = indicator.bbUpper;
      const bbLower = indicator.bbLower;
      let bbPosition: number | null = null;

      if (bbUpper !== null && bbLower !== null && bbUpper !== bbLower) {
        // Get current price from the indicator's close approximation (ema9 is close to price)
        // We'll compute BB position using the latest candle close
        const latestCandle = await prisma.candle.findFirst({
          where: { symbol, timeframe: '1h' },
          orderBy: { timestamp: 'desc' },
        });
        if (latestCandle) {
          bbPosition = (latestCandle.close - bbLower) / (bbUpper - bbLower);
        }
      }

      return {
        rsi14: indicator.rsi14,
        bbPosition,
        ema9: indicator.ema9,
        ema21: indicator.ema21,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch indicators for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if any indicator-based exit signal is active for a given side and price.
   * Used both as entry gate (don't open if exit would fire) and in managePositions.
   *
   * @param side - 'long' or 'short'
   * @param price - current market price
   * @param indicators - latest indicator values
   * @param pnlFromEntry - P&L ratio from entry (optional, defaults to 0 for entry gate).
   *   When > 0, profit-taking exits (EMA TP, BB mean) are active.
   *   When called as entry gate (pnl=0), these fire unconditionally — because any
   *   tiny price move would put us in profit and trigger the exit anyway.
   * @param enteredOnBbBreakout - skip BB > 0.8 exit for breakout entries
   * @returns exit signal name if exit would fire, null otherwise
   */
  private static checkIndicatorExit(
    side: string,
    price: number,
    indicators: { rsi14: number | null; bbPosition: number | null; ema9: number | null; ema21: number | null },
    pnlFromEntry: number = 0,
    enteredOnBbBreakout: boolean = false,
  ): string | null {
    const { rsi14, bbPosition, ema9, ema21 } = indicators;

    if (side === 'long') {
      // BB > 0.8: 0% WR, -23% avg → exit (unless entered on BB breakout)
      if (bbPosition !== null && bbPosition > CONFIG.EXIT_BB_UPPER && !enteredOnBbBreakout) {
        return 'indicator_bb_upper';
      }
      // RSI > 70: 30% WR, -0.9% avg → exit
      if (rsi14 !== null && rsi14 > CONFIG.EXIT_RSI_HIGH) {
        return 'indicator_rsi_high';
      }
      // Price below both EMAs → take profit (requires in-profit for existing positions)
      if (ema9 !== null && ema21 !== null && price < ema9 && price < ema21 && pnlFromEntry >= 0) {
        return 'indicator_ema_tp';
      }
    } else {
      // BB 0.4-0.6 (mean zone) → take profit short
      if (bbPosition !== null && bbPosition >= CONFIG.EXIT_BB_MEAN_LOW && bbPosition <= CONFIG.EXIT_BB_MEAN_HIGH && pnlFromEntry >= 0) {
        return 'indicator_bb_mean';
      }
      // Price below both EMAs → take profit short
      if (ema9 !== null && ema21 !== null && price < ema9 && price < ema21 && pnlFromEntry >= 0) {
        return 'indicator_ema_tp';
      }
    }

    return null;
  }

  /**
   * Open a new independent position
   */
  private static async openPosition(
    prediction: { symbol: string; score: number; direction: number | null; reasons: string[]; entryPrice: number },
    marginUsd: number,
    allMarkets: Record<string, string>
  ): Promise<void> {
    const { symbol, score, direction, reasons, entryPrice } = prediction;
    const isLong = direction === 1;
    const side = isLong ? 'long' : 'short';

    try {
      // Get ticker config
      const tickerConfig = await this.getTickerConfig(symbol);
      if (!tickerConfig) {
        logger.warn(`⚠️  ${symbol}: No ticker config for independent trade`);
        return;
      }

      // Use capped leverage (respects asset's max leverage)
      const leverage = tickerConfig.leverage;

      // Calculate notional size from margin allocation
      const price = Number(allMarkets[symbol]) || entryPrice;
      const notionalUsd = marginUsd * leverage;
      const size = notionalUsd / price;

      // Calculate timeout
      const maxTimeoutAt = new Date(Date.now() + CONFIG.MAX_HOLD_HOURS * 60 * 60 * 1000);

      // Execute the trade
      await HyperliquidConnector.openCopyPosition(
        tickerConfig,
        isLong,
        size,
        leverage,
        false, // don't add to existing
        price
      );

      // Record in database
      await prisma.independentPosition.create({
        data: {
          symbol,
          side,
          entryPrice: price,
          size,
          sizeUsd: notionalUsd,
          leverage,
          tpPrice: 0,  // v4: no fixed TP, using trailing stop
          slPrice: 0,  // v4: no fixed SL, using hard stop + trailing
          timeoutAt: maxTimeoutAt,
          status: 'open',
          confirmedByTarget: false,
          predictionScore: score,
          predictionReasons: reasons,
        },
      });

      const dirLabel = isLong ? 'LONG' : 'SHORT';
      logger.info(`🎯 ${symbol}: INDEPENDENT OPEN ${dirLabel} ${size.toFixed(4)} @ $${price.toFixed(2)} (${leverage}x, $${notionalUsd.toFixed(0)} notional, indicator exits + hard stop ${(CONFIG.HARD_STOP_PCT*100)}%, max ${CONFIG.MAX_HOLD_HOURS}h, score: ${score})`);

    } catch (error: any) {
      logger.error(`❌ ${symbol}: Independent open failed - ${error.message}`);
    }
  }

  /**
   * Close an independent position
   */
  private static async closePosition(
    position: {
      id: string;
      symbol: string;
      side: string;
      size: number;
      entryPrice: number;
      sizeUsd: number;
    },
    exitPrice: number,
    reason: string
  ): Promise<void> {
    const { id, symbol, side, size, entryPrice, sizeUsd } = position;

    try {
      // Get ticker config
      const tickerConfig = await this.getTickerConfig(symbol);
      if (!tickerConfig) {
        logger.warn(`⚠️  ${symbol}: No ticker config for independent close`);
        return;
      }

      // Execute the close
      const orderResult = await HyperliquidConnector.marketClosePosition(
        tickerConfig,
        side === 'long',
        1, // close 100%
        exitPrice
      );

      // Use actual fill price from order response, fallback to market price
      const fillPrice = HyperliquidConnector.getFillPrice(orderResult) ?? exitPrice;

      // Calculate P&L using actual fill price
      const priceDiff = fillPrice - entryPrice;
      const realizedPnl = side === 'long' ? priceDiff * size : -priceDiff * size;
      const realizedPnlPct = (priceDiff / entryPrice) * 100 * (side === 'long' ? 1 : -1);

      // Update database with actual fill price
      await prisma.independentPosition.update({
        where: { id },
        data: {
          status: 'closed',
          exitPrice: fillPrice,
          exitReason: reason,
          closedAt: new Date(),
          realizedPnl,
          realizedPnlPct,
        },
      });

      const pnlEmoji = realizedPnl >= 0 ? '💰' : '📉';
      const reasonEmoji: Record<string, string> = {
        indicator_bb_upper: '📊',
        indicator_bb_mean: '📊',
        indicator_rsi_high: '📊',
        indicator_ema_tp: '📊',
        hard_stop: '🛑',
        timeout: '⏰',
        target_confirmed: '✅',
        target_opposite: '🔄',
      };
      const emoji = reasonEmoji[reason] || '❓';

      logger.info(`${emoji} ${symbol}: INDEPENDENT CLOSE ${reason} @ $${exitPrice.toFixed(2)} ${pnlEmoji} P&L: $${realizedPnl.toFixed(2)} (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(2)}%)`);

    } catch (error: any) {
      logger.error(`❌ ${symbol}: Independent close failed - ${error.message}`);
    }
  }

  /**
   * Get current total allocation in USD for independent positions
   */
  static async getCurrentAllocation(): Promise<number> {
    const openPositions = await prisma.independentPosition.findMany({
      where: { status: { in: ['open', 'confirmed'] } },
    });

    return openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
  }

  /**
   * Check if a symbol has an open independent position (for conflict resolution)
   */
  static async hasIndependentPosition(symbol: string): Promise<{ exists: boolean; confirmed: boolean }> {
    const position = await prisma.independentPosition.findFirst({
      where: {
        symbol,
        status: { in: ['open', 'confirmed'] },
      },
    });

    return {
      exists: !!position,
      confirmed: position?.status === 'confirmed' || false,
    };
  }

  /**
   * Force close an independent position's DB record (exchange close handled by CopyTradingManager).
   * Called when copy trading needs to take over the symbol (e.g., flip direction).
   */
  static async forceClosePosition(symbol: string, exitPrice: number, reason: string): Promise<void> {
    const position = await prisma.independentPosition.findFirst({
      where: { symbol, status: { in: ['open', 'confirmed'] } },
    });
    if (!position) return;

    const priceDiff = exitPrice - position.entryPrice;
    const realizedPnl = position.side === 'long' ? priceDiff * position.size : -priceDiff * position.size;
    const realizedPnlPct = (priceDiff / position.entryPrice) * 100 * (position.side === 'long' ? 1 : -1);

    await prisma.independentPosition.update({
      where: { id: position.id },
      data: {
        status: 'closed',
        exitPrice,
        exitReason: reason,
        closedAt: new Date(),
        realizedPnl,
        realizedPnlPct,
      },
    });

    const pnlEmoji = realizedPnl >= 0 ? '💰' : '📉';
    logger.info(`🔄 ${symbol}: INDEPENDENT FORCE CLOSE ${reason} @ $${exitPrice.toFixed(2)} ${pnlEmoji} P&L: $${realizedPnl.toFixed(2)} (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(2)}%)`);
  }

  /**
   * Mark an independent position as confirmed by target
   * Called when copy trading detects target opened same position
   */
  static async confirmPosition(symbol: string): Promise<void> {
    await prisma.independentPosition.updateMany({
      where: {
        symbol,
        status: 'open',
      },
      data: {
        confirmedByTarget: true,
        status: 'confirmed',
      },
    });
  }

  /**
   * Get ticker config from shared metadata cache (populated by CopyTradingManager)
   */
  private static getTickerConfig(symbol: string): any | null {
    const metadata = assetMetadataCache.get(symbol);
    if (!metadata) {
      logger.warn(`⚠️  ${symbol}: No metadata in cache (CopyTradingManager may not have run yet)`);
      return null;
    }

    return {
      syn: symbol,
      id: metadata.id,
      leverage: Math.min(CONFIG.LEVERAGE, metadata.maxLeverage),
      szDecimals: metadata.szDecimals,
    };
  }

  /**
   * Get configuration for logging/debugging
   */
  static getConfig(): typeof CONFIG {
    return { ...CONFIG };
  }
}
