/**
 * Feature Engineering for ML Prediction
 *
 * Generates 50+ features for predicting target vault trades:
 * - Price features (changes, distances from EMAs, BB position)
 * - Momentum features (RSI, MACD, crossovers)
 * - Volatility features (ATR, BB width, volume ratios)
 * - Context features (BTC/ETH changes, funding rate)
 * - Time features (hour, day, minutes to funding)
 * - Behavioral features (recent trades, current position)
 */

import dotenv from 'dotenv';
import { prisma } from '../utils/db';
import { calculateAllIndicators, OHLCV } from '../utils/indicators';

dotenv.config();

export interface FeatureSet {
  // Metadata
  symbol: string;
  timestamp: Date;

  // Price features (12)
  priceChange1h: number | null;
  priceChange4h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
  distanceFromEma9: number | null;
  distanceFromEma21: number | null;
  distanceFromEma50: number | null;
  distanceFromEma200: number | null;
  bbPosition: number | null;          // 0 = lower band, 1 = upper band
  distanceFrom24hHigh: number | null;
  distanceFrom24hLow: number | null;
  priceVsVwap: number | null;

  // Momentum features (10)
  rsi14: number | null;
  rsiChange: number | null;           // RSI change over last 4 hours
  macdHist: number | null;
  macdHistChange: number | null;
  stochK: number | null;
  stochD: number | null;
  adx: number | null;
  plusDIMinusDI: number | null;       // +DI minus -DI
  roc12: number | null;
  williamsR: number | null;

  // Volatility features (8)
  atr14: number | null;
  atr14Normalized: number | null;     // ATR / price
  bbWidth: number | null;
  bbWidthChange: number | null;       // BB width change
  volumeRatio: number | null;         // Current volume vs 20-period avg
  volumeChange: number | null;
  highLowRange: number | null;        // Today's range / ATR
  volatilityRegime: number | null;    // 0 = low, 1 = normal, 2 = high

  // Context features (8)
  btcChange1h: number | null;
  btcChange24h: number | null;
  ethChange1h: number | null;
  ethChange24h: number | null;
  correlationWithBtc: number | null;  // 24h correlation
  fundingRate: number | null;
  fundingRateNormalized: number | null;
  marketSentiment: number | null;     // Derived from BTC trend

  // Time features (6)
  hourOfDay: number;
  dayOfWeek: number;
  isWeekend: number;
  minutesToFunding: number | null;    // Minutes until next 8h funding
  isAsiaSession: number;
  isUSSession: number;

  // Behavioral features (6)
  targetHasPosition: number;          // 1 if target has position
  targetPositionSide: number | null;  // 1 = long, -1 = short, null = no position
  targetPositionSize: number | null;  // Normalized size
  hoursSinceLastTrade: number | null;
  tradesInLast24h: number;
  recentTradeDirection: number | null; // Direction of most recent trade

  // Cross-asset features (4)
  sectorMomentum: number | null;      // Average momentum of related assets
  relativeStrength: number | null;    // Performance vs sector
  btcDominance: number | null;
  altSeasonIndex: number | null;
}

export class FeatureEngine {
  private candleCache: Map<string, OHLCV[]> = new Map();
  private btcCache: OHLCV[] = [];
  private ethCache: OHLCV[] = [];

