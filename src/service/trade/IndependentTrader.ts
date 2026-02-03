/**
 * IndependentTrader - Autonomous trading based on high-confidence predictions
 *
 * Opens small positions (max 3% of vault) when:
 * - Prediction score >= 80 (very high confidence)
 * - Direction is LONG only (shorts have 0% historical win rate)
 * - Symbol is on whitelist (100% win rate symbols)
 * - No existing position (copy or independent)
 * - Under max allocation limit
 *
 * Manages positions with:
 * - Take profit: +8%
 * - Stop loss: -4%
 * - Timeout: 24 hours
 * - Target confirmation handling
 */

import dotenv from 'dotenv';
import { prisma } from '../utils/db';
import { logger } from '../utils/logger';
import { HyperliquidConnector } from './HyperliquidConnector';
import { PredictionLogger } from '../ml/PredictionLogger';

dotenv.config();

const WALLET = process.env.WALLET as `0x${string}`;

// Configuration (can be overridden via env vars)
const CONFIG = {
  ENABLED: process.env.ENABLE_INDEPENDENT_TRADING === 'true',
  MAX_ALLOCATION_PCT: parseFloat(process.env.INDEPENDENT_MAX_ALLOCATION_PCT || '0.03'),
  MAX_POSITIONS: parseInt(process.env.INDEPENDENT_MAX_POSITIONS || '3', 10),
  LEVERAGE: parseInt(process.env.INDEPENDENT_LEVERAGE || '5', 10),
  TP_PCT: parseFloat(process.env.INDEPENDENT_TP_PCT || '0.08'),
  SL_PCT: parseFloat(process.env.INDEPENDENT_SL_PCT || '0.04'),
  TIMEOUT_HOURS: parseInt(process.env.INDEPENDENT_TIMEOUT_HOURS || '24', 10),
  MIN_SCORE: 80,
  // Whitelist: symbols with 100% win rate from historical analysis
  WHITELIST: ['VVV', 'AXS', 'IP', 'LDO', 'AAVE', 'XMR', 'GRASS', 'SKY', 'ZORA'],
};

// Asset metadata cache (shared with CopyTradingManager)
const assetMetadataCache = new Map<string, any>();

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
        return; // At max positions
      }

      // Filter and sort predictions by score (highest first)
      const eligiblePredictions = Array.from(predictions.values())
        .filter(p => {
          // Must meet minimum score
          if (p.score < CONFIG.MIN_SCORE) return false;
          // Must be LONG direction (shorts have 0% win rate)
          if (p.direction !== 1) return false;
          // Must be on whitelist
          if (!CONFIG.WHITELIST.includes(p.symbol)) return false;
          // Must not already have position (copy or independent)
          if (ourSymbols.has(p.symbol)) return false;
          if (independentSymbols.has(p.symbol)) return false;
          // Must not be a symbol target already has (defer to copy trading)
          if (targetSymbols.has(p.symbol)) return false;
          return true;
        })
        .sort((a, b) => b.score - a.score);

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
        openIndependent.push({ symbol: pred.symbol } as any); // Quick hack for count
      }

    } catch (error: any) {
      logger.error(`IndependentTrader.processSignals error: ${error.message}`);
    }
  }

  /**
   * Manage existing independent positions (TP/SL/timeout checks)
   * Called during each scan cycle
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

        // Check target confirmation
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
            continue;
          }
        }

        // Check take profit
        if (currentPrice >= pos.tpPrice) {
          await this.closePosition(pos, currentPrice, 'tp');
          continue;
        }

        // Check stop loss
        if (currentPrice <= pos.slPrice) {
          await this.closePosition(pos, currentPrice, 'sl');
          continue;
        }

        // Check timeout
        if (new Date() >= pos.timeoutAt) {
          await this.closePosition(pos, currentPrice, 'timeout');
          continue;
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
    sizeUsd: number,
    allMarkets: Record<string, string>
  ): Promise<void> {
    const { symbol, score, reasons, entryPrice } = prediction;

    try {
      // Get ticker config
      const tickerConfig = await this.getTickerConfig(symbol);
      if (!tickerConfig) {
        logger.warn(`⚠️  ${symbol}: No ticker config for independent trade`);
        return;
      }

      // Calculate size in asset units
      const price = Number(allMarkets[symbol]) || entryPrice;
      const size = sizeUsd / price;

      // Calculate TP/SL prices
      const tpPrice = price * (1 + CONFIG.TP_PCT);
      const slPrice = price * (1 - CONFIG.SL_PCT);
      const timeoutAt = new Date(Date.now() + CONFIG.TIMEOUT_HOURS * 60 * 60 * 1000);

      // Execute the trade
      await HyperliquidConnector.openCopyPosition(
        tickerConfig,
        true, // long only
        size,
        CONFIG.LEVERAGE,
        false, // don't add to existing
        price
      );

      // Record in database
      await prisma.independentPosition.create({
        data: {
          symbol,
          side: 'long',
          entryPrice: price,
          size,
          sizeUsd,
          leverage: CONFIG.LEVERAGE,
          tpPrice,
          slPrice,
          timeoutAt,
          status: 'open',
          confirmedByTarget: false,
          predictionScore: score,
          predictionReasons: reasons,
        },
      });

      logger.info(`🎯 ${symbol}: INDEPENDENT OPEN long ${size.toFixed(4)} @ $${price.toFixed(2)} (score: ${score}, TP: $${tpPrice.toFixed(2)}, SL: $${slPrice.toFixed(2)})`);

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
      const reasonEmoji = {
        tp: '🎯',
        sl: '🛑',
        timeout: '⏰',
        target_confirmed: '✅',
        target_opposite: '🔄',
      }[reason] || '❓';

      logger.info(`${reasonEmoji} ${symbol}: INDEPENDENT CLOSE ${reason} @ $${exitPrice.toFixed(2)} ${pnlEmoji} P&L: $${realizedPnl.toFixed(2)} (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(2)}%)`);

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
  }

  /**
   * Get ticker config from Hyperliquid metadata
   */
  private static async getTickerConfig(symbol: string): Promise<any | null> {
    // Fetch metadata if not cached
    if (assetMetadataCache.size === 0) {
      try {
        const transport = await import('@nktkas/hyperliquid').then(m => new m.HttpTransport());
        const info = await import('@nktkas/hyperliquid').then(m => new m.InfoClient({ transport }));
        const meta = await info.meta();

        meta.universe.forEach((asset, index) => {
          assetMetadataCache.set(asset.name, {
            name: asset.name,
            id: index,
            szDecimals: asset.szDecimals,
            maxLeverage: asset.maxLeverage,
          });
        });
      } catch (error: any) {
        logger.error(`Failed to fetch asset metadata: ${error.message}`);
        return null;
      }
    }

    const metadata = assetMetadataCache.get(symbol);
    if (!metadata) {
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
