# Vault-3: Hyperliquid Copytrading Bot

**Project Status:** Phase 5 — Optimization & Scaling
**Last Updated:** 2026-04-10

A multi-target copytrading bot for Hyperliquid with an integrated autonomous trading module that runs alongside copy trading.

---

## Architecture at a glance

Every 5 minutes the bot:

1. Fetches our portfolio + market prices
2. Fetches each copy target's portfolio (sequentially, to avoid HL RPC rate limits)
3. Aggregates desired positions across targets (sums scaled sizes per symbol/direction)
4. Runs predictions for all symbols (`PredictionLogger`, `momentum-v6`)
5. Processes independent trading signals (`IndependentTrader`, if enabled)
6. Manages open independent positions (indicator-based exits)
7. Executes copy trades (copy trading always overrides independent on conflict)
8. Periodically validates past predictions against 4h forward price moves

Copy trading and independent trading share the same scan cycle, asset metadata cache, and prediction output.

---

## Live Configuration

**Deployment:** Google Cloud Run (`vault-3`) + Cloud SQL (PostgreSQL).

### Vault & wallets
- Our vault: `0xc94376c6e3e85dfbe22026d9fe39b000bcf649f0`
- Vault leader: `0x3Fc6E2D6c0E1D4072F876f74E03d191e2cC61922`

### Copy targets (multi-target — 2 currently live)
| Address | Type | Name | Strategy | Status |
|---|---|---|---|---|
| `0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768` | vault | Bitcoin MA Long/Short | BTC-only, MA crossovers, 20x | LIVE |
| `0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0` | vault | Archangel Quant Fund I | BTC+SOL macro, 20x | LIVE |
| `0xbd9c944dcfb31cd24c81ebf1c974d950f44e42b8` | personal wallet | "Not In Employment" leader's personal trading | Active multi-symbol discretionary (BTC, HYPE, ETH + others) | **DEFERRED** — see deploy postmortem below |

All addresses are queried uniformly via `clearinghouseState`/`getOpenPositions` — HL treats vaults and personal wallets the same way for these endpoints. The bd9c personal wallet also trades on HL's `xyz` builder-code DEX (oil, BRENTOIL) — those positions are not currently copied (we only query the main perps DEX).

### Portfolio split (conceptual budget; aggregation logic handles actual sizing)
- ~25% per copy target × 3 targets
- 25% independent trading
- buffer from aggregation dilution when targets disagree

Aggregation math: `ourMargin = netMarginPct × (ourPortfolio / numTargets) × COPY_SCALE_MULTIPLIER`. With 3 agreeing targets at 5% margin each, effective size is unchanged from 2 agreeing targets. When targets disagree, the net margin is reduced (diluted).

### Copy trading
- Mode: `scaled`, position-based
- Scale multiplier: **3.0** (targets use ~4–6% margin → we target ~12–18%)
- Leverage: exact 1:1 with target
- Slippage: 1% for market orders
- Scan interval: 5 minutes

### Independent trading (autonomous module)
| Setting | Value |
|---|---|
| Max allocation | 30% of vault |
| Max concurrent positions | 5 |
| Leverage | 5x |
| Max hold | 72h |
| Hard stop | **-10%** from entry (price move, not margin) |
| Min score (LONG) | 90 |
| Min score (SHORT) | 90 (symmetric with long) |
| Whitelist | HYPE, SOL, VVV, ETH, MON, FARTCOIN |
| Scoring model | `momentum-v6` |

### Live environment variables (Cloud Run)
Only these are set; everything else uses the code defaults shown above.
```
ENABLE_COPY_TRADING=true
ENABLE_INDEPENDENT_TRADING=true
ENABLE_FUNDING_COLLECTION=true
COPY_MODE=scaled
COPY_POLL_INTERVAL_MINUTES=5
COPY_SCALE_MULTIPLIER=3.0
COPY_TRADERS=0xb1505...,0x8c7b...
```
(bd9c temporarily removed after the 2026-04-10 deploy incident — will be re-added with simultaneous `COPY_SCALE_MULTIPLIER` adjustment to avoid the rollout race.)