  /**
   * Generate features for a specific symbol at a specific time
   */
  async generateFeatures(symbol: string, timestamp: Date): Promise<FeatureSet> {
    // Get candles for the symbol
    const candles = await this.getCandles(symbol, timestamp, 200);
    const btcCandles = await this.getBTCCandles(timestamp, 200);
    const ethCandles = await this.getETHCandles(timestamp, 200);

    // Get current indicators
    const indicators = calculateAllIndicators(candles);

    // Get funding rate
    const fundingRate = await this.getFundingRate(symbol, timestamp);

    // Get target position info
    const targetPosition = await this.getTargetPosition(symbol, timestamp);

    // Get recent trades
    const recentTrades = await this.getRecentTrades(symbol, timestamp);

    // Calculate features
    const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
    const currentBtcPrice = btcCandles.length > 0 ? btcCandles[btcCandles.length - 1].close : null;
    const currentEthPrice = ethCandles.length > 0 ? ethCandles[ethCandles.length - 1].close : null;

    // Price changes
    const priceChange1h = this.calculatePriceChange(candles, 1);
    const priceChange4h = this.calculatePriceChange(candles, 4);
    const priceChange24h = this.calculatePriceChange(candles, 24);
    const priceChange7d = this.calculatePriceChange(candles, 168);

    // BTC/ETH changes
    const btcChange1h = this.calculatePriceChange(btcCandles, 1);
    const btcChange24h = this.calculatePriceChange(btcCandles, 24);
    const ethChange1h = this.calculatePriceChange(ethCandles, 1);
    const ethChange24h = this.calculatePriceChange(ethCandles, 24);

    // Distance from EMAs
    const distanceFromEma9 = currentPrice && indicators.ema9
      ? ((currentPrice - indicators.ema9) / indicators.ema9) * 100
      : null;
    const distanceFromEma21 = currentPrice && indicators.ema21
      ? ((currentPrice - indicators.ema21) / indicators.ema21) * 100
      : null;
    const distanceFromEma50 = currentPrice && indicators.ema50
      ? ((currentPrice - indicators.ema50) / indicators.ema50) * 100
      : null;
    const distanceFromEma200 = currentPrice && indicators.ema200
      ? ((currentPrice - indicators.ema200) / indicators.ema200) * 100
      : null;

    // Bollinger Band position
    const bbPosition = currentPrice && indicators.bbUpper && indicators.bbLower
      ? (currentPrice - indicators.bbLower) / (indicators.bbUpper - indicators.bbLower)
      : null;

    // 24h high/low distance
    const last24Candles = candles.slice(-24);
    const high24h = last24Candles.length > 0 ? Math.max(...last24Candles.map(c => c.high)) : null;
    const low24h = last24Candles.length > 0 ? Math.min(...last24Candles.map(c => c.low)) : null;
    const distanceFrom24hHigh = currentPrice && high24h
      ? ((high24h - currentPrice) / currentPrice) * 100
      : null;
    const distanceFrom24hLow = currentPrice && low24h
      ? ((currentPrice - low24h) / currentPrice) * 100
      : null;

    // ATR normalized
    const atr14Normalized = currentPrice && indicators.atr14
      ? (indicators.atr14 / currentPrice) * 100
      : null;

    // Volume ratio
    const recentVolume = candles.slice(-1)[0]?.volume || 0;
    const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / Math.min(20, candles.length);
    const volumeRatio = avgVolume > 0 ? recentVolume / avgVolume : null;

    // Volatility regime (based on ATR percentile)
    let volatilityRegime: number | null = null;
    if (atr14Normalized !== null) {
      if (atr14Normalized < 2) volatilityRegime = 0; // Low
      else if (atr14Normalized < 5) volatilityRegime = 1; // Normal
      else volatilityRegime = 2; // High
    }

    // Market sentiment (based on BTC trend)
    let marketSentiment: number | null = null;
    if (btcChange24h !== null) {
      if (btcChange24h > 3) marketSentiment = 2;      // Strong bull
      else if (btcChange24h > 0) marketSentiment = 1; // Mild bull
      else if (btcChange24h > -3) marketSentiment = -1; // Mild bear
      else marketSentiment = -2;                      // Strong bear
    }

    // Time features
    const hour = timestamp.getUTCHours();
    const day = timestamp.getUTCDay();
    const isWeekend = day === 0 || day === 6 ? 1 : 0;
    const isAsiaSession = hour >= 0 && hour < 8 ? 1 : 0;
    const isUSSession = hour >= 13 && hour < 22 ? 1 : 0;

    // Minutes to funding (8h epochs at 00:00, 08:00, 16:00 UTC)
    const fundingHours = [0, 8, 16];
    const currentMinutes = hour * 60 + timestamp.getUTCMinutes();
    let minutesToFunding: number | null = null;
    for (const fh of fundingHours) {
      const fundingMinutes = fh * 60;
      if (fundingMinutes > currentMinutes) {
        minutesToFunding = fundingMinutes - currentMinutes;
        break;
      }
    }
    if (minutesToFunding === null) {
      // Next funding is tomorrow at 00:00
      minutesToFunding = (24 * 60) - currentMinutes;
    }

    // Behavioral features
    const targetHasPosition = targetPosition !== null ? 1 : 0;
    const targetPositionSide = targetPosition?.side === 'long' ? 1 :
      (targetPosition?.side === 'short' ? -1 : null);
    const targetPositionSize = targetPosition?.size || null;

    const lastTrade = recentTrades[0];
    const hoursSinceLastTrade = lastTrade
      ? (timestamp.getTime() - lastTrade.timestamp.getTime()) / (1000 * 60 * 60)
      : null;
    const tradesInLast24h = recentTrades.filter(t =>
      timestamp.getTime() - t.timestamp.getTime() < 24 * 60 * 60 * 1000
    ).length;
    const recentTradeDirection = lastTrade?.side === 'long' ? 1 :
      (lastTrade?.side === 'short' ? -1 : null);

    // Correlation with BTC (simplified - use price changes)
    let correlationWithBtc: number | null = null;
    if (candles.length >= 24 && btcCandles.length >= 24) {
      const symbolChanges = candles.slice(-24).map((c, i, arr) =>
        i > 0 ? (c.close - arr[i - 1].close) / arr[i - 1].close : 0
      ).slice(1);
      const btcChanges = btcCandles.slice(-24).map((c, i, arr) =>
        i > 0 ? (c.close - arr[i - 1].close) / arr[i - 1].close : 0
      ).slice(1);

      correlationWithBtc = this.calculateCorrelation(symbolChanges, btcChanges);
    }

    return {
      symbol,
      timestamp,

      // Price features
      priceChange1h,
      priceChange4h,
      priceChange24h,
      priceChange7d,
      distanceFromEma9,
      distanceFromEma21,
      distanceFromEma50,
      distanceFromEma200,
      bbPosition,
      distanceFrom24hHigh,
      distanceFrom24hLow,
      priceVsVwap: null, // Would need volume-weighted calculation

      // Momentum features
      rsi14: indicators.rsi14,
      rsiChange: null, // Would need historical RSI
      macdHist: indicators.macdHist,
      macdHistChange: null,
      stochK: indicators.stochK,
      stochD: indicators.stochD,
      adx: indicators.adx,
      plusDIMinusDI: indicators.plusDI !== null && indicators.minusDI !== null
        ? indicators.plusDI - indicators.minusDI
        : null,
      roc12: indicators.roc12,
      williamsR: indicators.williamsR,

      // Volatility features
      atr14: indicators.atr14,
      atr14Normalized,
      bbWidth: indicators.bbWidth,
      bbWidthChange: null,
      volumeRatio,
      volumeChange: null,
      highLowRange: candles.length > 0 && indicators.atr14
        ? (candles[candles.length - 1].high - candles[candles.length - 1].low) / indicators.atr14
        : null,
      volatilityRegime,

      // Context features
      btcChange1h,
      btcChange24h,
      ethChange1h,
      ethChange24h,
      correlationWithBtc,
      fundingRate,
      fundingRateNormalized: fundingRate !== null ? fundingRate / 100 : null,
      marketSentiment,

      // Time features
      hourOfDay: hour,
      dayOfWeek: day,
      isWeekend,
      minutesToFunding,
      isAsiaSession,
      isUSSession,

      // Behavioral features
      targetHasPosition,
      targetPositionSide,
      targetPositionSize,
      hoursSinceLastTrade,
      tradesInLast24h,
      recentTradeDirection,

      // Cross-asset features
      sectorMomentum: null,
      relativeStrength: null,
      btcDominance: null,
      altSeasonIndex: null
    };
  }

