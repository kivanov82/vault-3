# Vault-3: Hyperliquid Copytrading Bot - Technical Documentation

**Project Status:** Phase 1 Complete + Live Shadow Mode Prediction System
**Last Updated:** 2026-01-28

---

## Current State

✅ **Fully operational copytrading bot** with integrated live prediction/shadow mode system.

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

## Shadow Mode Prediction System

The bot now runs predictions alongside copy trading to learn and validate before influencing trades.

### How It Works

Every 5 minutes (integrated into copy trading cycle):

```
1. Fetch target & our positions
2. Update market data for active symbols
3. 🔮 Run predictions BEFORE copy actions
   - Score each symbol (0-100)
   - Predict direction (long/short)
   - Log with entry price
4. Execute copy trades (unchanged behavior)
5. Log actual action taken for each prediction
6. Every ~hour: Validate paper P&L
```

### Prediction Scoring

| Factor | Points | Condition |
|--------|--------|-----------|
| Symbol Quality | ±15 | Best/worst performer |
| RSI Signal | +15/+10 | Oversold/overbought |
| BB Position | +10 | Near bands (< 0.2 or > 0.8) |
| Volatility | +10 | High ATR (> 5%) |
| Active Hour | +5 | Peak trading hours UTC |
| BTC Movement | +5 | BTC moving > 1% |
| Funding Rate | +5 | Extreme funding |

**Base score:** 50 | **High confidence:** ≥ 65

### Paper Trading Validation

After 1 hour, each prediction is validated:
- Entry price vs exit price
- Paper P&L calculated based on predicted direction
- Tracks: Would this prediction have been profitable?

### Monitoring

```bash
npm run ml:stats    # View prediction performance
```

Shows:
- Total predictions & accuracy
- Paper P&L (total and average %)
- Performance by confidence level
- Performance by symbol
- Recent predictions with outcomes

---

## Technical Implementation

### Position-Based Copytrading

**Core Logic** (every 5 minutes):

1. Check database connection health (auto-reconnect if needed)
2. Fetch all positions from target vault and our vault
3. Calculate scale factor: `ourVaultSize / targetVaultSize`
4. **Run predictions for all symbols** (shadow mode)
5. For each symbol:
   - Compare target position vs. our position
   - Determine action: OPEN, CLOSE, FLIP, or ADJUST
   - Apply risk checks (min margin $5, min position $10)
   - Execute trade with exact leverage matching (1% slippage)
   - **Log prediction outcome** (what action was actually taken)
6. Finalize predictions for symbols with no action
7. Periodically validate past predictions (paper P&L)

**Position Actions:**
- **OPEN**: Target has position, we don't → Open new position
- **CLOSE**: Target closed, we still have position → Close position
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

### Prediction Table Fields

| Field | Description |
|-------|-------------|
| timestamp | When prediction was made |
| symbol | Trading symbol |
| prediction | Score (0-100) |
| confidence | Normalized confidence (0-1) |
| direction | Predicted direction: 1=long, -1=short |
| reasons | Signals that triggered prediction |
| entryPrice | Price when prediction was made |
| exitPrice | Price at validation time |
| paperPnl | Theoretical P&L if we acted |
| paperPnlPct | P&L as percentage |
| copyAction | What copy trading actually did |
| copySide | Actual trade side |
| copySize | Actual trade size |
| correct | Was prediction correct? |
| validatedAt | When validated |

---

## Code Structure

```
src/
├── index.ts                              # Express server
├── service/
│   ├── Vault3.ts                         # Orchestrator
│   ├── trade/
│   │   ├── CopyTradingManager.ts         # Position-based syncing + prediction integration
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
└── prediction-stats.ts                   # View prediction stats
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
npm run ml:stats        # View prediction performance
npm run ml:predict      # Manual prediction test

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
- **Database health:** Auto-reconnect on failures
- **Error recovery:** Global handlers prevent crashes
- **Slippage control:** 1% for market orders
- **Shadow mode:** Predictions don't affect trades (observation only)

### Manual Controls

- `MIN_POSITION_SIZE_USD` - Increase to avoid small positions
- `COPY_POLL_INTERVAL_MINUTES` - Adjust scan frequency
- `ENABLE_COPY_TRADING=false` - Emergency stop

---

## Roadmap

### Phase 1: Copytrading ✅ Complete

- [x] Position-based copytrading
- [x] WebSocket monitoring with auto-reconnect
- [x] Position rebalancing (±10% threshold)
- [x] Exact leverage matching

### Phase 2: Shadow Mode ✅ Complete

- [x] Integrated prediction logging
- [x] Paper trading validation
- [x] Prediction stats monitoring
- [x] Live data collection (candles, indicators, funding from copy trades)

### Phase 3: Validate Predictions (Current)

- [ ] Collect 2+ weeks of prediction data
- [ ] Analyze prediction accuracy by symbol/confidence
- [ ] Identify which signals are actually predictive
- [ ] Target: 65-70% accuracy on high-confidence predictions

### Phase 4: Prediction-Enhanced Copytrading (Planned)

- [ ] Skip trades for consistently worst-performing symbols
- [ ] Adjust position sizing based on confidence
- [ ] Front-run high-confidence predictions
- [ ] A/B testing framework

### Phase 5: Hybrid/Independent Trading (Planned)

- [ ] 80% copy + 20% independent
- [ ] Gradual transition based on proven accuracy
- [ ] Full autonomy when Sharpe ≥ 1.5

---

## Changelog

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
- ✅ WebSocket with robust reconnection
- ✅ Google Cloud SQL database

---

## Next Steps

1. **Deploy** the updated bot with shadow mode
2. **Monitor** predictions via `npm run ml:stats`
3. **Collect data** for 2-4 weeks
4. **Analyze** which predictions are accurate
5. **Decide** whether to use predictions to enhance copy trading

---

**For detailed setup instructions, see README.md**
