# Vault-3: Hyperliquid Copytrading Bot - Technical Documentation

**Project Status:** Phase 5 - Optimization & Scaling
**Last Updated:** 2026-03-15

---

## Current State

✅ **Fully operational copytrading bot** with integrated prediction system and autonomous trading capability.

### Configuration

- **Our Vault:** `0xc94376c6e3e85dfbe22026d9fe39b000bcf649f0` (vault-3)
- **Vault Leader:** `0x3Fc6E2D6c0E1D4072F876f74E03d191e2cC61922`
- **Target Vault:** `0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3`
- **Copy Strategy:** Position-based with scaled sizing
- **Leverage:** Exact 1:1 match with target
- **Scan Interval:** 5 minutes (configurable)
- **Slippage:** 1% for market orders
- **Infrastructure:** Google Cloud Run + Cloud SQL (PostgreSQL)

---

## Target Vault Strategy Profile

Based on analysis of 75 days of data (20,787 fills, 71 symbols):

### Strategy Type: Momentum/Breakout Accumulator

| Characteristic | Detail |
|----------------|--------|
| Entry Style | Breakout buying (65% at upper price range) |
| Execution | TWAP accumulation (avg 9.5 consecutive fills) |
| Leverage | Conservative (avg 4.8x) |
| BTC Behavior | Trade alts when BTC calm, same direction (77% correlation) |
| Session Pattern | Accumulate Asia/EU (89%/78% buys), trim US (65%) |
| Directional Bias | Long-heavy (64%) |
| Focus Assets | Memecoins/altcoins (HYPE, VVV, SPX, FARTCOIN, MON) |

### Entry Behavior by Symbol

| Symbol | Breakout Buys | Dip Buys |
|--------|--------------|----------|
| HYPE   | 65%          | 35%      |
| BTC    | 69%          | 31%      |
| VVV    | 56%          | 44%      |
| SKY    | 55%          | 45%      |

---

## Independent Trading System

Autonomous trading based on high-confidence prediction signals, running alongside copy trading.

### How It Works

```
Signal Detection (score ≥ 90 LONG / ≥ 95 SHORT, whitelist symbol)
    ↓
  OPEN position → Check every 5 min:
    ├─ Target confirmed same direction? → Hand to copy trading
    ├─ Target opened opposite? → Close immediately
    ├─ Hard stop: -5% from entry → Close immediately
    ├─ Indicator exit signal? → Close (BB/RSI/EMA based)
    └─ Max hold 72h? → Close at market
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max allocation | 10% of vault | On top of copy trading allocation |
| Max positions | 3 concurrent | ~3.3% each |
| Min score (LONG) | 90 | Very high confidence only |
| Min score (SHORT) | 95 | Higher bar for shorts |
| Leverage | 5x | Matches target avg (4.8x rounded) |
| Copy scale | +30% (1.3x) | COPY_SCALE_MULTIPLIER=1.3 |
| Exit strategy | v5: indicator-based | BB, RSI, EMA signals + hard stop + timeout |
| Whitelist | HYPE, SOL, VVV, ETH, MON, FARTCOIN | From cycle analysis |

### Exit Strategy (v5 - Indicator-Based)

| Signal | Direction | Condition | Data Basis |
|--------|-----------|-----------|------------|
| BB Upper | LONG exit | BB position > 0.8 | 0% WR, -23% avg at upper band |
| RSI High | LONG exit | RSI > 70 | 30% WR, -0.9% avg overbought |
| EMA TP | LONG exit | Price < EMA9 AND EMA21 + in profit | +11.4% avg P&L below both EMAs |
| BB Mean | SHORT exit | BB 0.4-0.6 + in profit | 83% WR, +4.2% avg at mean |
| EMA TP | SHORT exit | Price < EMA9 AND EMA21 + in profit | +3.3% avg P&L |
| Hard Stop | Both | -5% from entry | Safety net |
| Timeout | Both | 72h max hold | Safety net |

### Conflict Resolution

| Scenario | Action |
|----------|--------|
| Target opens same position | Mark confirmed, copy trading takes over sizing |
| Target opens opposite | Close independent position immediately |
| Copy wants to close unconfirmed | Skip - let independent TP/SL/timeout manage |

### Monitoring

```bash
npm run ml:independent-stats   # View independent trading performance
```

---

## Prediction System (v5 - Indicator + Macro Regime)

The bot runs predictions alongside copy trading using indicator signals and BTC macro regime detection.

### How It Works

Every 5 minutes (integrated into copy trading cycle):

```
1. Fetch target & our positions
2. Collect market data (210 candles per symbol, indicators)
3. 🔮 Run predictions BEFORE copy actions
   - Detect BTC macro regime (bull/bear/neutral)
   - Score each symbol (0-100) with indicator signals
   - Predict direction (long/short)
