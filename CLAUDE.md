# Vault-3: Hyperliquid Copytrading Bot - Technical Documentation

**Project Status:** Phase 1 Complete + Strategy Analysis + Prediction Engine
**Last Updated:** 2026-01-27

---

## Current State

✅ **Fully operational copytrading bot** with comprehensive strategy analysis and prediction capabilities.

### Data Summary

| Metric | Value |
|--------|-------|
| Historical Fills | 18,842 |
| Logical Trades | 2,297 |
| Candles | 746,513 |
| Funding Records | 79,756 |
| Technical Indicators | 97,036 |
| Date Range | Nov 17, 2025 - Jan 25, 2026 (69 days) |

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

## Strategy Analysis Results

### Performance Summary (69 days)

| Metric | Value |
|--------|-------|
| **Total P&L** | **$448,194** |
| Win Rate | 43% |
| Avg Win | $878 |
| Avg Loss | $309 |
| Win/Loss Ratio | 2.84x |
| Profit Factor | 2.15 |
| Sharpe Ratio | ~5.86 |
| Max Drawdown | $45,284 |

### Top Performing Symbols

| Symbol | Trades | Win Rate | P&L |
|--------|--------|----------|-----|
| PUMP | 84 | 81% | +$78,264 |
| VVV | 167 | 38% | +$62,208 |
| ETH | 52 | 52% | +$56,092 |
| IP | 77 | 47% | +$54,192 |
| kPEPE | 45 | 53% | +$37,273 |

### Worst Performing Symbols

| Symbol | Trades | Win Rate | P&L |
|--------|--------|----------|-----|
| XMR | 34 | 6% | -$14,854 |
| AVNT | 125 | 18% | -$13,620 |
| SKY | 124 | 38% | -$9,052 |
| DYM | 15 | 0% | -$5,786 |
| kBONK | 39 | 21% | -$5,260 |

### Entry Signal Patterns

- **RSI at Entry:** Longs avg 51, Shorts avg 39 (shorts enter lower)
- **Mean Reversion Score:** 10.5% (not a strong mean reversion strategy)
- **BB Position:** Winners enter at 42% BB, Losers at 35% BB
- **MACD Trend Following:** 42% (slightly contrarian)

### Position Sizing Patterns

- **Avg Leverage:** 4.75x (median 3x)
- **Leverage by Direction:** Shorts 6.4x, Longs 4.4x
- **Leverage Distribution:** 82% use 2-5x, 18% use 5-10x
- **Top 3 Symbols:** 47% of portfolio
- **Kelly Suggestion:** 1-5% fractional Kelly

---

## Prediction Engine

### Architecture

The prediction engine uses pattern matching based on historical analysis:

```
src/service/ml/
├── PredictionEngine.ts    # Pattern-matching predictor
└── FeatureEngine.ts       # 50+ feature generator

scripts/ml/
├── prepare-training-data.ts   # Creates labeled training data
└── run-predictions.ts         # Runs live predictions
```

### Features Used (50+)

**Price Features:**
- Price change: 1h, 4h, 24h
- Distance from EMA21, EMA50
- Bollinger Band position (0-1)

**Momentum:**
- RSI(14)
- MACD, MACD Signal, MACD Histogram

**Volatility:**
- ATR(14) as % of price
- BB Width

**Context:**
- BTC change 1h, 24h
- ETH change 1h
- Funding rate

**Time:**
- Hour of day (0-23 UTC)
- Day of week
- Minutes to funding

**Behavioral:**
- Target trades last 24h
- Target last trade side

### Prediction Scoring

| Factor | Points | Condition |
|--------|--------|-----------|
| Symbol Quality | ±15 | Best/worst performer |
| RSI Signal | ±20 | Oversold/overbought |
| BB Position | ±10 | Near bands |
| Volatility | ±10 | High ATR |
| Active Hour | +10 | Peak trading hours |
| Recent Activity | +10 | Target traded recently |
| BTC Movement | ±5 | BTC moving >1% |
| Funding Rate | ±5 | High funding |

**Prediction Threshold:** Score ≥ 65 = likely trade

### Usage