---

## Independent Trading: Entry & Exit Logic

### Entry criteria (all must hold)
- Symbol on whitelist
- Prediction score ≥ 90 (same threshold for longs and shorts)
- No existing position (copy or independent) on that symbol
- Target has no position on that symbol (defer to copy trading if they do)
- Under max allocation and max-positions limits
- **Pre-check:** no indicator exit rule would fire immediately (prevents instant-close)

### Exit rules (checked every scan cycle)

| Priority | Rule | Applies to | Condition |
|---|---|---|---|
| 1 | Target confirmation | both | Target opens same direction → mark confirmed, copy trading takes over |
| 2 | Target opposite | both | Target opens opposite direction → close immediately |
| 3 | Hard stop | both | Price moved ≥ 10% against entry → close |
| 4 | Max hold | both | Position held ≥ 72h → close at market |
| 5 | BB upper | long | `bbPosition > 0.8` (skipped if entered on `bb_breakout_above`) |
| 6 | RSI high | long | `rsi14 > 70` |
| 7 | EMA take-profit | long | `price < ema9 && price < ema21` AND in profit |
| 5' | BB mean | short | `0.4 ≤ bbPosition ≤ 0.6` AND in profit |
| 6' | EMA take-profit | short | `price < ema9 && price < ema21` AND in profit |

Indicator exits (5–7) require at least 1 hour of holding so they don't contradict entry signals.

---

## Prediction Scoring: momentum-v6

Base score: **50**. High confidence threshold: **65**. Independent threshold: **90**.

Factors (from `PredictionLogger.ts`):

| Factor | Points | Direction signal | Trigger |
|---|---|---|---|
| MACD bullish | +8 | LONG ×2 | `macdHist > 0` |
| MACD bearish | +5 | SHORT ×2 | `macdHist < 0` |
| RSI breakout | +8 | LONG ×2 | `rsi14 > 70` |
| RSI oversold | +8 | LONG ×2 | `rsi14 < 30` |
| BB breakout above | +10 | LONG ×2 | Price above upper BB |
| BB lower touch | +10 | LONG ×2 | Price below lower BB |
| BB short zone | 0 | SHORT | `0.2 ≤ bbPosition ≤ 0.4` |
| BB squeeze | +5 | — | `bbWidth < 0.02` |
| EMA bullish | +3 | LONG | `ema9 > ema21` |
| Dip entry | +8 | LONG | `priceChange1h < -0.5%` |
| Chasing momentum | -3 | — | `priceChange1h > 1%` (penalty) |
| Trend up 4h | +5 | LONG | `priceChange4h > 1%` |
| Trend down 4h | +5 | SHORT | `priceChange4h < -1%` |
| Price breakout | +10 | LONG | Price position > 0.7 |
| Price dip | +5 | LONG | Price position < 0.3 |
| Macro bull | +10 | LONG ×2 | BTC regime bullish |
| Macro bear | +10 | SHORT ×2 | BTC regime bearish |
| Macro neutral | -5 | — | Neutral regime (worst for P&L) |
| BTC 1h up | 0 | LONG | `btcChange1h > 0.3%` |
| BTC 1h down | 0 | SHORT | `btcChange1h < -0.3%` |
| US session | +10 | — | hours 16–23 UTC |
| Europe session | +6 | — | hours 8–15 UTC |
| Asia session | -3 | — | hours 0–7 UTC |
| Always-long symbol | +5 | LONG | symbol in `ALWAYS_LONG_SYMBOLS` |
| Top symbol | +5 | — | symbol in `TOP_SYMBOLS` |
| Secondary symbol | +3 | — | symbol in `SECONDARY_SYMBOLS` |
| High volatility | +3 | — | `atrPercent > 5` |
| Positive funding | 0 | LONG | `fundingRate > 0.02` |
| Negative funding | 0 | SHORT | `fundingRate < -0.01` |
| Confirmed short | +8 | SHORT | 3+ short signals + bearish MACD |