4. 🎯 Process independent trading signals (if enabled)
5. 📊 Manage independent positions (indicator-based exits)
6. Execute copy trades (unchanged behavior)
7. Every 36 hours: Validate paper P&L
```

### BTC Macro Regime Detection (v5)

Target shifted $1.8M long → $10.4M short when BTC dropped 24% ($92K→$70K).

| Signal | Bearish | Bullish |
|--------|---------|---------|
| BTC vs EMA50 | Below (-1) | Above (+1) |
| BTC vs EMA200 | Below (-1) | Above (+1) |
| BTC MACD | Bearish (-1) | Bullish (+1) |
| BTC 7d change | < -5% (-2) | > +5% (+2) |
| BTC RSI | < 30 (bounce +1) | > 70 (noted) |

Score <= -2 = **bear regime** (+10 score, +2 short signals, tie→short)
Score >= +2 = **bull regime** (+10 score, +2 long signals, tie→long)

### Prediction Scoring (v5)

| Factor | Points | Direction | Condition |
|--------|--------|-----------|-----------|
| MACD bullish | +8 | LONG x2 | MACD histogram > 0 (strongest signal) |
| MACD bearish | +5 | SHORT x2 | MACD histogram < 0 (91% accuracy) |
| RSI breakout | +8 | LONG x2 | RSI > 70 (breakout buyer) |
| RSI oversold | +8 | LONG x2 | RSI < 30 |
| BB breakout | +10 | LONG x2 | Price above upper BB |
| BB lower touch | +10 | LONG x2 | Price below lower BB |
| BB short zone | - | SHORT | BB position 0.2-0.4 (38% of shorts) |
| EMA bullish | +3 | LONG | EMA9 > EMA21 |
| Momentum 1h | +10/+5 | LONG/SHORT | 1h change > 0.5% / < -0.5% |
| Trend 4h | +8/+5 | LONG/SHORT | 4h change > 1% / < -1% |
| Macro regime | +10 | LONG or SHORT | Bull/bear regime detection |
| Session | +3-8 | - | EU (+8), US (+5), Asia (+3) |
| Confirmed short | +8 | SHORT | 3+ short signals + MACD bearish |

**Base score:** 50 | **High confidence:** ≥ 65 | **Independent threshold:** ≥ 80

### Paper Trading Validation

After 4 hours (target holds positions longer), each prediction is validated:
- Entry price vs exit price
- Paper P&L calculated based on predicted direction
- Direction correctness tracked separately from P&L

### Monitoring

```bash
npm run ml:stats       # View prediction performance (momentum-v2)
npm run ml:strategy    # Full strategy analysis
npm run ml:deep        # Deep behavioral analysis
```

---

## Technical Implementation

### Position-Based Copytrading

**Core Logic** (every 5 minutes):

1. Check database connection health (auto-reconnect if needed)
2. Fetch all positions from target vault and our vault
3. Calculate scale factor: `ourVaultSize / targetVaultSize`
4. **Run predictions for all symbols** (shadow mode)
5. **Process independent trading signals** (if enabled)
6. **Manage independent positions** (TP/SL/timeout checks)
7. For each symbol:
   - Compare target position vs. our position
   - Check for independent position conflicts
   - Determine action: OPEN, CLOSE, FLIP, or ADJUST
   - Apply risk checks (min margin $5, min position $10)
   - Execute trade with exact leverage matching (1% slippage)
   - **Log prediction outcome** (what action was actually taken)
8. Finalize predictions for symbols with no action
9. Periodically validate past predictions (paper P&L)

**Position Actions:**
- **OPEN**: Target has position, we don't → Open new position
- **CLOSE**: Target closed, we still have position → Close position (unless unconfirmed independent)
- **FLIP**: Target changed direction (long↔short) → Close + Open opposite
- **ADJUST**: Same direction but size differs >10% → Increase or decrease

---

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| Fill | Raw fill events from exchange |
| Trade | Aggregated logical trades (copy trades logged here) |
| Candle | OHLCV data (multi-timeframe) |
| FundingRate | 8-hour funding epochs |
| TechnicalIndicator | RSI, MACD, BB, EMA, ATR |
| Prediction | Shadow mode predictions with paper P&L |
| IndependentPosition | Autonomous trading positions |

### IndependentPosition Table Fields

| Field | Description |
|-------|-------------|
| symbol | Trading symbol |
| side | Position side ('long') |
| entryPrice | Entry price |
| size | Position size in asset units |
| sizeUsd | Position size in USD |
| leverage | Leverage used |
| tpPrice | Take profit price (entry * 1.08) |
| slPrice | Stop loss price (entry * 0.96) |
| timeoutAt | Max hold time (+24h from entry) |
| status | open, confirmed, closed |
| confirmedByTarget | Whether target opened same position |
| exitPrice | Exit price (when closed) |
| exitReason | tp, sl, timeout, target_confirmed, target_opposite |
| realizedPnl | Actual P&L in USD |
| realizedPnlPct | P&L as percentage |
| predictionScore | Score that triggered entry |
| predictionReasons | Signals that triggered entry |

---

## Code Structure

```
src/
├── index.ts                              # Express server
├── service/
│   ├── Vault3.ts                         # Orchestrator
│   ├── trade/
│   │   ├── CopyTradingManager.ts         # Position-based syncing + prediction integration
│   │   ├── IndependentTrader.ts          # Autonomous trading module
│   │   └── HyperliquidConnector.ts       # Exchange API
│   ├── data/
│   │   └── StartupSync.ts                # Startup synchronization
│   ├── ml/
│   │   ├── PredictionLogger.ts           # Live prediction logging & validation
│   │   ├── PredictionEngine.ts           # Pattern-matching predictor
│   │   └── FeatureEngine.ts              # Feature generator
│   └── utils/
│       ├── logger.ts                     # Logging
│       └── indicators.ts                 # Technical indicators