```bash
# Run predictions on current market
npm run ml:predict

# Prepare training data (takes time)
npm run ml:prepare
```

---

## Roadmap

### Phase 1: Copytrading ✅ Complete

- [x] Position-based copytrading
- [x] WebSocket monitoring with auto-reconnect
- [x] TWAP detection & aggregation
- [x] Position rebalancing (±10% threshold)
- [x] Exact leverage matching

### Phase 2: Data Collection ✅ Complete

- [x] Historical candle backfill (746K+ candles)
- [x] Multi-timeframe support (1h, 5m, 15m, 4h)
- [x] Funding rate collection (80K+ records)
- [x] Trade enrichment with market context
- [x] Technical indicators (97K+ records)

### Phase 3: Strategy Analysis ✅ Complete

- [x] Trading patterns (hour/day/session)
- [x] Performance metrics (win rate, Sharpe, P&L)
- [x] Market correlation (BTC, funding)
- [x] TWAP analysis
- [x] Entry/exit signal detection
- [x] Position sizing analysis
- [x] Risk management analysis

### Phase 4: Prediction Engine ✅ In Progress

- [x] Feature engineering (50+ features)
- [x] Pattern-matching predictor
- [x] Prediction storage & validation
- [ ] Training data preparation
- [ ] Backtest predictions vs actual
- [ ] Shadow mode validation (target: 70%+ accuracy)

### Phase 5: Hybrid Execution (Planned)

- [ ] Prediction-enhanced copytrading
- [ ] Front-run high-confidence predictions
- [ ] Skip low-confidence trades
- [ ] A/B testing framework

### Phase 6: Independent Trading (Planned)

- [ ] 80% copy + 20% independent
- [ ] Gradual transition based on accuracy
- [ ] Full autonomy when Sharpe ≥ 1.5

---

## Technical Implementation

### Position-Based Copytrading

**Core Logic** (every 5 minutes):

1. Check database connection health (auto-reconnect if needed)
2. Fetch all positions from target vault and our vault
3. Calculate scale factor: `ourVaultSize / targetVaultSize`
4. For each symbol:
   - Compare target position vs. our position
   - Determine action: OPEN, CLOSE, FLIP, or ADJUST
   - Apply risk checks (min margin $5, min position $10)
   - Execute trade with exact leverage matching (1% slippage)
   - Log to database with latency tracking

**Position Actions:**
- **OPEN**: Target has position, we don't → Open new position
- **CLOSE**: Target closed, we still have position → Close position
- **FLIP**: Target changed direction (long↔short) → Close + Open opposite
- **ADJUST**: Same direction but size differs >10% → Increase or decrease

### TWAP Detection

Aggregates sequential fills into logical trades:

```typescript
if (
  fill.symbol === previousFill.symbol &&
  fill.side === previousFill.side &&
  fill.timestamp - previousFill.timestamp < 5 minutes &&
  isSameDirection(fill.szi, previousFill.szi)
) {
  aggregateTrade.addFill(fill);
} else {
  startNewAggregateTrade(fill);
}
```

**Results**: 35% of trades detected as TWAP (773 out of 2,222).

---

## Database Schema

### Core Tables

| Table | Records | Description |
|-------|---------|-------------|
| Fill | 18,842 | Raw fill events |
| Trade | 2,297 | Aggregated logical trades |
| Candle | 746,513 | OHLCV data (multi-timeframe) |
| FundingRate | 79,756 | 8-hour funding epochs |
| TechnicalIndicator | 97,036 | RSI, MACD, BB, EMA, ATR |
| FeatureSnapshot | - | ML training data |
| Prediction | - | Shadow mode validation |
| AnalysisReport | 8+ | Saved analysis results |

---

## Code Structure

