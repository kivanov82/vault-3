/**
 * Backtest engine — walks 1h candles, emits entries, simulates exits.
 *
 * Data flow:
 *   1. Load all CandleRow data for (symbols + BTC) in window (with lookback) into memory.
 *   2. For each 1h tick in window:
 *        - Build BTC context from BTC candles.
 *        - For each tracked symbol:
 *            a. Manage any open position (apply exit rules).
 *            b. If no open position, build MarketState and score.
 *            c. If score passes threshold, open simulated position.
 *   3. At window end, close any open positions as 'window_end'.
 *   4. Persist all trades + aggregated stats.
 */

import { PrismaClient } from '@prisma/client';
import {
  CandleRow,
  BtcContext,
  MarketState,
  ExitConfig,
  DEFAULT_EXIT_CONFIG,
  ScoringResult,
  SentimentSignal,
  scorePrediction,
  scorePredictionV7,
  calculatePricePosition,
  checkIndicatorExit,
  bbPositionFromCandle,
} from './strategy';
import { SentimentPanel, sentimentRuleDirection } from './sentiment';

// =============================================================================

export interface EntryConfig {
  minScoreLong: number;         // default 90
  minScoreShort: number;        // default 95
  maxScoreCap?: number;         // optional: reject entries above this score
  allowLongs: boolean;
  allowShorts: boolean;
}

export const DEFAULT_ENTRY_CONFIG: EntryConfig = {
  minScoreLong: 90,
  minScoreShort: 90, // symmetric — matches current live config after 2026-04-10 change
  allowLongs: true,
  allowShorts: true,
};

export interface BacktestConfig {
  symbols: string[];
  windowStart: Date;
  windowEnd: Date;
  leverage: number;              // for Pnl USD calc
  notionalUsdPerTrade: number;   // fixed notional per entry
  entry: EntryConfig;
  exit: ExitConfig;
  /**
   * Scoring mode:
   *   'v6'       — current live scoring (linear indicators + EMA macro regime)
   *   'v7'       — v7 with sentiment rule table replacing macro regime
   *   'v6_veto'  — v6 scoring but reject entries that contradict sentiment rule
   *   'v6_threshold' — v6 scoring, score threshold adjusted by sentiment agreement
   */
  scorer?: 'v6' | 'v7' | 'v6_veto' | 'v6_threshold';
  /** Pre-built sentiment panel. Required if scorer uses sentiment. */
  sentimentPanel?: SentimentPanel;
  /**
   * Sentiment threshold magnitudes. Default: agree +5, disagree -5.
   * Larger values = stronger sentiment influence on effective score.
   */
  sentimentAgreeBoost?: number;
  sentimentDisagreePenalty?: number;
}

export interface SimulatedTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: Date;
  entryPrice: number;
  exitTime: Date;
  exitPrice: number;
  exitReason: string;
  holdHours: number;
  realizedPnl: number;           // USD (leverage-adjusted)
  realizedPnlPct: number;        // price move % (not leverage)
  predictionScore: number;
  predictionReasons: string[];
  entryRsi14: number | null;
  entryBbPos: number | null;
  entryMacdHist: number | null;
  entryEma9: number | null;
  entryEma21: number | null;
}

interface OpenPosition {
  symbol: string;
  side: 'long' | 'short';
  entryTime: Date;
  entryPrice: number;
  entryRsi14: number | null;
  entryBbPos: number | null;
  entryMacdHist: number | null;
  entryEma9: number | null;
  entryEma21: number | null;
  score: number;
  reasons: string[];
  enteredOnBbBreakout: boolean;
}

// =============================================================================

