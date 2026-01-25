# Vault-3: Hyperliquid Copytrading Bot - Technical Documentation

**Project Status:** Phase 1 Operational
**Last Updated:** 2026-01-25

---

## Current State

✅ **Fully operational copytrading bot** with 6,083 historical fills and 2,222 trades imported.

### Configuration

- **Our Vault:** `0xc94376c6e3e85dfbe22026d9fe39b000bcf649f0` (vault-3)
- **Vault Leader:** `0x3Fc6E2D6c0E1D4072F876f74E03d191e2cC61922`
- **Target Vault:** `0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3`
- **Historical Data:** 67 days (Nov 17, 2025 - Jan 23, 2026)
- **Copy Strategy:** Position-based with scaled sizing
- **Leverage:** Exact 1:1 match with target
- **Scan Interval:** 5 minutes (configurable)
- **Slippage:** 1% for market orders
- **Infrastructure:** Google Cloud Run + Cloud SQL (PostgreSQL)

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
   - Apply risk checks:
     * Minimum margin: $5 USD
     * Minimum position value: $10 USD (exchange requirement)
   - Execute trade with exact leverage matching (1% slippage)
   - Log to database with latency tracking

**Key Features:**

- **Auto-discovery**: Scans all positions automatically (no manual ticker lists)
- **Dynamic ticker support**: Fetches asset metadata from Hyperliquid API (no hardcoded TICKERS)
- **TWAP-resilient**: Compares position states, not individual fills
- **Scaled sizing**: Proportional to vault size ratio
- **No artificial limits**: Matches target's leverage and position sizes exactly
- **Robust error handling**: Global error handlers prevent scheduler crashes
- **Database health checks**: Auto-reconnect on connection failures
- **Comprehensive logging**: Every trade logged with latency, leverage, P&L

### TWAP Detection

**Problem**: Target vault uses TWAP orders - one logical trade appears as many sequential fills.

**Solution**: Aggregate fills into logical trades:

```typescript
if (
  fill.symbol === previousFill.symbol &&
  fill.side === previousFill.side &&
  fill.timestamp - previousFill.timestamp < 5 minutes &&
  isSameDirection(fill.szi, previousFill.szi)
) {
  // Part of same TWAP order
  aggregateTrade.addFill(fill);
} else {
  // New logical trade
  startNewAggregateTrade(fill);
}
```

**Results**: 35% of trades detected as TWAP (773 out of 2,222).

### WebSocket Reliability

**Enhanced Reconnection Logic:**

- Exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s max
- Health checks every 30 seconds
- Force reconnect if no messages for 2 minutes
- Clean shutdown of old connections before creating new ones

**Health Check:**

```typescript
setInterval(() => {
  const timeSinceLastMessage = Date.now() - lastMessageTime;
  if (timeSinceLastMessage > 120000) {
    // Force reconnect if stale >2 minutes
    wsTransport.socket.close();
  }
}, 30000);
```

---

## Database Schema

### Tables

**`Fill`** - Raw fill events
- Individual executions (6,083 total)
- Used for TWAP detection
- Fields: fillId, timestamp, symbol, side, price, size, positionSzi, rawData

**`Trade`** - Aggregated logical trades
- TWAP orders grouped (2,222 total)
- Performance tracking
- Fields: trader, symbol, side, entryPrice, leverage, isCopyTrade, latencyMs, fillCount, twapDurationSeconds

**`Candle`** - Market data (Phase 2)

**`FundingRate`** - Funding rates (Phase 2)

**`PositionSnapshot`** - Position tracking (Phase 2)

---

## Key Metrics (Imported Data)

```
Date Range: 2025-11-17 to 2026-01-23 (67 days)

Total Fills: 6,083
Logical Trades: 2,222
TWAP Trades: 773 (34.8%)
Single Fill Trades: 1,449

Top 10 Assets Traded:
1. HYPE: 209 trades
2. SPX: 196 trades
3. VVV: 167 trades
4. AVNT: 125 trades
5. SKY: 124 trades
6. FARTCOIN: 104 trades
7. MON: 104 trades
8. VIRTUAL: 85 trades
9. PUMP: 83 trades
10. IP: 77 trades
```

