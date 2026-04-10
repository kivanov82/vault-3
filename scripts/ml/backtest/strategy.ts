/**
 * Backtest strategy module.
 *
 * Mirrors live system:
 * - Scoring: momentum-v6 from PredictionLogger.ts
 * - Exits: IndependentTrader v5.1 (BB>0.8, RSI>70, EMA_TP, hard_stop, timeout)
 *
 * Kept standalone so variations can override pieces (score cap, exit rules, etc.)
 * without touching live code.
 */

// ========= TYPES =========

export interface CandleRow {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // Indicators (backfilled)
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
}

export interface BtcContext {
  price: number;
  rsi14: number | null;
  macdHist: number | null;
  ema50: number | null;
  ema200: number | null;
  change1h: number | null;
  change4h: number | null;
  change7d: number | null;
  isCalm: boolean;
}

export interface ScoringResult {
  score: number;
  direction: number | null; // 1 long, -1 short
  reasons: string[];
}

// ========= STRATEGY CONSTANTS (v6) =========

export const STRATEGY = {
  ALWAYS_LONG_SYMBOLS: ['ENA','SKY','RESOLV','VIRTUAL','AERO','JUP','FARTCOIN','ZEC','AXS','BERA','XMR','AIXBT','AVNT'],
  DIRECTIONAL_SYMBOLS: ['BTC','ETH','SOL','HYPE','VVV','kPEPE','SPX'],
  MOSTLY_SHORT_SYMBOLS: ['SKR','PUMP','MON','LIT','BNB'],
  TOP_SYMBOLS: ['HYPE','ETH','SOL','VVV','MON','FARTCOIN'],
  SECONDARY_SYMBOLS: ['PUMP','kPEPE','SPX','SKY'],
  ASIA_HOURS: [0,1,2,3,4,5,6,7],
  EUROPE_HOURS: [8,9,10,11,12,13,14,15],
  US_HOURS: [16,17,18,19,20,21,22,23],
  BREAKOUT_THRESHOLD: 0.7,
  DIP_THRESHOLD: 0.3,
  BTC_CALM_THRESHOLD: 1.0,
  HIGH_CONFIDENCE_THRESHOLD: 65,
};

// ========= SCORING (momentum-v6) =========

export interface MarketState {
  symbol: string;
  price: number;
  pricePosition: number | null;
  priceChange1h: number | null;
  priceChange4h: number | null;
  rsi14: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  ema9: number | null;
  ema21: number | null;
  atrPercent: number | null;
  btcChange1h: number | null;
  btcChange4h: number | null;
  btcIsCalm: boolean;
  btcRsi14: number | null;
  btcPrice: number | null;
  btcEma50: number | null;
  btcEma200: number | null;
  btcMacdHist: number | null;
  btcChange7d: number | null;
  fundingRate: number | null;
  // Hour override for deterministic backtest (otherwise uses new Date())
  hourUtc: number;
}

/**
 * v7 scoring — uses technical indicators from v6 for SCORE (trigger strength),
 * but replaces the buggy EMA macro regime block with a sentiment-based rule table.
 *
 * Direction decision priority:
 *   1. Consensus both-long sentiment → LONG (high-confidence, override indicators)
 *   2. Sentiment rule table → sets baseline direction bias
 *   3. Indicator-derived direction counters → fine-tune within bias
 *   4. Contradiction penalty: if sentiment says direction X but indicators say Y, cut score
 *
 * This addresses the v6 finding that:
 *   - EMA bull regime strongly predicts target SHORTS (not longs as v6 assumed)
 *   - EMA bear regime strongly predicts target LONGS (not shorts as v6 assumed)
 *   - Sentiment wallets provide direct access to target-aligned direction
 */
export interface SentimentSignal {
  archangel: 'long' | 'short' | 'flat';
  bitcoinMa: 'long' | 'short' | 'flat';
  /** 'bull' | 'bear' | 'neutral' from our EMA-based regime detector */
  emaRegime: 'bull' | 'bear' | 'neutral';
  /** Rule-table output: long_strong | long | short | null */
  ruleDirection: 'long_strong' | 'long' | 'short' | null;
}