scripts/ml/
├── run-predictions.ts                    # Manual prediction testing
├── prediction-stats.ts                   # View prediction stats (momentum-v2)
├── independent-stats.ts                  # View independent trading stats
├── strategy-analysis.ts                  # Basic strategy analysis
├── deep-strategy-analysis.ts             # Deep behavioral analysis
├── save-strategy-report.ts               # Save analysis to DB
└── cleanup-predictions.ts                # Archive old predictions
```

---

## Development Commands

```bash
# Start bot
npm start               # Production
npm run dev             # Development (auto-restart)

# Database
npx prisma studio       # Web UI
npx prisma generate     # Regenerate client
npx prisma db push      # Push schema changes

# Prediction Monitoring
npm run ml:stats              # View prediction performance (momentum-v2)
npm run ml:independent-stats  # View independent trading stats
npm run ml:predict            # Manual prediction test
npm run ml:strategy           # Full strategy analysis
npm run ml:deep               # Deep behavioral analysis
npm run ml:save-report        # Save analysis report to DB
npm run ml:cleanup            # Archive old predictions

# Deployment
npm run docker-build
npm run docker-tag
npm run docker-push
```

---

## Environment Configuration

```bash
# Copytrading
COPY_TRADER=0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3
COPY_MODE=scaled
COPY_POLL_INTERVAL_MINUTES=5
COPY_SCALE_MULTIPLIER=1.3            # 30% larger than proportional

# Phase Control
ENABLE_COPY_TRADING=true
ENABLE_INDEPENDENT_TRADING=false  # Set to true to enable autonomous trading

# Independent Trading
INDEPENDENT_MAX_ALLOCATION_PCT=0.10   # 10% of vault
INDEPENDENT_MAX_POSITIONS=3           # Max concurrent positions
INDEPENDENT_LEVERAGE=5                # 5x leverage
INDEPENDENT_USE_TIME_EXIT=true        # v3: time-based exit (no TP/SL)
INDEPENDENT_HOLD_HOURS=4              # v3: 4h fixed hold
INDEPENDENT_TP_PCT=0.20               # only used if USE_TIME_EXIT=false
INDEPENDENT_SL_PCT=0.12               # only used if USE_TIME_EXIT=false