```
src/
├── index.ts                              # Express server
├── service/
│   ├── Vault3.ts                         # Orchestrator
│   ├── trade/
│   │   ├── CopyTradingManager.ts         # Position-based syncing
│   │   └── HyperliquidConnector.ts       # Exchange API
│   ├── data/
│   │   └── StartupSync.ts                # Startup synchronization
│   ├── ml/
│   │   ├── FeatureEngine.ts              # 50+ ML features
│   │   └── PredictionEngine.ts           # Pattern-matching predictor
│   └── utils/
│       ├── logger.ts                     # Logging
│       └── indicators.ts                 # Technical indicators

scripts/
├── backfill-candles.ts                   # Historical candles
├── backfill-funding.ts                   # Historical funding
├── enrich-trades.ts                      # Market context enrichment
├── calculate-indicators.ts              # Technical indicator calculation
├── aggregate-pnl.ts                      # P&L aggregation
├── analysis/
│   ├── trading-patterns.ts
│   ├── performance-metrics.ts
│   ├── market-correlation.ts
│   ├── twap-analysis.ts
│   ├── entry-signals.ts
│   ├── exit-signals.ts
│   ├── position-sizing.ts
│   └── risk-management.ts
└── ml/
    ├── prepare-training-data.ts          # Training data generation
    └── run-predictions.ts                # Live predictions

reports/                                   # Generated JSON reports
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

# Data Collection
npm run backfill:candles           # Historical candles
npm run backfill:funding           # Historical funding rates
npm run enrich:trades              # Enrich trades with context
npm run calculate:indicators       # Calculate technical indicators
npm run aggregate:pnl              # Aggregate P&L from fills

# Strategy Analysis
npm run analysis:patterns          # Trading patterns
npm run analysis:performance       # Performance metrics
npm run analysis:correlation       # Market correlation
npm run analysis:twap              # TWAP analysis
npm run analysis:entry-signals     # Entry signals
npm run analysis:exit-signals      # Exit signals
npm run analysis:position-sizing   # Position sizing
npm run analysis:risk              # Risk management
npm run analysis:all               # Run all analyses

# Machine Learning
npm run ml:prepare                 # Prepare training data
npm run ml:predict                 # Run live predictions

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

# Phase Control
ENABLE_COPY_TRADING=true

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
- **Leverage matching:** Exact replication
- **TWAP resilience:** Position-based syncing
- **Database health:** Auto-reconnect on failures
- **Error recovery:** Global handlers prevent crashes
- **Slippage control:** 1% for market orders

### Manual Controls

- `MIN_POSITION_SIZE_USD` - Increase to avoid small positions
- `COPY_POLL_INTERVAL_MINUTES` - Adjust scan frequency
- `ENABLE_COPY_TRADING=false` - Emergency stop

---

## Changelog

### 2026-01-27 - Prediction Engine & Analysis Complete

- ✅ Fixed leverage data (fetched from API, set unknown to NULL)
- ✅ Aggregated P&L from fills to trades ($448K total)
- ✅ Calculated technical indicators (97K records)
- ✅ Created PredictionEngine with pattern-matching
- ✅ Added ML scripts (prepare-training-data, run-predictions)
- ✅ Completed all 8 analysis scripts with real data

### 2026-01-26 - Strategy Analysis & ML Foundation

- ✅ Added candle backfill (746K candles, 4 timeframes)
- ✅ Added funding rate backfill (80K records)
- ✅ Trade enrichment with BTC/ETH/funding context
- ✅ Created 8 analysis scripts
- ✅ Implemented technical indicators utility
- ✅ Created FeatureEngine (50+ features)
- ✅ Added new database models

### 2026-01-25 - Production Hardening

- ✅ Position rebalancing (increase AND decrease)
- ✅ Fixed resource leaks (HTTP client singleton)
- ✅ Fixed WebSocket event listener leak
- ✅ Database connection pool configuration

### 2026-01-24 - Phase 1 Launch

- ✅ Position-based copytrading operational
- ✅ 6,083 fills imported
- ✅ TWAP detection working (35%)
- ✅ WebSocket with robust reconnection
- ✅ Google Cloud SQL database

---

## Next Steps

1. **Run training data preparation** (`npm run ml:prepare`)
2. **Backtest predictions** against historical trades
3. **Achieve 70%+ accuracy** in shadow mode
4. **Integrate predictions** into live copytrading:
   - Front-run high-confidence predictions
   - Skip trades for worst-performing symbols
   - Adjust position sizing based on confidence
5. **Gradual transition** to independent trading

---

**For detailed setup instructions, see README.md**