export function scorePredictionV7(
  symbol: string,
  s: MarketState,
  sent: SentimentSignal
): ScoringResult {
  let score = 50;
  const reasons: string[] = [];
  let longSignals = 0;
  let shortSignals = 0;
  const hour = s.hourUtc;

  // === 1. MACD ===
  if (s.macdHist != null) {
    if (s.macdHist > 0) { score += 8; reasons.push('macd_bullish'); longSignals += 2; }
    else if (s.macdHist < 0) { score += 5; reasons.push('macd_bearish'); shortSignals += 2; }
  }

  // === 2. RSI ===
  if (s.rsi14 != null) {
    if (s.rsi14 > 70) { score += 8; reasons.push('rsi_breakout'); longSignals += 2; }
    else if (s.rsi14 < 30) { score += 8; reasons.push('rsi_oversold'); longSignals += 2; }
    else if (s.rsi14 >= 40 && s.rsi14 <= 55) { reasons.push('rsi_mid_range'); }
  }

  // === 3. Bollinger Bands ===
  if (s.bbUpper != null && s.bbLower != null && s.price) {
    const bbRange = s.bbUpper - s.bbLower;
    if (bbRange > 0) {
      const bbPosition = (s.price - s.bbLower) / bbRange;
      if (bbPosition > 1.0) { score += 10; reasons.push('bb_breakout_above'); longSignals += 2; }
      else if (bbPosition < 0.1) { score += 10; reasons.push('bb_lower_touch'); longSignals += 2; }
      else if (bbPosition >= 0.2 && bbPosition <= 0.4) { reasons.push('bb_short_zone'); shortSignals++; }
    }
    if (s.bbWidth != null && s.bbWidth < 0.02) { score += 5; reasons.push('bb_squeeze'); }
  }

  // === 4. EMA crossover ===
  if (s.ema9 != null && s.ema21 != null) {
    if (s.ema9 > s.ema21) { score += 3; reasons.push('ema_bullish'); longSignals++; }
    else { reasons.push('ema_bearish'); shortSignals++; }
  }

  // === 5. Momentum ===
  if (s.priceChange1h != null) {
    if (s.priceChange1h < -0.5) { score += 8; reasons.push('dip_entry'); longSignals++; }
    else if (s.priceChange1h > 1.0) { score -= 3; reasons.push('chasing_momentum'); }
  }
  if (s.priceChange4h != null) {
    if (s.priceChange4h > 1) { score += 5; reasons.push('trend_up_4h'); longSignals++; }
    else if (s.priceChange4h < -1) { score += 5; reasons.push('trend_down_4h'); shortSignals++; }
  }

  // === 6. Price-range position ===
  if (s.pricePosition != null) {
    if (s.pricePosition > STRATEGY.BREAKOUT_THRESHOLD) { score += 10; reasons.push('breakout'); longSignals++; }
    else if (s.pricePosition < STRATEGY.DIP_THRESHOLD) { score += 5; reasons.push('dip'); longSignals++; }
  }

  // === 7. SENTIMENT RULE TABLE (replaces v6 macro regime block) ===
  // Rule table (from Jan-Mar correlation analysis):
  //   Both long        → 'long_strong' (98% target longs, near-oracle)
  //   Neutral + long   → 'long' (96% target longs)
  //   Bear + short     → 'long' (71% target longs — contrarian)
  //   Bull + any       → 'short' (target shorts in bull)
  //   Neutral + short  → 'short' (64% target shorts)
  switch (sent.ruleDirection) {
    case 'long_strong':
      score += 20;
      longSignals += 4;
      reasons.push('sentiment_consensus_long');
      break;
    case 'long':
      score += 10;
      longSignals += 2;
      reasons.push('sentiment_long_' + sent.emaRegime);
      break;
    case 'short':
      score += 10;
      shortSignals += 2;
      reasons.push('sentiment_short_' + sent.emaRegime);
      break;
    case null:
      score -= 2;
      reasons.push('sentiment_unclear');
      break;
  }

  // BTC short-term momentum (secondary signal, kept from v6)
  if (s.btcChange1h != null) {
    if (s.btcChange1h > 0.3) { longSignals++; reasons.push('btc_1h_up'); }
    else if (s.btcChange1h < -0.3) { shortSignals++; reasons.push('btc_1h_down'); }
  }

  // === 8. Session ===
  if (STRATEGY.US_HOURS.includes(hour)) { score += 10; reasons.push('us_session'); }
  else if (STRATEGY.EUROPE_HOURS.includes(hour)) { score += 6; reasons.push('europe_session'); }
  else if (STRATEGY.ASIA_HOURS.includes(hour)) { score -= 3; reasons.push('asia_session'); }

  // === 9. Symbol role ===
  if (STRATEGY.ALWAYS_LONG_SYMBOLS.includes(symbol)) { score += 5; reasons.push('always_long_symbol'); longSignals++; }
  else if (STRATEGY.MOSTLY_SHORT_SYMBOLS.includes(symbol)) { reasons.push('mostly_short_symbol'); shortSignals++; }
  else if (STRATEGY.TOP_SYMBOLS.includes(symbol)) { score += 5; reasons.push('top_symbol'); }
  else if (STRATEGY.SECONDARY_SYMBOLS.includes(symbol)) { score += 3; reasons.push('secondary_symbol'); }

  // === 10. Volatility ===
  if (s.atrPercent != null && s.atrPercent > 5) { score += 3; reasons.push('high_volatility'); }

  // === 11. Funding ===
  if (s.fundingRate != null) {
    if (s.fundingRate > 0.02) { reasons.push('high_funding_long_bias'); longSignals++; }
    else if (s.fundingRate < -0.01) { reasons.push('neg_funding_short_bias'); shortSignals++; }
  }

  // === DIRECTION DETERMINATION ===
  let direction: number | null = null;

  // If consensus signal fired, force LONG direction regardless of other signals (near-oracle)
  if (sent.ruleDirection === 'long_strong') {
    direction = 1;
  } else if (longSignals > shortSignals) {
    direction = 1;
  } else if (shortSignals > longSignals) {
    direction = -1;
    if (shortSignals >= 3 && s.macdHist != null && s.macdHist < 0) {
      score += 8;
      reasons.push('confirmed_short');
    }
  } else if (longSignals > 0) {
    // Tie → sentiment rule breaks it
    if (sent.ruleDirection === 'long' || sent.ruleDirection === 'long_strong') direction = 1;
    else if (sent.ruleDirection === 'short') direction = -1;
    else direction = 1;
  }

  // Contradiction penalty: if chosen direction opposes sentiment rule
  if (sent.ruleDirection && direction !== null) {
    const ruleIsLong = sent.ruleDirection === 'long_strong' || sent.ruleDirection === 'long';
    const ruleIsShort = sent.ruleDirection === 'short';
    if (direction === 1 && ruleIsShort) {
      score -= 15;
      reasons.push('sentiment_contradicts_long');
    } else if (direction === -1 && ruleIsLong) {
      score -= 15;
      reasons.push('sentiment_contradicts_short');
    }
  }

  return { score, direction, reasons };
}