# Risk Management
MIN_POSITION_SIZE_USD=5
POSITION_ADJUST_THRESHOLD=0.1

# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
```

---

## Risk Management

### Built-in Safeguards

- **Minimum margin:** $5 USD (configurable)
- **Minimum position value:** $10 USD (exchange requirement)
- **Position scaling:** Proportional to vault size ratio
- **Leverage matching:** Exact replication for copy trades
- **Database health:** Auto-reconnect on failures
- **Error recovery:** Global handlers prevent crashes
- **Slippage control:** 1% for market orders
- **Independent allocation cap:** Max 3% of vault for autonomous trades
- **TP/SL management:** Automatic exit on independent positions

### Manual Controls

- `MIN_POSITION_SIZE_USD` - Increase to avoid small positions
- `COPY_POLL_INTERVAL_MINUTES` - Adjust scan frequency
- `ENABLE_COPY_TRADING=false` - Emergency stop for copy trading
- `ENABLE_INDEPENDENT_TRADING=false` - Disable autonomous trading

---

## Roadmap

### Phase 1: Copytrading ✅ Complete

- [x] Position-based copytrading
- [x] Position rebalancing (±10% threshold)
- [x] Exact leverage matching

### Phase 2: Shadow Mode ✅ Complete

- [x] Integrated prediction logging
- [x] Paper trading validation
- [x] Prediction stats monitoring
- [x] Live data collection (candles, indicators, funding from copy trades)

### Phase 3: Strategy Analysis & Prediction Refinement ✅ Complete

- [x] Comprehensive target vault analysis (75 days, 20K+ fills)
- [x] Identified strategy: Momentum/breakout accumulator
- [x] Rewrote predictions with momentum signals (v2)
- [x] Momentum-v2 prediction data collection

### Phase 4: Independent Trading ✅ Complete

- [x] IndependentTrader module (v1-v5 iterations)
- [x] High-confidence signal filtering (score ≥ 90 LONG, ≥ 95 SHORT)
- [x] Whitelist-based symbol selection (HYPE, SOL, VVV, ETH, MON, FARTCOIN)
- [x] Target confirmation handling
- [x] Conflict resolution with copy trading
- [x] Indicator-based exit strategy (v5: BB, RSI, EMA signals)
- [x] BTC macro regime detection (EMA50, EMA200, 7d change)
- [x] Live market data collection (210 candles, full indicator suite)

### Phase 5: Optimization & Scaling (Current)

- [ ] Collect v5 performance data (indicator-based exits)
- [ ] Validate macro regime accuracy
- [ ] Increase independent allocation based on proven accuracy
- [ ] Gradual transition from copy to autonomous
- [ ] Full autonomy when Sharpe ≥ 1.5

---

## Changelog

### 2026-03-15 - Prediction v5: BTC Macro Regime Detection

Target shifted $1.8M long → $10.4M short when BTC dropped 24% ($92K→$70K).
Added macro regime detector using BTC EMA50, EMA200, 7d change, MACD.

- ✅ Bear regime: strong short bias (+10 score, +2 short signals)
- ✅ Bull regime: strong long bias (+10 score, +2 long signals)
- ✅ Tie-breaker flips from long→short in bear regime
- ✅ Increased candle fetch from 60→210 for EMA200 computation

### 2026-03-14 - Independent Trading v5: Indicator-Based Exits

Analysis of 109 position cycles with candle-computed indicators showed
no fixed TP/SL, discretionary exits correlated with BB/RSI/EMA signals.

- ✅ LONG exits: BB > 0.8 (0% WR), RSI > 70 (30% WR), price < EMA9+21 (TP)
- ✅ SHORT exits: BB 0.4-0.6 mean (83% WR), price < EMA9+21 (TP)
- ✅ Safety nets: -5% hard stop, 72h max hold
- ✅ Removed trailing stop, min hold, peak price tracking

### 2026-03-14 - Live Market Data Collection + Prediction v4

- ✅ Created MarketDataCollector (fetches candles, computes indicators)
- ✅ MACD is #1 signal (91% accurate for shorts, weighted 2x)
- ✅ RSI > 70 = LONG signal (breakout buyer, reversed from standard)
- ✅ BB position scoring based on 454 matched indicator events
- ✅ Symbol role awareness (always-long vs mostly-short)

### 2026-03-09 - Independent Trading v4: Trailing Stop

- ✅ Hold time: 4h → 12h min / 72h max with trailing stop
- ✅ Trailing stop: 3% from peak after min hold
- ✅ Hard stop: -5% from entry (always active)
- ✅ Whitelist: HYPE, SOL, VVV, ETH, MON, FARTCOIN
- ✅ Shorts allowed at very high confidence (score >= 95)

### 2026-02-10 - Independent Trading v3 (Time-Based Exit)

Analysis showed paper trading has 99% win rate with 4h hold, but live TP/SL had 27% win rate.
Hypothesis: TP/SL triggers on volatility before the predicted move completes.

- ✅ Switched to 4h fixed hold (no TP/SL)
- ✅ Increased max allocation from 3% to 10% of vault
- ✅ Removed IP from whitelist (poor live performance)
- ✅ Added kPEPE and BERA to whitelist (100% paper win rate)
- ✅ Reset historic data for clean v3 analysis
- ✅ Will evaluate after 1 week of data collection

### 2026-02-04 - Independent Trading Bug Fixes

- ✅ Fixed prediction scope: now includes whitelist symbols for independent trading signals
- ✅ Fixed sizing calculation: margin allocation now correctly multiplied by leverage for notional
- ✅ Fixed leverage limits: IndependentTrader now uses shared metadata cache from CopyTradingManager
- ✅ Increased copy trading scale multiplier from 20% to 30% (COPY_SCALE_MULTIPLIER=1.3)

### 2026-02-03 - Independent Trading System

- ✅ Added IndependentTrader module for autonomous trading
- ✅ High-confidence signals only (score ≥ 80, LONG only)
- ✅ Whitelist: VVV, AXS, IP, LDO, AAVE, XMR, GRASS, SKY, ZORA
- ✅ TP/SL management (+8%/-4%) with 24h timeout
- ✅ Target confirmation handling (hand off to copy trading)
- ✅ Conflict resolution in CopyTradingManager
- ✅ IndependentPosition database model
- ✅ Monitoring script: `npm run ml:independent-stats`
- ✅ Removed WebSocket monitoring (using polling only)

### 2026-01-31 - Momentum Strategy v2

- ✅ Comprehensive target vault strategy analysis (75 days, 20K+ fills)
- ✅ Identified: Momentum/breakout accumulator strategy (not mean reversion)
- ✅ Key findings: 65% breakout buys, 77% BTC correlation, session-based accumulation
- ✅ Rewrote PredictionLogger with momentum-based signals (v2)
- ✅ Extended validation window from 1h to 4h (matches target hold patterns)
- ✅ Cleaned up old predictions (6,841 deleted, archived to AnalysisReport)
- ✅ Added analysis scripts: strategy, deep, save-report, cleanup
- ✅ Strategy report saved to DB for future reference

### 2026-01-28 - Live Shadow Mode System

- ✅ Integrated PredictionLogger into CopyTradingManager
- ✅ Predictions run BEFORE each copy cycle
- ✅ Paper trading validation with P&L tracking
- ✅ Added `npm run ml:stats` for monitoring
- ✅ Cleaned up historical data scripts (now collecting live)
- ✅ Updated Prediction schema for paper trading

### 2026-01-27 - Prediction Engine & Analysis

- ✅ Created PredictionEngine with pattern-matching
- ✅ Backtested on historical data (identified low precision)
- ✅ Completed strategy analysis (statistical profile)

### 2026-01-25 - Production Hardening

- ✅ Position rebalancing (increase AND decrease)
- ✅ Fixed resource leaks (HTTP client singleton)
- ✅ Database connection pool configuration

### 2026-01-24 - Phase 1 Launch

- ✅ Position-based copytrading operational
- ✅ Google Cloud SQL database

---

## Next Steps

1. **Monitor** v5 indicator-based exits via `npm run ml:independent-stats`
2. **Validate** macro regime detection accuracy (bear/bull calls)
3. **Track** indicator exit reasons (BB/RSI/EMA) win rates
4. **Evaluate** whether to increase independent allocation
5. **Consider** shorter hold times to match target's scalping style (86% exits < 1h)

---

**For detailed setup instructions, see README.md**
