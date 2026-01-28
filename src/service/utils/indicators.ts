/**
 * Technical Indicators Utility
 *
 * Implementations of common technical indicators for strategy analysis.
 * All functions expect arrays of price data (oldest first).
 */

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Simple Moving Average
 */
export function sma(data: number[], period: number): number[] {
  if (data.length < period) return [];

  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

/**
 * Exponential Moving Average
 */
export function ema(data: number[], period: number): number[] {
  if (data.length < period) return [];

  const result: number[] = [];
  const multiplier = 2 / (period + 1);

  // First EMA is SMA
  let prevEma = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prevEma);

  for (let i = period; i < data.length; i++) {
    const currentEma = (data[i] - prevEma) * multiplier + prevEma;
    result.push(currentEma);
    prevEma = currentEma;
  }

  return result;
}

/**
 * Relative Strength Index (RSI)
 */
export function rsi(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];

  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate price changes
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  // First average gain/loss
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // First RSI
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - (100 / (1 + rs)));

  // Subsequent RSIs using smoothed averages
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - (100 / (1 + rs)));
  }

  return result;
}

/**
 * MACD (Moving Average Convergence Divergence)
 */
export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  // Align EMAs (slow EMA has fewer values)
  const offset = fastPeriod - slowPeriod;
  const alignedFastEma = fastEma.slice(-slowEma.length);

  // MACD line
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(alignedFastEma[i] - slowEma[i]);
  }

  // Signal line (EMA of MACD)
  const signalLine = ema(macdLine, signalPeriod);

  // Histogram
  const histogram: number[] = [];
  const macdOffset = macdLine.length - signalLine.length;
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + macdOffset] - signalLine[i]);
  }

  return {
    macd: macdLine.slice(-signalLine.length),
    signal: signalLine,
    histogram
  };
}

/**
 * Bollinger Bands
 */
export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
}

export function bollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBandsResult {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const idx = i - period + 1;
    upper.push(middle[idx] + stdDevMultiplier * stdDev);
    lower.push(middle[idx] - stdDevMultiplier * stdDev);
    width.push((stdDevMultiplier * 2 * stdDev) / middle[idx]); // Normalized width
  }

  return { upper, middle, lower, width };
}

/**
 * Average True Range (ATR)
 */
export function atr(candles: OHLCV[], period: number = 14): number[] {
  if (candles.length < period + 1) return [];

  // Calculate True Range
  const trueRanges: number[] = [];

  // First TR is just high - low
  trueRanges.push(candles[0].high - candles[0].low);

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Calculate ATR using Wilder's smoothing
  const result: number[] = [];

  // First ATR is simple average
  let currentAtr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(currentAtr);

  for (let i = period; i < trueRanges.length; i++) {
    currentAtr = (currentAtr * (period - 1) + trueRanges[i]) / period;
    result.push(currentAtr);
  }

  return result;
}

/**
 * Stochastic Oscillator
 */
export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(
  candles: OHLCV[],
  kPeriod: number = 14,
  dPeriod: number = 3
): StochasticResult {
  if (candles.length < kPeriod) return { k: [], d: [] };

  const kValues: number[] = [];

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...slice.map(c => c.high));
    const lowestLow = Math.min(...slice.map(c => c.low));
    const close = candles[i].close;

    const k = highestHigh === lowestLow ? 50 : ((close - lowestLow) / (highestHigh - lowestLow)) * 100;
    kValues.push(k);
  }

  // %D is SMA of %K
  const dValues = sma(kValues, dPeriod);

  return {
    k: kValues.slice(-dValues.length),
    d: dValues
  };
}

/**
 * Rate of Change (ROC)
 */
export function roc(closes: number[], period: number = 12): number[] {
  if (closes.length <= period) return [];

  const result: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const change = ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
    result.push(change);
  }
  return result;
}

/**
 * Williams %R
 */
export function williamsR(candles: OHLCV[], period: number = 14): number[] {
  if (candles.length < period) return [];

  const result: number[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const highestHigh = Math.max(...slice.map(c => c.high));
    const lowestLow = Math.min(...slice.map(c => c.low));
    const close = candles[i].close;

    const wr = highestHigh === lowestLow ? -50 : ((highestHigh - close) / (highestHigh - lowestLow)) * -100;
    result.push(wr);
  }

  return result;
}