export async function loadCandleData(
  prisma: PrismaClient,
  symbols: string[],
  windowStart: Date,
  windowEnd: Date
): Promise<Map<string, CandleRow[]>> {
  // Fetch with lookback for priceChange4h/pricePosition computation
  const lookbackStart = new Date(windowStart.getTime() - 24 * 60 * 60 * 1000);

  const data = new Map<string, CandleRow[]>();
  for (const sym of symbols) {
    const rows = await prisma.candle.findMany({
      where: {
        symbol: sym,
        timeframe: '1h',
        timestamp: { gte: lookbackStart, lte: windowEnd },
      },
      orderBy: { timestamp: 'asc' },
    });
    // Attach ema9/21/50/200, bbWidth from TechnicalIndicator table (Candle columns lack these)
    const inds = await prisma.technicalIndicator.findMany({
      where: {
        symbol: sym,
        timeframe: '1h',
        timestamp: { gte: lookbackStart, lte: windowEnd },
      },
    });
    const indMap = new Map(inds.map((i) => [i.timestamp.getTime(), i]));
    const enriched: CandleRow[] = rows.map((r) => {
      const ind = indMap.get(r.timestamp.getTime());
      return {
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        rsi14: ind?.rsi14 ?? r.rsi14 ?? null,
        macd: ind?.macd ?? r.macd ?? null,
        macdSignal: ind?.macdSignal ?? r.macdSignal ?? null,
        macdHist: ind?.macdHist ?? r.macdHist ?? null,
        bbUpper: ind?.bbUpper ?? r.bbUpper ?? null,
        bbMiddle: ind?.bbMiddle ?? r.bbMiddle ?? null,
        bbLower: ind?.bbLower ?? r.bbLower ?? null,
        bbWidth: ind?.bbWidth ?? null,
        ema9: ind?.ema9 ?? null,
        ema21: ind?.ema21 ?? null,
        ema50: ind?.ema50 ?? null,
        ema200: ind?.ema200 ?? null,
        atr14: ind?.atr14 ?? r.atr14 ?? null,
      };
    });
    data.set(sym, enriched);
  }
  return data;
}

// =============================================================================

function buildBtcContext(btcCandles: CandleRow[], idx: number): BtcContext {
  const cur = btcCandles[idx];
  const prev1 = idx - 1 >= 0 ? btcCandles[idx - 1] : null;
  const prev4 = idx - 4 >= 0 ? btcCandles[idx - 4] : null;
  const prev168 = idx - 167 >= 0 ? btcCandles[idx - 167] : null;

  const change1h = prev1 ? ((cur.close - prev1.close) / prev1.close) * 100 : null;
  const change4h = prev4 ? ((cur.close - prev4.close) / prev4.close) * 100 : null;
  const change7d = prev168 ? ((cur.close - prev168.close) / prev168.close) * 100 : null;
  const isCalm = change1h != null && Math.abs(change1h) < 1.0;

  return {
    price: cur.close,
    rsi14: cur.rsi14,
    macdHist: cur.macdHist,
    ema50: cur.ema50,
    ema200: cur.ema200,
    change1h,
    change4h,
    change7d,
    isCalm,
  };
}

function buildMarketState(
  symbol: string,
  symCandles: CandleRow[],
  idx: number,
  btc: BtcContext
): MarketState | null {
  if (idx < 10) return null;
  const cur = symCandles[idx];
  if (cur.rsi14 == null && cur.ema9 == null) return null; // no indicators yet

  const prev1 = symCandles[idx - 1];
  const prev4 = idx - 4 >= 0 ? symCandles[idx - 4] : null;

  const priceChange1h = prev1 ? ((cur.close - prev1.close) / prev1.close) * 100 : null;
  const priceChange4h = prev4 ? ((cur.close - prev4.close) / prev4.close) * 100 : null;

  const pricePosition = calculatePricePosition(symCandles.slice(idx - 9, idx + 1));
  const atrPercent = cur.atr14 ? (cur.atr14 / cur.close) * 100 : null;

  return {
    symbol,
    price: cur.close,
    pricePosition,
    priceChange1h,
    priceChange4h,
    rsi14: cur.rsi14,
    macdHist: cur.macdHist,
    bbUpper: cur.bbUpper,
    bbLower: cur.bbLower,
    bbWidth: cur.bbWidth,
    ema9: cur.ema9,
    ema21: cur.ema21,
    atrPercent,
    btcChange1h: btc.change1h,
    btcChange4h: btc.change4h,
    btcIsCalm: btc.isCalm,
    btcRsi14: btc.rsi14,
    btcPrice: btc.price,
    btcEma50: btc.ema50,
    btcEma200: btc.ema200,
    btcMacdHist: btc.macdHist,
    btcChange7d: btc.change7d,
    fundingRate: null, // not used in backtest (historical funding not loaded)
    hourUtc: cur.timestamp.getUTCHours(),
  };
}

