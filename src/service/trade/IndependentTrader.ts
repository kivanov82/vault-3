/**
 * IndependentTrader v4 - Autonomous trading based on deep target analysis
 *
 * Based on analysis of 27K+ fills, 88 complete position cycles:
 *
 * Entry criteria:
 * - Prediction score >= 90 (very high confidence)
 * - Direction: LONG primary (target 43% WR but high avg P&L)
 *   SHORTS allowed when score >= 95 (target 89% short WR)
 * - Symbol on whitelist (proven target performers)
 * - No existing position (copy or independent)
 * - Under max allocation limit
 *
 * Exit strategy (v4 - trailing stop):
 * - Min hold: 12h (don't exit during noise - sub-12h has -0.55% avg)
 * - After 12h: trailing stop at 3% from peak price
 * - Hard stop: -5% from entry at any time (risk management)
 * - Max hold: 72h (3-7d bucket drops to 33% WR)
 * - Target confirmation/opposite handling unchanged
 *
 * v4 changes (2026-03-09):
 * - Hold time: 4h → 12h min / 72h max with trailing stop
 * - Trailing stop: 3% from peak after min hold
 * - Hard stop: -5% from entry (always active)
 * - Whitelist: HYPE, SOL, VVV, ETH, MON, FARTCOIN (from cycle analysis)
 * - Shorts allowed at very high confidence (score >= 95)
 * - Dropped AXS (worst performer in live trading: -$446 net)
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
  MAX_ALLOCATION_PCT: parseFloat(process.env.INDEPENDENT_MAX_ALLOCATION_PCT || '0.10'),
  MAX_POSITIONS: parseInt(process.env.INDEPENDENT_MAX_POSITIONS || '3', 10),
  LEVERAGE: parseInt(process.env.INDEPENDENT_LEVERAGE || '5', 10),

  // v4: Trailing stop exit strategy
  MIN_HOLD_HOURS: parseInt(process.env.INDEPENDENT_MIN_HOLD_HOURS || '12', 10),
  MAX_HOLD_HOURS: parseInt(process.env.INDEPENDENT_MAX_HOLD_HOURS || '72', 10),
  TRAILING_STOP_PCT: parseFloat(process.env.INDEPENDENT_TRAILING_STOP_PCT || '0.03'),  // 3% from peak
  HARD_STOP_PCT: parseFloat(process.env.INDEPENDENT_HARD_STOP_PCT || '0.05'),          // -5% from entry

  // Score thresholds
  MIN_SCORE_LONG: 90,
  MIN_SCORE_SHORT: 95,  // Higher bar for shorts

  // Whitelist: proven performers from target vault cycle analysis
  // HYPE: 69% WR, ETH: 82% WR, SOL: 86% WR, VVV: 75% WR, MON: 75% WR, FARTCOIN: 57% WR
  WHITELIST: ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN'],
};

// In-memory peak price tracking for trailing stops
const peakPrices = new Map<string, number>();

export class IndependentTrader {
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
          logger.warn(`⚠️  ${pred.symbol}: Insufficient margin for independent position`);
          break;
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
   * v4: Trailing stop after min hold, hard stop always, max hold timeout
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
            // Target opened same direction - mark as confirmed
            if (!pos.confirmedByTarget) {
              await prisma.independentPosition.update({
                where: { id: pos.id },
                data: { confirmedByTarget: true, status: 'confirmed' },
              });
              logger.info(`✅ ${pos.symbol}: Independent position CONFIRMED by target (same direction)`);
            }
            // Copy trading will now manage this position
            continue;
          } else {
            // Target opened opposite direction - close our position
            await this.closePosition(pos, currentPrice, 'target_opposite');
            peakPrices.delete(pos.symbol);
            continue;
          }
        }

        // === 2. UPDATE PEAK PRICE for trailing stop ===
        const holdTimeMs = Date.now() - pos.createdAt.getTime();
        const currentPeak = peakPrices.get(pos.symbol) || pos.entryPrice;
        if (pos.side === 'long' && currentPrice > currentPeak) {
          peakPrices.set(pos.symbol, currentPrice);
        } else if (pos.side === 'short' && currentPrice < currentPeak) {
          peakPrices.set(pos.symbol, currentPrice);
        } else if (!peakPrices.has(pos.symbol)) {
          peakPrices.set(pos.symbol, pos.entryPrice);
        }
        const peak = peakPrices.get(pos.symbol)!;

        // === 3. HARD STOP - always active (-5% from entry) ===
        const pnlFromEntry = pos.side === 'long'
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;

        if (pnlFromEntry <= -CONFIG.HARD_STOP_PCT) {
          await this.closePosition(pos, currentPrice, 'hard_stop');
          peakPrices.delete(pos.symbol);
          continue;
        }

        // === 4. MAX HOLD TIMEOUT ===
        const maxHoldMs = CONFIG.MAX_HOLD_HOURS * 60 * 60 * 1000;
        if (holdTimeMs >= maxHoldMs) {
          await this.closePosition(pos, currentPrice, 'timeout');
          peakPrices.delete(pos.symbol);
          continue;
        }

        // === 5. TRAILING STOP - only after min hold period ===
        const minHoldMs = CONFIG.MIN_HOLD_HOURS * 60 * 60 * 1000;
        if (holdTimeMs >= minHoldMs) {
          const dropFromPeak = pos.side === 'long'
            ? (peak - currentPrice) / peak
            : (currentPrice - peak) / peak;

          if (dropFromPeak >= CONFIG.TRAILING_STOP_PCT) {
            await this.closePosition(pos, currentPrice, 'trailing_stop');
            peakPrices.delete(pos.symbol);
            continue;
          }
        }
      }

    } catch (error: any) {
      logger.error(`IndependentTrader.managePositions error: ${error.message}`);
    }
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

      // Initialize peak price tracking
      peakPrices.set(symbol, price);

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
      logger.info(`🎯 ${symbol}: INDEPENDENT OPEN ${dirLabel} ${size.toFixed(4)} @ $${price.toFixed(2)} (${leverage}x, $${notionalUsd.toFixed(0)} notional, trailing stop ${(CONFIG.TRAILING_STOP_PCT*100)}% after ${CONFIG.MIN_HOLD_HOURS}h, hard stop ${(CONFIG.HARD_STOP_PCT*100)}%, max ${CONFIG.MAX_HOLD_HOURS}h, score: ${score})`);

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
      await HyperliquidConnector.marketClosePosition(
        tickerConfig,
        side === 'long',
        1, // close 100%
        exitPrice
      );

      // Calculate P&L
      const priceDiff = exitPrice - entryPrice;
      const realizedPnl = side === 'long' ? priceDiff * size : -priceDiff * size;
      const realizedPnlPct = (priceDiff / entryPrice) * 100 * (side === 'long' ? 1 : -1);

      // Update database
      await prisma.independentPosition.update({
        where: { id },
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
      const reasonEmoji: Record<string, string> = {
        trailing_stop: '📐',
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
    // Clean up peak price tracking - copy trading takes over
    peakPrices.delete(symbol);
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