### BTC macro regime detection

Target traders shift entire portfolios based on BTC macro trend, not short-term moves.

| Signal | Bearish | Bullish |
|---|---|---|
| BTC vs EMA50 | Below (-1) | Above (+1) |
| BTC vs EMA200 | Below (-1) | Above (+1) |
| BTC MACD histogram | Negative (-1) | Positive (+1) |
| BTC 7d change | < -5% (-2) | > +5% (+2) |
| BTC RSI | < 30 (+1 bounce) | > 70 (noted) |

- Regime signal ≤ -2 → **bear**: +10 score, +2 short signals, tie-breaker flips long→short
- Regime signal ≥ +2 → **bull**: +10 score, +2 long signals
- Otherwise → **neutral**: -5 score (neutral regimes have historically lost money)

---

## Database Schema

### Core tables
| Table | Description |
|---|---|
| `Fill` | Raw fills from Hyperliquid (for TWAP detection) |
| `Trade` | Aggregated logical trades (our trades + target trades) |
| `Candle` | OHLCV data with basic indicators (rsi14, macd, bb, atr) |
| `TechnicalIndicator` | Full indicator set (adds ema9/21/50/200, bbWidth) |
| `FundingRate` | 8-hour funding epochs |
| `Prediction` | Shadow mode predictions with paper P&L validation |
| `IndependentPosition` | Live autonomous trading positions |
| `BacktestRun` / `BacktestTrade` | Backtest simulation runs |

### IndependentPosition key fields
`symbol`, `side`, `entryPrice`, `size`, `sizeUsd`, `leverage`, `timeoutAt`, `status` (open/confirmed/closed), `confirmedByTarget`, `exitPrice`, `exitReason`, `closedAt`, `realizedPnl`, `realizedPnlPct`, `predictionScore`, `predictionReasons`.

---

## Code Structure

```
src/
├── index.ts                            # Express server
├── service/
│   ├── Vault3.ts                       # Orchestrator
│   ├── trade/
│   │   ├── CopyTradingManager.ts       # Multi-target position syncing + prediction integration
│   │   ├── IndependentTrader.ts        # Autonomous trading (entry + exit + conflict resolution)
│   │   └── HyperliquidConnector.ts     # Hyperliquid API client
│   ├── data/
│   │   ├── MarketDataCollector.ts      # Live candle/indicator collection
│   │   └── StartupSync.ts              # Startup state synchronization
│   ├── ml/
│   │   ├── PredictionLogger.ts         # momentum-v6 scoring + live prediction logging
│   │   ├── PredictionEngine.ts         # Prediction engine (unused by live path now)
│   │   └── FeatureEngine.ts            # Feature generator
│   └── utils/
│       ├── logger.ts
│       └── indicators.ts               # rsi, macd, bb, ema, atr, stoch, adx, williams, obv

scripts/ml/
├── backtest/                           # Backtest engine (strategy.ts + engine.ts + sentiment.ts)
│   ├── strategy.ts                     # v6 + v7 scoring functions, exit logic
│   ├── engine.ts                       # Backtest runner with pluggable scorers
│   └── sentiment.ts                    # Sentiment panel builder + rule table
├── run-backtest.ts                     # Run strategy variants and persist to BacktestRun
├── run-backtest-oos.ts                 # Out-of-sample validation runner
├── run-threshold-sweep.ts              # Sentiment threshold parameter sweep
├── run-majors-sentiment-test.ts        # Test sentiment on BTC/ETH/SOL whitelist
├── run-no-vvv-test.ts                  # Ex-VVV sanity check
├── backfill-indicators.ts              # Compute & persist historical indicators
├── backfill-sentiment-fills.ts         # Fetch Archangel + Bitcoin MA historical fills
├── backfill-higher-tf-candles.ts       # Fetch 4h + 1d candles
├── backfill-oos-data.ts                # Combined OOS data backfill
├── sentiment-correlation.ts            # Sentiment vs target correlation analysis
├── target-lifecycle-v2.ts              # Target position lifecycle (NEW/ADD/REDUCE/CLOSE/FLIP)
├── position-state-correlation.ts       # Position state (not fill) correlation with sentiment
├── target-behavior.ts                  # Target entry signature analysis
├── compute-baselines.ts                # Target P&L + buy-and-hold baselines
├── weekly-independent-analysis.ts      # Past N-day independent trading performance
├── independent-stats.ts                # All-time independent trading stats
├── prediction-stats.ts                 # Prediction scoring stats
├── run-predictions.ts                  # Manual prediction test
├── strategy-analysis.ts                # Target strategy analysis
├── deep-strategy-analysis.ts           # Deep behavioral analysis
├── historical-trade-analysis.ts        # Historical trade analysis
└── cleanup-predictions.ts              # Archive old predictions
```

