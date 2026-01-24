import * as hl from "@nktkas/hyperliquid";
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const COPY_TRADER = process.env.COPY_TRADER as `0x${string}`;

// Database
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Startup sync - ensures database has all recent fills from target vault
 * Fetches last 2000 fills from API and compares with database
 */
export class StartupSync {

  /**
   * Sync recent fills on startup
   * This ensures we didn't miss any fills while bot was offline or WebSocket was down
   */
  static async syncRecentFills(): Promise<void> {
    try {
      logger.info('🔄 Starting startup sync...');

      // Get most recent fill from database
      const latestFillInDb = await prisma.fill.findFirst({
        where: { traderAddress: COPY_TRADER },
        orderBy: { timestamp: 'desc' },
      });

      const lastDbTimestamp = latestFillInDb?.timestamp || new Date(0);
      logger.info(`📅 Latest fill in DB: ${lastDbTimestamp.toISOString()}`);

      // Fetch recent fills from API
      const transport = new hl.HttpTransport();
      const info = new hl.InfoClient({ transport });

      logger.info('📡 Fetching recent fills from Hyperliquid API...');
      const apiFills = await info.userFills({
        user: COPY_TRADER,
        aggregateByTime: false,
      });

      logger.info(`📦 Fetched ${apiFills.length} fills from API`);

      // Filter fills newer than what we have in DB
      let newFills = apiFills.filter(fill => {
        const fillTime = new Date(fill.time);
        return fillTime > lastDbTimestamp;
      });

      if (newFills.length === 0) {
        logger.info('✅ Database is up to date - no missing fills');
        return;
      }

      logger.info(`🆕 Found ${newFills.length} new fills to import`);

      // Import new fills
      let imported = 0;
      let duplicates = 0;

      for (const fill of newFills) {
        try {
          await prisma.fill.create({
            data: {
              fillId: String(fill.tid || fill.oid),
              timestamp: new Date(fill.time),
              traderAddress: COPY_TRADER,
              symbol: fill.coin,
              side: fill.side,
              price: parseFloat(fill.px),
              size: parseFloat(fill.sz),
              positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
              rawData: fill as any,
            },
          });
          imported++;
        } catch (error: any) {
          if (error.code === 'P2002') {
            // Duplicate - already in database
            duplicates++;
          } else {
            logger.error(`Failed to import fill ${fill.tid}: ${error.message}`);
          }
        }
      }

      logger.info(`✅ Startup sync complete:`);
      logger.info(`   Imported: ${imported} new fills`);
      if (duplicates > 0) {
        logger.info(`   Skipped: ${duplicates} duplicates`);
      }

      // Aggregate new fills into trades if any were imported
      if (imported > 0) {
        await this.aggregateNewFills();
      }

    } catch (error: any) {
      logger.error(`❌ Startup sync failed: ${error.message}`);
      // Don't throw - allow bot to continue even if sync fails
    }
  }

  /**
   * Aggregate unaggregated fills into logical trades
   */
  private static async aggregateNewFills(): Promise<void> {
    const TWAP_WINDOW_SECONDS = 300; // 5 minutes

    // Get unaggregated fills
    const fills = await prisma.fill.findMany({
      where: {
        traderAddress: COPY_TRADER,
        aggregateTradeId: null,
      },
      orderBy: { timestamp: 'asc' },
    });

    if (fills.length === 0) {
      return;
    }

    logger.info(`🔄 Aggregating ${fills.length} new fills into trades...`);

    let currentTrade: {
      symbol: string;
      side: 'long' | 'short';
      fills: any[];
      firstFillTime: number;
      lastFillTime: number;
      totalSize: number;
    } | null = null;

    let tradesCreated = 0;

    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i];
      const fillTime = fill.timestamp.getTime();

      if (!currentTrade) {
        currentTrade = {
          symbol: fill.symbol,
          side: fill.side === 'B' ? 'long' : 'short',
          fills: [fill],
          firstFillTime: fillTime,
          lastFillTime: fillTime,
          totalSize: fill.size,
        };
      } else {
        const isSameSymbol = fill.symbol === currentTrade.symbol;
        const isSameDirection = (fill.side === 'B' && currentTrade.side === 'long') ||
                                (fill.side === 'A' && currentTrade.side === 'short');
        const timeDiff = (fillTime - currentTrade.lastFillTime) / 1000;
        const isWithinWindow = timeDiff < TWAP_WINDOW_SECONDS;

        if (isSameSymbol && isSameDirection && isWithinWindow) {
          currentTrade.fills.push(fill);
          currentTrade.lastFillTime = fillTime;
          currentTrade.totalSize += fill.size;
        } else {
          await this.finalizeTrade(currentTrade);
          tradesCreated++;

          currentTrade = {
            symbol: fill.symbol,
            side: fill.side === 'B' ? 'long' : 'short',
            fills: [fill],
            firstFillTime: fillTime,
            lastFillTime: fillTime,
            totalSize: fill.size,
          };
        }
      }

      if (i === fills.length - 1 && currentTrade) {
        await this.finalizeTrade(currentTrade);
        tradesCreated++;
      }
    }

    logger.info(`✅ Aggregated ${tradesCreated} logical trades from new fills`);
  }

  private static async finalizeTrade(trade: any): Promise<void> {
    const avgPrice = trade.fills.reduce((sum: number, f: any) => sum + f.price * f.size, 0) / trade.totalSize;
    const duration = (trade.lastFillTime - trade.firstFillTime) / 1000;

    const firstFillPrice = trade.fills[0].price;
    const worstSlippage = trade.fills.reduce((worst: number, f: any) => {
      const slippage = Math.abs((f.price - firstFillPrice) / firstFillPrice) * 10000;
      return Math.max(worst, slippage);
    }, 0);

    const createdTrade = await prisma.trade.create({
      data: {
        timestamp: new Date(trade.firstFillTime),
        trader: 'target',
        traderAddress: COPY_TRADER,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: avgPrice,
        size: trade.totalSize,
        leverage: 1,
        isTwapOrder: trade.fills.length > 1,
        fillCount: trade.fills.length,
        twapDurationSeconds: Math.round(duration),
        avgEntryPrice: avgPrice,
        worstSlippage: worstSlippage,
      },
    });

    for (let i = 0; i < trade.fills.length; i++) {
      await prisma.fill.update({
        where: { id: trade.fills[i].id },
        data: {
          aggregateTradeId: createdTrade.id,
          isFirstFill: i === 0,
          isLastFill: i === trade.fills.length - 1,
        },
      });
    }
  }

  /**
   * Close database connection
   */
  static async disconnect(): Promise<void> {
    await prisma.$disconnect();
  }
}