/**
 * v6 scoring — kept for comparison.
 */
export function scorePrediction(symbol: string, s: MarketState): ScoringResult {
  let score = 50;
  const reasons: string[] = [];
  let longSignals = 0;
  let shortSignals = 0;
  const hour = s.hourUtc;

  // 1. MACD
  if (s.macdHist != null) {
    if (s.macdHist > 0) { score += 8; reasons.push('macd_bullish'); longSignals += 2; }
    else if (s.macdHist < 0) { score += 5; reasons.push('macd_bearish'); shortSignals += 2; }
  }

  // 2. RSI
  if (s.rsi14 != null) {
    if (s.rsi14 > 70) { score += 8; reasons.push('rsi_breakout'); longSignals += 2; }
    else if (s.rsi14 < 30) { score += 8; reasons.push('rsi_oversold'); longSignals += 2; }
    else if (s.rsi14 >= 40 && s.rsi14 <= 55) { reasons.push('rsi_mid_range'); }
  }

  // 3. BB
  if (s.bbUpper != null && s.bbLower != null && s.price) {
    const bbRange = s.bbUpper - s.bbLower;
    if (bbRange > 0) {
      const bbPosition = (s.price - s.bbLower) / bbRange;
      if (bbPosition > 1.0) { score += 10; reasons.push('bb_breakout_above'); longSignals += 2; }
      else if (bbPosition < 0.1) { score += 10; reasons.push('bb_lower_touch'); longSignals += 2; }
      else if (bbPosition >= 0.2 && bbPosition <= 0.4) { reasons.push('bb_short_zone'); shortSignals++; }
    }
    if (s.bbWidth != null && s.bbWidth < 0.02) { score += 5; reasons.push('bb_squeeze'); }
  }

  // 4. EMA
  if (s.ema9 != null && s.ema21 != null) {
    if (s.ema9 > s.ema21) { score += 3; reasons.push('ema_bullish'); longSignals++; }
    else { reasons.push('ema_bearish'); shortSignals++; }
  }

  // 5. Momentum
  if (s.priceChange1h != null) {
    if (s.priceChange1h < -0.5) { score += 8; reasons.push('dip_entry'); longSignals++; }
    else if (s.priceChange1h > 1.0) { score -= 3; reasons.push('chasing_momentum'); }
  }
  if (s.priceChange4h != null) {
    if (s.priceChange4h > 1) { score += 5; reasons.push('trend_up_4h'); longSignals++; }
    else if (s.priceChange4h < -1) { score += 5; reasons.push('trend_down_4h'); shortSignals++; }
  }

  // 6. Breakout from price range
  if (s.pricePosition != null) {
    if (s.pricePosition > STRATEGY.BREAKOUT_THRESHOLD) { score += 10; reasons.push('breakout'); longSignals++; }
    else if (s.pricePosition < STRATEGY.DIP_THRESHOLD) { score += 5; reasons.push('dip'); longSignals++; }
  }

  // 7. BTC macro regime
  let macroRegime: 'bull' | 'bear' | 'neutral' = 'neutral';
  let regimeSignals = 0;
  if (s.btcPrice && s.btcEma50) {
    if (s.btcPrice < s.btcEma50) { regimeSignals--; reasons.push('btc_below_ema50'); } else { regimeSignals++; }
  }
  if (s.btcPrice && s.btcEma200) {
    if (s.btcPrice < s.btcEma200) { regimeSignals--; reasons.push('btc_below_ema200'); } else { regimeSignals++; }
  }
  if (s.btcMacdHist != null) {
    if (s.btcMacdHist < 0) { regimeSignals--; reasons.push('btc_macd_bearish'); } else { regimeSignals++; }
  }
  if (s.btcChange7d != null) {
    if (s.btcChange7d < -5) { regimeSignals -= 2; reasons.push('btc_weekly_dump'); }
    else if (s.btcChange7d > 5) { regimeSignals += 2; reasons.push('btc_weekly_pump'); }
  }
  if (s.btcRsi14 != null) {
    if (s.btcRsi14 < 30) { reasons.push('btc_oversold'); regimeSignals++; }
    else if (s.btcRsi14 > 70) { reasons.push('btc_overbought'); }
  }
  if (regimeSignals <= -2) {
    macroRegime = 'bear'; score += 10; shortSignals += 2; reasons.push('macro_bear_regime');
  } else if (regimeSignals >= 2) {
    macroRegime = 'bull'; score += 10; longSignals += 2; reasons.push('macro_bull_regime');
  } else {
    score -= 5; reasons.push('macro_neutral_regime');
  }

  if (s.btcChange1h != null) {
    if (s.btcChange1h > 0.3) { longSignals++; reasons.push('btc_1h_up'); }
    else if (s.btcChange1h < -0.3) { shortSignals++; reasons.push('btc_1h_down'); }
  }

  // 8. Session
  if (STRATEGY.US_HOURS.includes(hour)) { score += 10; reasons.push('us_session'); }
  else if (STRATEGY.EUROPE_HOURS.includes(hour)) { score += 6; reasons.push('europe_session'); }
  else if (STRATEGY.ASIA_HOURS.includes(hour)) { score -= 3; reasons.push('asia_session'); }

  // 9. Symbol role
  if (STRATEGY.ALWAYS_LONG_SYMBOLS.includes(symbol)) { score += 5; reasons.push('always_long_symbol'); longSignals++; }
  else if (STRATEGY.MOSTLY_SHORT_SYMBOLS.includes(symbol)) { reasons.push('mostly_short_symbol'); shortSignals++; }
  else if (STRATEGY.TOP_SYMBOLS.includes(symbol)) { score += 5; reasons.push('top_symbol'); }
  else if (STRATEGY.SECONDARY_SYMBOLS.includes(symbol)) { score += 3; reasons.push('secondary_symbol'); }

  // 10. Volatility
  if (s.atrPercent != null && s.atrPercent > 5) { score += 3; reasons.push('high_volatility'); }

  // 11. Funding
  if (s.fundingRate != null) {
    if (s.fundingRate > 0.02) { reasons.push('high_funding_long_bias'); longSignals++; }
    else if (s.fundingRate < -0.01) { reasons.push('neg_funding_short_bias'); shortSignals++; }
  }

  // Direction
  let direction: number | null = null;
  if (longSignals > shortSignals) direction = 1;
  else if (shortSignals > longSignals) {
    direction = -1;
    if (shortSignals >= 3 && s.macdHist != null && s.macdHist < 0) { score += 8; reasons.push('confirmed_short'); }
  } else if (longSignals > 0) {
    if (macroRegime === 'bear') { direction = -1; reasons.push('tie_bear_short'); }
    else direction = 1;
  }

  return { score, direction, reasons };
}