// =============================================================================

export async function runBacktest(
  prisma: PrismaClient,
  cfg: BacktestConfig
): Promise<SimulatedTrade[]> {
  // 1. Load data
  const symbolsToLoad = cfg.symbols.includes('BTC') ? cfg.symbols : [...cfg.symbols, 'BTC'];
  const data = await loadCandleData(prisma, symbolsToLoad, cfg.windowStart, cfg.windowEnd);
  const btcCandles = data.get('BTC') ?? [];
  if (btcCandles.length === 0) throw new Error('No BTC candle data');

  // Build a unified time index — use BTC candles as the master clock
  // (all symbols should have aligned 1h timestamps)
  const trades: SimulatedTrade[] = [];
  const openPositions = new Map<string, OpenPosition>();

  // 2. Walk each hour
  for (let i = 0; i < btcCandles.length; i++) {
    const btcCandle = btcCandles[i];
    if (btcCandle.timestamp < cfg.windowStart) continue;
    if (btcCandle.timestamp > cfg.windowEnd) break;

    const btcCtx = buildBtcContext(btcCandles, i);

    for (const sym of cfg.symbols) {
      const symCandles = data.get(sym);
      if (!symCandles) continue;

      // Find index in this symbol's array matching the BTC timestamp
      // (Binary search would be faster, but linear is fine for 1753 candles)
      const symIdx = symCandles.findIndex((c) => c.timestamp.getTime() === btcCandle.timestamp.getTime());
      if (symIdx === -1) continue;
      const cur = symCandles[symIdx];

      // === Manage open position ===
      const open = openPositions.get(sym);
      if (open) {
        const pnlFromEntry = open.side === 'long'
          ? (cur.close - open.entryPrice) / open.entryPrice
          : (open.entryPrice - cur.close) / open.entryPrice;
        const holdHours = (cur.timestamp.getTime() - open.entryTime.getTime()) / (60 * 60 * 1000);

        // Hard stop (check on intra-candle low/high)
        // Use close for simplicity — matches 1h-tick discretization
        if (pnlFromEntry <= -cfg.exit.hardStopPct) {
          closePosition(trades, open, cur, 'hard_stop', cfg.leverage, cfg.notionalUsdPerTrade);
          openPositions.delete(sym);
          continue;
        }

        // Timeout
        if (holdHours >= cfg.exit.maxHoldHours) {
          closePosition(trades, open, cur, 'timeout', cfg.leverage, cfg.notionalUsdPerTrade);
          openPositions.delete(sym);
          continue;
        }

        // Indicator exits (skip first 10 min — irrelevant at 1h granularity,
        // but we let one candle pass before firing exits to mirror live cadence)
        if (holdHours >= 1) {
          const bbPos = bbPositionFromCandle(cur);
          const exitSig = checkIndicatorExit(
            open.side,
            cur.close,
            {
              rsi14: cur.rsi14,
              bbPosition: bbPos,
              ema9: cur.ema9,
              ema21: cur.ema21,
            },
            pnlFromEntry,
            open.enteredOnBbBreakout,
            cfg.exit
          );
          if (exitSig) {
            closePosition(trades, open, cur, exitSig, cfg.leverage, cfg.notionalUsdPerTrade);
            openPositions.delete(sym);
            continue;
          }
        }
        continue; // still holding, don't try to re-enter
      }

      // === Entry scoring ===
      const state = buildMarketState(sym, symCandles, symIdx, btcCtx);
      if (!state) continue;

      // --- Compute sentiment signal once (used by all sentiment-aware scorers) ---
      const needsSentiment = cfg.scorer === 'v7' || cfg.scorer === 'v6_veto' || cfg.scorer === 'v6_threshold';
      let sentimentSignal: SentimentSignal | null = null;
      if (needsSentiment) {
        if (!cfg.sentimentPanel) throw new Error(`Scorer ${cfg.scorer} requires sentimentPanel in config`);
        const btcBull = (btcCtx.price != null && btcCtx.ema50 != null && btcCtx.price > btcCtx.ema50 ? 1 : -1)
                      + (btcCtx.price != null && btcCtx.ema200 != null && btcCtx.price > btcCtx.ema200 ? 1 : -1)
                      + (btcCtx.macdHist != null && btcCtx.macdHist > 0 ? 1 : -1);
        const emaRegime: 'bull' | 'bear' | 'neutral' =
          btcBull >= 2 ? 'bull' : btcBull <= -2 ? 'bear' : 'neutral';
        const hr = Math.floor(cur.timestamp.getTime() / 3600000) * 3600000;
        const archangel = cfg.sentimentPanel.archangel.get(hr)?.btcDirection ?? 'flat';
        const bitcoinMa = cfg.sentimentPanel.bitcoinMa.get(hr)?.btcDirection ?? 'flat';
        const ruleDirection = sentimentRuleDirection(emaRegime, archangel, bitcoinMa);
        sentimentSignal = { archangel, bitcoinMa, emaRegime, ruleDirection };
      }

      // --- Score using selected scorer ---
      let scoreResult: ScoringResult;
      if (cfg.scorer === 'v7') {
        scoreResult = scorePredictionV7(sym, state, sentimentSignal!);
      } else {
        scoreResult = scorePrediction(sym, state);
      }
      let { score, direction, reasons } = scoreResult;

      // --- Apply sentiment overlays ---
      if (cfg.scorer === 'v6_veto' && sentimentSignal && direction !== null) {
        // Reject entry if v6 direction contradicts sentiment rule
        const ruleLong = sentimentSignal.ruleDirection === 'long' || sentimentSignal.ruleDirection === 'long_strong';
        const ruleShort = sentimentSignal.ruleDirection === 'short';
        if (direction === 1 && ruleShort) {
          reasons = [...reasons, 'vetoed_by_sentiment_short'];
          continue; // skip this entry
        }
        if (direction === -1 && ruleLong) {
          reasons = [...reasons, 'vetoed_by_sentiment_long'];
          continue; // skip this entry
        }
      }

      if (cfg.scorer === 'v6_threshold' && sentimentSignal && direction !== null) {
        const agreeBoost = cfg.sentimentAgreeBoost ?? 5;
        const disagreePenalty = cfg.sentimentDisagreePenalty ?? 5;
        const ruleLong = sentimentSignal.ruleDirection === 'long' || sentimentSignal.ruleDirection === 'long_strong';
        const ruleShort = sentimentSignal.ruleDirection === 'short';
        const agrees = (direction === 1 && ruleLong) || (direction === -1 && ruleShort);
        const disagrees = (direction === 1 && ruleShort) || (direction === -1 && ruleLong);
        if (agrees) { score += agreeBoost; reasons = [...reasons, `sentiment_agrees_+${agreeBoost}`]; }
        else if (disagrees) { score -= disagreePenalty; reasons = [...reasons, `sentiment_disagrees_-${disagreePenalty}`]; }
      }

      // Filter by score cap if set
      if (cfg.entry.maxScoreCap != null && score > cfg.entry.maxScoreCap) continue;

      // Apply direction/threshold gating
      let shouldEnter = false;
      if (direction === 1 && cfg.entry.allowLongs && score >= cfg.entry.minScoreLong) shouldEnter = true;
      if (direction === -1 && cfg.entry.allowShorts && score >= cfg.entry.minScoreShort) shouldEnter = true;
      if (!shouldEnter) continue;

      // Pre-check: would an indicator exit fire immediately? Skip if so.
      const bbPos = bbPositionFromCandle(cur);
      const enteredOnBbBreakout = reasons.includes('bb_breakout_above');
      const immediateExit = checkIndicatorExit(
        direction === 1 ? 'long' : 'short',
        cur.close,
        { rsi14: cur.rsi14, bbPosition: bbPos, ema9: cur.ema9, ema21: cur.ema21 },
        0,
        enteredOnBbBreakout,
        cfg.exit
      );
      if (immediateExit) continue; // skip this entry, live system does the same

      // Open position
      openPositions.set(sym, {
        symbol: sym,
        side: direction === 1 ? 'long' : 'short',
        entryTime: cur.timestamp,
        entryPrice: cur.close,
        entryRsi14: cur.rsi14,
        entryBbPos: bbPos,
        entryMacdHist: cur.macdHist,
        entryEma9: cur.ema9,
        entryEma21: cur.ema21,
        score,
        reasons,
        enteredOnBbBreakout,
      });
    }
  }

  // 3. Close any remaining open positions as window_end
  const lastBtc = btcCandles[btcCandles.length - 1];
  for (const [sym, open] of openPositions) {
    const symCandles = data.get(sym);
    if (!symCandles) continue;
    const last = symCandles[symCandles.length - 1];
    closePosition(trades, open, last, 'window_end', cfg.leverage, cfg.notionalUsdPerTrade);
  }

  return trades;
}