  /**
   * Generate features for all traded symbols at a specific time
   */
  async generateFeaturesForAllSymbols(timestamp: Date): Promise<FeatureSet[]> {
    // Get all traded symbols
    const symbols = await prisma.trade.findMany({
      select: { symbol: true },
      distinct: ['symbol']
    });

    const features: FeatureSet[] = [];

    for (const { symbol } of symbols) {
      try {
        const featureSet = await this.generateFeatures(symbol, timestamp);
        features.push(featureSet);
      } catch (error) {
        console.error(`Error generating features for ${symbol}:`, error);
      }
    }

    return features;
  }

  /**
   * Save features to database
   */
  async saveFeatures(features: FeatureSet, label?: number, direction?: number): Promise<void> {
    await prisma.featureSnapshot.upsert({
      where: {
        symbol_timestamp: {
          symbol: features.symbol,
          timestamp: features.timestamp
        }
      },
      update: {
        features: features as any,
        label,
        direction
      },
      create: {
        symbol: features.symbol,
        timestamp: features.timestamp,
        features: features as any,
        label,
        direction
      }
    });
  }

  // Helper methods

  private async getCandles(symbol: string, timestamp: Date, count: number): Promise<OHLCV[]> {
    const candles = await prisma.candle.findMany({
      where: {
        symbol,
        timeframe: '1h',
        timestamp: { lte: timestamp }
      },
      orderBy: { timestamp: 'desc' },
      take: count,
      select: {
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true
      }
    });

    return candles.reverse();
  }

  private async getBTCCandles(timestamp: Date, count: number): Promise<OHLCV[]> {
    return this.getCandles('BTC', timestamp, count);
  }

  private async getETHCandles(timestamp: Date, count: number): Promise<OHLCV[]> {
    return this.getCandles('ETH', timestamp, count);
  }

  private async getFundingRate(symbol: string, timestamp: Date): Promise<number | null> {
    const funding = await prisma.fundingRate.findFirst({
      where: {
        symbol,
        timestamp: { lte: timestamp }
      },
      orderBy: { timestamp: 'desc' }
    });

    return funding?.rate ?? null;
  }

  private async getTargetPosition(
    symbol: string,
    timestamp: Date
  ): Promise<{ side: string; size: number } | null> {
    // Look for most recent trade for this symbol
    const recentTrade = await prisma.trade.findFirst({
      where: {
        trader: 'target',
        symbol,
        timestamp: { lte: timestamp }
      },
      orderBy: { timestamp: 'desc' },
      select: { side: true, size: true }
    });

    return recentTrade;
  }

  private async getRecentTrades(
    symbol: string,
    timestamp: Date
  ): Promise<Array<{ timestamp: Date; side: string }>> {
    const trades = await prisma.trade.findMany({
      where: {
        trader: 'target',
        symbol,
        timestamp: {
          lte: timestamp,
          gte: new Date(timestamp.getTime() - 7 * 24 * 60 * 60 * 1000)
        }
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true, side: true }
    });

    return trades;
  }

  private calculatePriceChange(candles: OHLCV[], hours: number): number | null {
    if (candles.length < hours + 1) return null;

    const current = candles[candles.length - 1].close;
    const past = candles[candles.length - 1 - hours]?.close;

    if (!past) return null;

    return ((current - past) / past) * 100;
  }

  private calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
  }
}

export const featureEngine = new FeatureEngine();