---

## Development Commands

```bash
# Run
npm start                                 # Production
npm run dev                               # Dev with auto-restart

# Database
npx prisma studio                         # Web UI
npx prisma generate                       # Regenerate client
npx prisma db push                        # Push schema changes

# Monitoring
npm run ml:stats                          # Prediction performance (momentum-v6)
npm run ml:independent-stats              # All-time independent stats
npx tsx scripts/ml/weekly-independent-analysis.ts   # Past N days

# Analysis
npm run ml:strategy                       # Target strategy analysis
npm run ml:deep                           # Deep behavioral analysis

# Backtest (local analysis — uses in-DB historical candles/indicators/fills)
npx tsx scripts/ml/backfill-indicators.ts      # (one-off) Compute historical indicators
npx tsx scripts/ml/backfill-sentiment-fills.ts # Fetch Archangel + Bitcoin MA historical fills
npx tsx scripts/ml/run-backtest.ts             # Run in-sample strategy variants
npx tsx scripts/ml/run-backtest-oos.ts         # Run OOS validation
npx tsx scripts/ml/run-threshold-sweep.ts      # Sweep sentiment threshold values
npx tsx scripts/ml/compute-baselines.ts        # Compute target P&L + B&H baselines

# Deployment
npm run docker-build
npm run docker-tag
npm run docker-push
```

---

## Risk Management

- Minimum margin: $5 USD
- Minimum position value: $10 USD (exchange requirement)
- Slippage control: 1% for market orders
- Database health: auto-reconnect on failures
- Global error handlers prevent crashes
- `ENABLE_COPY_TRADING=false` — emergency stop for copy trading
- `ENABLE_INDEPENDENT_TRADING=false` — disable autonomous trading

---

## Roadmap — Phase 5: Optimization & Scaling

- [x] Validate v5.1/v6 performance with proper out-of-sample backtesting
- [x] Stop-loss sensitivity study (-5% / -10% / -15%, + no-stop variant)
- [x] Target vault behavioral analysis (lifecycle, sentiment correlation)
- [x] Build sentiment panel (Archangel + Bitcoin MA hourly direction timeline)
- [x] Symmetric longs/shorts in independent trading (MIN_SCORE_SHORT 95 → 90)
- [x] Add third copy target (bd9c personal wallet)
- [ ] Monitor live performance with third target
- [ ] Revisit sentiment integration after more OOS data accumulates
- [ ] Move toward Sharpe ≥ 1.5 target before increasing independent allocation further

---

## Changelog

### 2026-04-10 — Deploy postmortem: Cloud Run rollout race

When `gcloud run services update --update-env-vars` adds/removes a copy target, Cloud Run briefly runs the old + new revision concurrently during traffic shifting. The two revisions compute different target position sizes (because `aggregateTargetPositions` divides by `numTargets`) and execute conflicting actions on the same symbols within seconds.

**Incident:** Adding bd9c as 3rd copy target on 2026-04-10 caused churn losses of ~$60 (BTC: -$59, FARTCOIN: -$1) over 18 seconds. The new revision correctly reduced positions by 33% (3-target math), then the old revision restored them (2-target math).