---

## Phase 1 Roadmap

### Current Status: Week 1 Complete ✅

- [x] Enhanced copytrading system
- [x] PostgreSQL database on Google Cloud SQL
- [x] Historical data import (6,000+ fills)
- [x] TWAP detection & aggregation
- [x] WebSocket monitoring with auto-reconnect
- [x] Position-based syncing (10-minute interval)

### Week 2-3: Market Data Collection

- [ ] MarketDataCollector service
- [ ] Multi-timeframe candle fetching (1m, 5m, 15m, 1h, 4h)
- [ ] Technical indicators (RSI, MACD, BB, ATR, AO, Stoch)
- [ ] Orderbook snapshots
- [ ] Funding rate collection

### Week 4-5: Analytics Dashboard

- [ ] Express API endpoints (trade history, performance metrics)
- [ ] Web dashboard or Grafana integration
- [ ] Discord/Telegram alerting
- [ ] Performance attribution

### Week 6-8: Backtesting & Analysis

- [ ] Backtesting engine
- [ ] Historical performance analysis
- [ ] Pattern recognition (time-of-day, market regime)
- [ ] Win rate & Sharpe ratio calculations

### Week 9-12: Prediction Models

- [ ] Feature engineering (50+ features from market data)
- [ ] ML models (Random Forest, XGBoost)
- [ ] Binary classifier: "Will target open position in next 1h?"
- [ ] Shadow mode validation (70%+ accuracy target)

### Month 4-6: Phase 2 Preparation

- [ ] Hybrid execution framework (copy + independent)
- [ ] Independent trading logic
- [ ] Paper trading validation
- [ ] Gradual transition plan

---

## Code Structure

```
src/
├── index.ts                              # Express server + global error handlers
├── service/
│   ├── Vault3.ts                         # Orchestrator (position polling scheduler)
│   ├── trade/
│   │   ├── CopyTradingManager.ts         # Position-based syncing + WebSocket
│   │   └── HyperliquidConnector.ts       # Exchange API integration
│   ├── data/
│   │   └── StartupSync.ts                # Startup fill synchronization
│   ├── strategies/
│   │   ├── MainStrategy1h.ts.legacy      # [REMOVED] Legacy algo strategy
│   │   └── execution-config.ts           # Configuration
│   └── utils/
│       ├── logger.ts                     # Logging
│       └── smart-signal.ts               # Technical indicators
├── prisma/
│   └── schema.prisma                     # Database schema
└── scripts/
    ├── backfill-target-vault.ts          # API-based backfill (limited)
    └── import-csv-fills.ts               # CSV import (complete history)
```

---

## Environment Configuration

**Key Settings:**

```bash
# Copytrading
COPY_TRADER=0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3
COPY_MODE=scaled
COPY_POLL_INTERVAL_MINUTES=5        # 5 minutes (default)

# Phase Control
ENABLE_COPY_TRADING=true            # ✅ Copytrading enabled

# Risk Management
MIN_POSITION_SIZE_USD=5             # Minimum margin required ($5)
                                    # Note: Exchange also enforces $10 min position value

# Database
# For Cloud Run (Unix socket):
DATABASE_URL=postgresql://vault3user:pass@/vault3?host=/cloudsql/PROJECT:REGION:INSTANCE
# For local development (public IP):
DATABASE_URL=postgresql://vault3user:pass@IP:5432/vault3?sslmode=no-verify
```

**Removed Limits** (exact replication):
- ~~COPY_TICKERS~~ - Auto-discovers all positions
- ~~TICKERS~~ - Dynamic asset metadata from Hyperliquid API
- ~~MAX_LEVERAGE~~ - Matches target exactly
- ~~MAX_POSITION_PERCENT~~ - No position size limits
- ~~DISABLE_ALGO_STRATEGY~~ - Legacy algo strategy removed

---

## Monitoring

### Startup Logs