/**
 * On-Balance Volume (OBV)
 */
export function obv(candles: OHLCV[]): number[] {
  if (candles.length === 0) return [];

  const result: number[] = [0];

  for (let i = 1; i < candles.length; i++) {
    const prevObv = result[result.length - 1];
    const volume = candles[i].volume;

    if (candles[i].close > candles[i - 1].close) {
      result.push(prevObv + volume);
    } else if (candles[i].close < candles[i - 1].close) {
      result.push(prevObv - volume);
    } else {
      result.push(prevObv);
    }
  }

  return result;
}

/**
 * Average Directional Index (ADX)
 */
export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export function adx(candles: OHLCV[], period: number = 14): ADXResult {
  if (candles.length < period + 1) return { adx: [], plusDI: [], minusDI: [] };

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    // True Range
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  // Smooth with Wilder's method
  const smoothedTR: number[] = [];
  const smoothedPlusDM: number[] = [];
  const smoothedMinusDM: number[] = [];

  let trSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusSum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusSum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  smoothedTR.push(trSum);
  smoothedPlusDM.push(plusSum);
  smoothedMinusDM.push(minusSum);

  for (let i = period; i < tr.length; i++) {
    trSum = trSum - (trSum / period) + tr[i];
    plusSum = plusSum - (plusSum / period) + plusDM[i];
    minusSum = minusSum - (minusSum / period) + minusDM[i];

    smoothedTR.push(trSum);
    smoothedPlusDM.push(plusSum);
    smoothedMinusDM.push(minusSum);
  }

  // Calculate +DI and -DI
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < smoothedTR.length; i++) {
    const pdi = smoothedTR[i] === 0 ? 0 : (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const mdi = smoothedTR[i] === 0 ? 0 : (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    plusDI.push(pdi);
    minusDI.push(mdi);

    const diSum = pdi + mdi;
    dx.push(diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100);
  }

  // Smooth DX to get ADX
  const adxValues = ema(dx, period);

  return {
    adx: adxValues,
    plusDI: plusDI.slice(-adxValues.length),
    minusDI: minusDI.slice(-adxValues.length)
  };
}

/**
 * Calculate all indicators for a candle series
 */
export interface AllIndicators {
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  stochK: number | null;
  stochD: number | null;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  roc12: number | null;
  williamsR: number | null;
}

export function calculateAllIndicators(candles: OHLCV[]): AllIndicators {
  const closes = candles.map(c => c.close);

  // Need at least some data
  if (candles.length < 26) {
    return {
      rsi14: null, macd: null, macdSignal: null, macdHist: null,
      bbUpper: null, bbMiddle: null, bbLower: null, bbWidth: null,
      ema9: null, ema21: null, ema50: null, ema200: null,
      atr14: null, stochK: null, stochD: null,
      adx: null, plusDI: null, minusDI: null,
      roc12: null, williamsR: null
    };
  }

  const rsiValues = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes, 20, 2);
  const ema9Values = ema(closes, 9);
  const ema21Values = ema(closes, 21);
  const ema50Values = candles.length >= 50 ? ema(closes, 50) : [];
  const ema200Values = candles.length >= 200 ? ema(closes, 200) : [];
  const atrValues = atr(candles, 14);
  const stochResult = stochastic(candles, 14, 3);
  const adxResult = adx(candles, 14);
  const rocValues = roc(closes, 12);
  const wrValues = williamsR(candles, 14);

  const last = (arr: number[]) => arr.length > 0 ? arr[arr.length - 1] : null;

  return {
    rsi14: last(rsiValues),
    macd: last(macdResult.macd),
    macdSignal: last(macdResult.signal),
    macdHist: last(macdResult.histogram),
    bbUpper: last(bbResult.upper),
    bbMiddle: last(bbResult.middle),
    bbLower: last(bbResult.lower),
    bbWidth: last(bbResult.width),
    ema9: last(ema9Values),
    ema21: last(ema21Values),
    ema50: last(ema50Values),
    ema200: last(ema200Values),
    atr14: last(atrValues),
    stochK: last(stochResult.k),
    stochD: last(stochResult.d),
    adx: last(adxResult.adx),
    plusDI: last(adxResult.plusDI),
    minusDI: last(adxResult.minusDI),
    roc12: last(rocValues),
    williamsR: last(wrValues)
  };
}