// ========= EXIT LOGIC (IndependentTrader v5.1) =========

export interface ExitConfig {
  bbUpperExit: number;        // default 0.8 — LONG exit
  bbMeanLow: number;          // default 0.4 — SHORT exit
  bbMeanHigh: number;         // default 0.6
  rsiHighExit: number;        // default 70 — LONG exit
  useBbUpperExit: boolean;    // feature flag
  useRsiHighExit: boolean;    // feature flag
  useEmaTpExit: boolean;      // feature flag
  useBbMeanExit: boolean;     // feature flag (shorts)
  hardStopPct: number;        // default 0.10
  maxHoldHours: number;       // default 72
  skipBbExitOnBreakout: boolean; // v5.1 fix
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  bbUpperExit: 0.8,
  bbMeanLow: 0.4,
  bbMeanHigh: 0.6,
  rsiHighExit: 70,
  useBbUpperExit: true,
  useRsiHighExit: true,
  useEmaTpExit: true,
  useBbMeanExit: true,
  hardStopPct: 0.10,
  maxHoldHours: 72,
  skipBbExitOnBreakout: true,
};

export interface IndicatorsAtTime {
  rsi14: number | null;
  bbPosition: number | null;
  ema9: number | null;
  ema21: number | null;
}

export function checkIndicatorExit(
  side: 'long' | 'short',
  price: number,
  ind: IndicatorsAtTime,
  pnlFromEntry: number,
  enteredOnBbBreakout: boolean,
  cfg: ExitConfig
): string | null {
  const { rsi14, bbPosition, ema9, ema21 } = ind;

  if (side === 'long') {
    if (cfg.useBbUpperExit && bbPosition != null && bbPosition > cfg.bbUpperExit &&
        !(cfg.skipBbExitOnBreakout && enteredOnBbBreakout)) {
      return 'indicator_bb_upper';
    }
    if (cfg.useRsiHighExit && rsi14 != null && rsi14 > cfg.rsiHighExit) {
      return 'indicator_rsi_high';
    }
    if (cfg.useEmaTpExit && ema9 != null && ema21 != null && price < ema9 && price < ema21 && pnlFromEntry >= 0) {
      return 'indicator_ema_tp';
    }
  } else {
    if (cfg.useBbMeanExit && bbPosition != null && bbPosition >= cfg.bbMeanLow && bbPosition <= cfg.bbMeanHigh && pnlFromEntry >= 0) {
      return 'indicator_bb_mean';
    }
    if (cfg.useEmaTpExit && ema9 != null && ema21 != null && price < ema9 && price < ema21 && pnlFromEntry >= 0) {
      return 'indicator_ema_tp';
    }
  }
  return null;
}

// ========= HELPERS =========

export function calculatePricePosition(recentCandles: CandleRow[]): number | null {
  // recentCandles: last 10 candles, most recent LAST
  if (recentCandles.length < 10) return null;
  const slice = recentCandles.slice(-10);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;
  if (range === 0) return 0.5;
  const currentPrice = slice[slice.length - 1].close;
  return (currentPrice - rangeLow) / range;
}

export function bbPositionFromCandle(c: CandleRow): number | null {
  if (c.bbUpper == null || c.bbLower == null) return null;
  const range = c.bbUpper - c.bbLower;
  if (range === 0) return null;
  return (c.close - c.bbLower) / range;
}
