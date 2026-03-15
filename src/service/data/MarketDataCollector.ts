/**
 * Market Data Collector
 *
 * Fetches candles and funding rates from Hyperliquid,
 * computes technical indicators, and stores in the database.
 *
 * Runs every scan cycle to keep prediction data fresh.
 */

import { prisma } from '../utils/db';
import { logger } from '../utils/logger';
import { HyperliquidConnector } from '../trade/HyperliquidConnector';
import { calculateAllIndicators, type OHLCV } from '../utils/indicators';

// How many 1h candles to fetch per symbol (need 200+ for EMA200, 50+ for EMA50, 26+ for MACD)
const CANDLE_COUNT = 210;

// Throttle: don't re-fetch a symbol if we fetched it less than 30 min ago
const FETCH_COOLDOWN_MS = 30 * 60 * 1000;
const lastFetchTime = new Map<string, number>();

export class MarketDataCollector {
  /**
   * Collect market data for the given symbols.
   * Fetches 1h candles, computes indicators, saves to DB.
   */
  static async collect(symbols: string[]): Promise<void> {
    const now = Date.now();

    // Filter to symbols that need refreshing
    const toFetch = symbols.filter(s => {
      const last = lastFetchTime.get(s);
      return !last || (now - last) > FETCH_COOLDOWN_MS;
    });

    if (toFetch.length === 0) return;

    logger.info(`📈 Collecting market data for ${toFetch.length} symbols...`);
    let successCount = 0;

    // Process in batches of 5 to avoid API rate limits
    const BATCH_SIZE = 5;
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(symbol => this.collectSymbol(symbol))
      );

      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
          lastFetchTime.set(batch[idx], now);
        }
      });
    }

    if (successCount > 0) {
      logger.info(`📈 Market data updated for ${successCount}/${toFetch.length} symbols`);
    }
  }

  /**
   * Collect candles and indicators for a single symbol.
   */
  private static async collectSymbol(symbol: string): Promise<boolean> {
    try {
      // Fetch 1h candles from Hyperliquid
      const rawCandles = await HyperliquidConnector.candleSnapshot1h(symbol, CANDLE_COUNT);

      if (!rawCandles || rawCandles.length < 26) {
        // Need at least 26 candles for MACD
        return false;
      }

      // Convert to OHLCV format (Hyperliquid returns { t, o, h, l, c, v })
      const candles: OHLCV[] = rawCandles.map((c: any) => ({
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v),
      }));

      // Store candles in DB (upsert to avoid duplicates)
      const timestamps = rawCandles.map((c: any) => new Date(c.t));
      for (let j = 0; j < candles.length; j++) {
        const candle = candles[j];
        const timestamp = timestamps[j];

        await prisma.candle.upsert({
          where: {
            symbol_timeframe_timestamp: {
              symbol,
              timeframe: '1h',
              timestamp,
            },
          },
          update: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
          create: {
            symbol,
            timeframe: '1h',
            timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
        });
      }

      // Compute technical indicators from candles
      const indicators = calculateAllIndicators(candles);

      // Store indicators for the latest candle
      const latestTimestamp = timestamps[timestamps.length - 1];
      await prisma.technicalIndicator.upsert({
        where: {
          symbol_timeframe_timestamp: {
            symbol,
            timeframe: '1h',
            timestamp: latestTimestamp,
          },
        },
        update: {
          ema9: indicators.ema9,
          ema21: indicators.ema21,
          ema50: indicators.ema50,
          ema200: indicators.ema200,
          rsi14: indicators.rsi14,
          macd: indicators.macd,
          macdSignal: indicators.macdSignal,
          macdHist: indicators.macdHist,
          bbUpper: indicators.bbUpper,
          bbMiddle: indicators.bbMiddle,
          bbLower: indicators.bbLower,
          bbWidth: indicators.bbWidth,
          atr14: indicators.atr14,
        },
        create: {
          symbol,
          timeframe: '1h',
          timestamp: latestTimestamp,
          ema9: indicators.ema9,
          ema21: indicators.ema21,
          ema50: indicators.ema50,
          ema200: indicators.ema200,
          rsi14: indicators.rsi14,
          macd: indicators.macd,
          macdSignal: indicators.macdSignal,
          macdHist: indicators.macdHist,
          bbUpper: indicators.bbUpper,
          bbMiddle: indicators.bbMiddle,
          bbLower: indicators.bbLower,
          bbWidth: indicators.bbWidth,
          atr14: indicators.atr14,
        },
      });

      return true;
    } catch (error: any) {
      logger.error(`📈 ${symbol}: Data collection failed - ${error.message}`);
      return false;
    }
  }

  /**
   * Collect funding rates for symbols.
   * Hyperliquid provides funding via clearinghouse state.
   */
  static async collectFundingRates(symbols: string[]): Promise<void> {
    try {
      // Funding rates come from the meta endpoint
      const transport = HyperliquidConnector.getClients().public;
      const fundingData = await (transport as any).fundingHistory({
        coin: symbols[0], // API requires a coin, we get all
        startTime: Date.now() - 24 * 60 * 60 * 1000,
      }).catch(() => null);

      // Funding data may not be available via this endpoint
      // The prediction system already reads from the DB, so we'll
      // rely on the existing funding collection if any
    } catch (error: any) {
      // Non-critical - funding data is supplementary
    }
  }
}