```
🚀 Vault-3 Initializing...
   Copy Trading: ✅ ENABLED
   Copy Poll Interval: 5 minutes

🔄 Starting startup sync...
✅ Startup sync complete
🔄 Running initial position scan...
📊 Copy Trading Scan (Scale: 12.5%)
✅ Copytrading system started
🔌 COPY TRADING: WebSocket connected
👀 Watching target vault: 0x4cb5...
```

### Position Scan (Every 5 minutes)

```
⏰ [2026-01-25T10:00:00.000Z] Running scheduled position scan...
📊 Copy Trading Scan (Scale: 12.5%)
🔍 Checking 8 symbols (7 target, 3 ours)
```

### Trade Execution

```
🔄 BTC: OPEN (Target: long 40x, Ours: none)
📋 BTC: Using dynamic config (id: 0, leverage: 40x, decimals: 5)
💰 BTC: Position value $1,234.56, Leverage 40x
📝 BTC: Submitting order - BUY 0.03000 @ 41234.56 (market: 40825.00)
   Position value: $1,224.75 @ 40x = $30.62 margin
✅ BTC: open executed successfully
💾 BTC: Trade logged (latency: 1245ms, leverage: 40x)
```

### WebSocket Health

```
💓 WebSocket healthy (last message 45s ago)
❌ COPY TRADING: WebSocket disconnected
🔄 Reconnecting in 4.0s (attempt 2)...
🔌 COPY TRADING: WebSocket connected
```

---

## Development Commands

```bash
# Start bot
npm start               # Production
npm run dev             # Development (auto-restart)

# Database
npx prisma studio       # Web UI
npx prisma migrate status

# Import data
npm run import-csv ./export/trade_history.csv
npm run backfill        # API (limited to 2000 fills)

# Deployment
npm run docker-build
npm run docker-tag
npm run docker-push
```

---

## Risk Management

### Built-in Safeguards

- **Minimum margin:** $5 USD (configurable)
- **Minimum position value:** $10 USD (exchange requirement)
- **Position scaling:** Proportional to vault size ratio
- **Leverage matching:** Exact replication (no artificial limits)
- **TWAP resilience:** Position-based syncing (not fill-based)
- **Database health:** Auto-reconnect on connection failures
- **Error recovery:** Global handlers prevent scheduler crashes
- **Slippage control:** 1% for market orders

### Manual Controls

- `MIN_POSITION_SIZE_USD` - Increase to avoid small positions (default: $5)
- `COPY_POLL_INTERVAL_MINUTES` - Adjust scan frequency (default: 5 minutes)
- `ENABLE_COPY_TRADING=false` - Emergency stop

---

## Phase 2 Goals

**Transition Timeline**: Months 6-12

1. **Independent Strategy Development**
   - Analyze 6+ months of copytrading data
   - Reverse-engineer target vault's strategy
   - Build predictive models (70%+ accuracy)

2. **Hybrid Execution**
   - 80% copy + 20% independent → gradual transition
   - A/B testing on small capital
   - Performance attribution

3. **Full Autonomy**
   - 100% independent trading
   - Sharpe ratio ≥ 1.5
   - Max drawdown ≤ 20%

---

## Changelog

### 2026-01-25 - Production Hardening

- ✅ Removed hardcoded TICKERS (dynamic asset metadata)
- ✅ Fixed Cloud SQL connection for Cloud Run (Unix socket)
- ✅ Fixed minimum position checks (margin vs. position value)
- ✅ Reduced slippage to 1% (from 3%)
- ✅ Changed scan interval to 5 minutes (from 10 minutes)
- ✅ Added global error handlers to prevent crashes
- ✅ Added database health checks with auto-reconnect
- ✅ Removed legacy algo strategy code
- ✅ Deployed to Google Cloud Run

### 2026-01-24 - Phase 1 Launch

- ✅ Position-based copytrading operational
- ✅ 6,083 fills imported (67 days of history)
- ✅ 2,222 logical trades aggregated
- ✅ TWAP detection working (35% of trades)
- ✅ WebSocket with robust reconnection
- ✅ Auto-discovery of all positions
- ✅ Exact leverage matching (no limits)
- ✅ Google Cloud SQL database

---

**For detailed setup instructions, see README.md**