function closePosition(
  trades: SimulatedTrade[],
  open: OpenPosition,
  exitCandle: CandleRow,
  reason: string,
  leverage: number,
  notionalUsd: number
) {
  const priceDiff = exitCandle.close - open.entryPrice;
  const pricePct = (priceDiff / open.entryPrice) * (open.side === 'long' ? 1 : -1);
  const realizedPnlPct = pricePct * 100;

  // Leverage-adjusted USD P&L based on fixed notional
  const size = notionalUsd / open.entryPrice;
  const realizedPnl = open.side === 'long' ? priceDiff * size : -priceDiff * size;

  const holdHours = (exitCandle.timestamp.getTime() - open.entryTime.getTime()) / (60 * 60 * 1000);

  trades.push({
    symbol: open.symbol,
    side: open.side,
    entryTime: open.entryTime,
    entryPrice: open.entryPrice,
    exitTime: exitCandle.timestamp,
    exitPrice: exitCandle.close,
    exitReason: reason,
    holdHours,
    realizedPnl,
    realizedPnlPct,
    predictionScore: open.score,
    predictionReasons: open.reasons,
    entryRsi14: open.entryRsi14,
    entryBbPos: open.entryBbPos,
    entryMacdHist: open.entryMacdHist,
    entryEma9: open.entryEma9,
    entryEma21: open.entryEma21,
  });
}

// =============================================================================

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalPnlPct: number;
  avgPnlPct: number;
  winRate: number;
  maxDrawdownPct: number;
}

export function computeStats(trades: SimulatedTrade[]): BacktestStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0,
      totalPnl: 0, totalPnlPct: 0, avgPnlPct: 0,
      winRate: 0, maxDrawdownPct: 0,
    };
  }

  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  const totalPnlPct = trades.reduce((s, t) => s + t.realizedPnlPct, 0);
  const avgPnlPct = totalPnlPct / trades.length;

  // Drawdown: running equity curve from sorted by exit time
  const sorted = [...trades].sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime());
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.realizedPnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    totalTrades: trades.length,
    wins,
    losses,
    totalPnl,
    totalPnlPct,
    avgPnlPct,
    winRate: (wins / trades.length) * 100,
    maxDrawdownPct: maxDd,
  };
}