**Mitigation in `aggregateTargetPositions` math:**
- Adding/removing a copy target changes the divisor `(ourPortfolio / numTargets)`, which immediately rescales every existing position by `oldN/newN`.
- To safely add a target without triggering position adjustments, simultaneously update `COPY_SCALE_MULTIPLIER` by `oldN/newN`. E.g. going 2 → 3 targets: `COPY_SCALE_MULTIPLIER 3.0 → 4.5`.
- Long-term fix: refactor aggregation to not divide by `numTargets` (use sum of margin pcts directly, then re-tune the multiplier).

**Action taken:** Reverted COPY_TRADERS to 2 targets, deployed code changes (symmetric shorts, etc.) separately. bd9c will be re-added later with the compensating COPY_SCALE_MULTIPLIER bump.

---

### 2026-04-10 — Backtest framework, symmetric shorts, third copy target

**Added:**
- Full backtest engine (`scripts/ml/backtest/` + `run-backtest*.ts`) with in-sample/OOS support, pluggable scorers (v6, v7, v6_veto, v6_threshold), strategy variant persistence to `BacktestRun`/`BacktestTrade` tables.
- Historical indicator backfill for Jan 1 – Mar 15 window on 16 core symbols (28K indicator rows).
- Sentiment panel: hourly position state for Archangel + Bitcoin MA across the window, with rule-table direction predictor.
- Third copy target: `0xbd9c944dcfb31cd24c81ebf1c974d950f44e42b8` (personal wallet, original "Not In Employment" vault leader).

**Changed:**
- `MIN_SCORE_SHORT`: 95 → **90** (symmetric with longs). Shorts were effectively disabled by the asymmetric threshold; backtest showed enabling them improves P&L (-$287 → -$214 on the Jan-Mar window when expanded to 16 symbols; +$26 improvement on whitelist).
- Fixed stale code comments: `IndependentTrader.ts` line 278 (`-5%` → `-10% configurable`), Prisma schema comment (`shorts disabled` → `long | short`).
- Deleted old prediction model versions from DB (momentum-v2 189K rows, momentum-v3 61K rows, pattern-v1 24 rows). Only `momentum-v6` retained.

**Key findings (didn't change strategy, but inform future work):**
- **Target vault (`0x4cb5...`) analysis, corrected:** Only 93 real position events in 74 days (not 5,685 "trades" as TWAP aggregation suggested). Longs median hold ~2 days, shorts median hold 62 days. Longs lost $220K, shorts made $295K. BTC/ETH/SOL = 96% of P&L. Target held **one big short BTC conviction trade** for most of the window; only 1 direction flip.
- **Target IS contrarian to Bitcoin MA** ~54% of the time. Archangel is mostly flat at target entries. Target shorts in EMA-bull regime (84%) and longs in EMA-bear regime (71%) — opposite of what v6 scoring assumes.
- **Sentiment correlation is real but small.** v6 + sentiment threshold variant (+5/−5) improves OOS P&L from +$48 to +$84 and cuts drawdown (32% → 23%), but HURTS in-sample. Parameter sweep (±5 to ±25) shows no threshold value is robustly better than baseline across both windows.
- **VVV dominance problem:** Ex-VVV, the strategy has no edge (-95% in-sample, +4.5% OOS). VVV rally +296% carries the whole whitelist. Changing whitelist to BTC/ETH/SOL made things worse (-$74/-$10) — the momentum/breakout scoring doesn't fit majors.
- **Decision:** keep current live config (alt whitelist, v6 scoring, -10% hard stop, indicator exits, symmetric 90 thresholds). Main P&L driver is copy trading, independent trading is a side bet.
- **bd9c (new 3rd target):** personal wallet, active multi-symbol discretionary trading ($1.3M notional in 48h across BTC/HYPE/ETH + xyz builder perps). Currently flat (round-trips his positions intraday). Adding as 3rd copy target — activates when he opens new main DEX positions.

---

**For setup instructions see `README.md`.**
