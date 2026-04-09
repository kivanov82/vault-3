import * as hl from "@nktkas/hyperliquid";
import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { prisma } from '../utils/db';

dotenv.config();

const COPY_TRADERS: `0x${string}`[] = (process.env.COPY_TRADERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0) as `0x${string}`[];

/**
 * Startup sync - ensures database has all recent fills from target vault
 * Fetches last 2000 fills from API and compares with database
 */
export class StartupSync {

  /**
   * Sync recent fills on startup
   * This ensures we didn't miss any fills while bot was offline or WebSocket was down
   * Uses pagination to fetch all missing fills (API returns max 2000 per request)
   */
  static async syncRecentFills(): Promise<void> {
    for (const trader of COPY_TRADERS) {
      try {
        // Only sync fills for targets that already have history in DB
        // New copy targets don't need fill history — we only need their live positions
        const existingFills = await prisma.fill.count({
          where: { traderAddress: trader },
        });
        if (existingFills > 0) {
          await this.syncFillsForTrader(trader);
        } else {
          logger.info(`⏭️  ${trader.slice(0, 10)}: New target, skipping fill sync (live positions only)`);
        }
      } catch (error: any) {
        logger.error(`❌ Startup sync failed for ${trader.slice(0, 10)}: ${error.message}`);
      }
    }
  }

  private static async syncFillsForTrader(trader: `0x${string}`): Promise<void> {
    logger.info(`🔄 Syncing fills for ${trader.slice(0, 10)}...`);

    const latestFillInDb = await prisma.fill.findFirst({
      where: { traderAddress: trader },
      orderBy: { timestamp: 'desc' },
    });

    const lastDbTimestamp = latestFillInDb?.timestamp || new Date(0);
    logger.info(`📅 Latest fill in DB: ${lastDbTimestamp.toISOString()}`);

    const transport = new hl.HttpTransport();
    const info = new hl.InfoClient({ transport });

    let startTime = lastDbTimestamp.getTime() + 1;
    let totalFetched = 0;
    let totalImported = 0;
    let totalDuplicates = 0;
    const MAX_PAGES = 20;

    for (let page = 0; page < MAX_PAGES; page++) {
      logger.info(`📡 Fetching fills page ${page + 1} (from ${new Date(startTime).toISOString()})...`);

      const apiFills = await info.userFillsByTime({
        user: trader,
        startTime,
        aggregateByTime: false,
      });

      if (apiFills.length === 0) {
        break;
      }

      totalFetched += apiFills.length;
      logger.info(`📦 Page ${page + 1}: ${apiFills.length} fills`);

      let pageImported = 0;
      let pageDuplicates = 0;

      for (const fill of apiFills) {
        try {
          await prisma.fill.create({
            data: {
              fillId: String(fill.tid || fill.oid),
              timestamp: new Date(fill.time),
              traderAddress: trader,
              symbol: fill.coin,
              side: fill.side,
              price: parseFloat(fill.px),
              size: parseFloat(fill.sz),
              positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
              rawData: fill as any,
            },
          });
          pageImported++;
        } catch (error: any) {
          if (error.code === 'P2002') {
            pageDuplicates++;
          } else {
            logger.error(`Failed to import fill ${fill.tid}: ${error.message}`);
          }
        }
      }

      totalImported += pageImported;
      totalDuplicates += pageDuplicates;

      if (apiFills.length < 2000) {
        break;
      }

      const lastFillTime = Math.max(...apiFills.map(f => f.time));
      startTime = lastFillTime + 1;

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (totalFetched === 0) {
      logger.info(`✅ ${trader.slice(0, 10)}: Database is up to date`);
      return;
    }

    logger.info(`✅ ${trader.slice(0, 10)}: Synced ${totalImported} new fills (${totalDuplicates} dupes)`);

    if (totalImported > 0) {
      await this.aggregateNewFills(trader);
    }
  }

  /**
   * Aggregate unaggregated fills into logical trades
   */
  private static async aggregateNewFills(trader: `0x${string}`): Promise<void> {
    const TWAP_WINDOW_SECONDS = 300; // 5 minutes

    // Get unaggregated fills
    const fills = await prisma.fill.findMany({
      where: {
        traderAddress: trader,
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
          await this.finalizeTrade(currentTrade, trader);
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
        await this.finalizeTrade(currentTrade, trader);
        tradesCreated++;
      }
    }

    logger.info(`✅ Aggregated ${tradesCreated} logical trades from new fills`);
  }

  private static async finalizeTrade(trade: any, trader: `0x${string}`): Promise<void> {
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
        traderAddress: trader,
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
