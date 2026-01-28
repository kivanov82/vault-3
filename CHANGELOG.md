# Vault-3 Changelog

---

## 2026-01-26 - Strategy Analysis & ML Foundation

### New Features

**Data Collection Scripts:**
- `npm run backfill:candles` - Fetch historical candles for all traded symbols (1h, 5m, 15m, 4h)
- `npm run backfill:funding` - Fetch 8-hour funding rate epochs
- `npm run enrich:trades` - Add BTC/ETH prices and funding rates to existing trades

**Strategy Analysis (8 Scripts):**
- `npm run analysis:patterns` - Trading hour/day/session patterns, symbol preferences
- `npm run analysis:performance` - Win rate, P&L curve, Sharpe ratio, best/worst symbols
- `npm run analysis:correlation` - Entry timing vs trends, BTC/funding correlation
- `npm run analysis:twap` - TWAP duration, fill counts, size thresholds
- `npm run analysis:entry-signals` - RSI/MACD/Bollinger Band patterns at entry
- `npm run analysis:exit-signals` - Hold time distribution, TP/SL clustering
- `npm run analysis:position-sizing` - Size distribution, leverage patterns, Kelly criterion
- `npm run analysis:risk` - Drawdown analysis, sector concentration, risk metrics

**ML Foundation:**
- Technical indicators utility (`src/service/utils/indicators.ts`)
  - RSI, MACD, Bollinger Bands, ATR, EMA (9/21/50/200)
  - Stochastic Oscillator, ADX, Williams %R, ROC, OBV
- Feature Engine (`src/service/ml/FeatureEngine.ts`)
  - 50+ features: price, momentum, volatility, context, time, behavioral
- Database models for ML:
  - `TechnicalIndicator` - Pre-computed indicators
  - `FeatureSnapshot` - ML features with labels
  - `Prediction` - Shadow mode validation
  - `AnalysisReport` - Saved analysis results

### Database Changes
- Added 4 new Prisma models
- Migration: `20260126191804_add_analysis_models`

---

## 2026-01-25 - Position Rebalancing & Production Hardening

- Implemented position size rebalancing (increase AND decrease)
- Configurable adjustment threshold (default 10%)
- Fixed critical resource leaks (HTTP client singleton pattern)
- Fixed WebSocket event listener leak
- Added database connection pool configuration

---

## 2026-01-24 - Phase 1 Launch & Enhanced Copytrading

**Date**: 2026-01-24
**Changes**: Removed limits, improved WebSocket reliability, auto-discover positions

---

## Key Changes (2026-01-24)

### 1. ✅ Copy ALL Positions (No Ticker Whitelist)

**Before**: Only copied positions for specific tickers listed in `COPY_TICKERS`

**After**: Automatically discovers and copies ALL positions from target vault

**How it works:**
- Fetches all open positions from target vault
- Fetches all open positions from our vault
- Syncs the union of both (to close positions target no longer has)
- No manual ticker configuration needed

**Removed from `.env`:**
```bash
# COPY_TICKERS=BTC,ETH,SOL,SUI,XRP,GOAT,FARTCOIN,TRUMP  # ❌ No longer needed
```

### 2. ✅ Match Target's Leverage Exactly

**Before**: Limited leverage to 20x max

**After**: Uses the exact leverage the target vault uses

**Benefits:**
- True 1:1 performance replication
- No artificial constraints on position sizing
- Matches target's risk profile exactly

**Removed from `.env`:**
```bash
# MAX_LEVERAGE=20  # ❌ No longer limits leverage
```

**Now tracked in logs:**
```
💰 BTC: Position value $1,234.56, Leverage 40x
```

### 3. ✅ No Position Size Limits

**Before**: Limited positions to 30% of portfolio max

**After**: No maximum position size - matches target vault exactly

**Benefits:**
- Perfect position size replication
- Target vault knows best - we trust their risk management
- Scaled proportionally to our vault size

**Removed from `.env`:**
```bash
# MAX_POSITION_PERCENT=30  # ❌ No longer limits position size
```

### 4. ✅ Robust WebSocket Reconnection

**Problem**: WebSocket connections frequently dropped and failed to reconnect

**Solution**: Multi-layered reliability system

**Features:**
- **Exponential Backoff**: Reconnects with increasing delays (2s → 4s → 8s → 16s → 32s → 60s max)
- **Health Check**: Monitors connection every 30 seconds
- **Auto-Reconnect**: Forces reconnect if no messages for 2 minutes
- **Clean Shutdown**: Properly closes old connections before creating new ones
- **Retry Tracking**: Logs reconnection attempts for debugging

**How it works:**
```
Connection drops
  ↓
Wait 2 seconds → Reconnect (attempt 1)
  ↓ (if fails)
Wait 4 seconds → Reconnect (attempt 2)
  ↓ (if fails)
Wait 8 seconds → Reconnect (attempt 3)
  ↓ (continues with exponential backoff, max 60s)
```

**Health Check:**
```
Every 30 seconds:
  - Check when last WebSocket message received
  - If > 2 minutes → Force reconnect
  - Log health status
```

**Logs to expect:**
```
🔌 COPY TRADING: WebSocket connected
💓 WebSocket healthy (last message 15s ago)
⚠️  WebSocket health check failed (no messages for 125s)
🔄 Forcing WebSocket reconnection...
❌ COPY TRADING: WebSocket disconnected
🔄 Reconnecting in 4.0s (attempt 2)...
🔄 Attempting WebSocket reconnection (attempt 2)...
🔌 COPY TRADING: WebSocket connected
```

---

## Configuration Changes

### Updated `.env` File

**Removed:**
- `COPY_TICKERS` - No longer needed, auto-discovers all positions
- `MAX_LEVERAGE` - No longer limits leverage, matches target exactly
- `MAX_POSITION_PERCENT` - No longer limits position size
- `MAX_OPEN_POSITIONS` - No longer needed
- `DAILY_LOSS_LIMIT_PERCENT` - Can be added back if needed

**Kept:**
- `MIN_POSITION_SIZE_USD=5` - Skip tiny positions (avoid dust)
- `COPY_MODE=scaled` - Scale position sizes to our vault size
- `COPY_POLL_INTERVAL_SECONDS=30` - Check positions every 30s

### Current `.env` Settings

```bash
# Target Vault
COPY_TRADER=0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3

# Copytrading
COPY_MODE=scaled
COPY_POLL_INTERVAL_SECONDS=30

# Phase 1 Control
DISABLE_ALGO_STRATEGY=true
ENABLE_COPY_TRADING=true

# Database
DATABASE_URL=postgresql://vault3user:VaultPass123!654@35.195.167.186:5432/vault3?sslmode=no-verify

# Risk Management
MIN_POSITION_SIZE_USD=5

# Data Collection
ENABLE_ORDERBOOK_COLLECTION=false
ENABLE_FUNDING_COLLECTION=true
TWAP_DETECTION_WINDOW_SECONDS=300
```

---

## Technical Details

### Position Discovery Algorithm

**scanTraders() flow:**
1. Fetch target vault's all positions
2. Fetch our vault's all positions
3. Extract symbols from both (filter szi !== '0')
4. Create unique set of all symbols
5. For each symbol:
   - Compare target vs our position
   - Determine action (open/close/flip/adjust)
   - Execute if needed

**Example log:**
```
📊 Copy Trading Scan (Scale: 12.5%)
🔍 Checking 8 symbols (7 target, 3 ours)
🔄 BTC: OPEN (Target: long 40x, Ours: none)
💰 BTC: Position value $1,234.56, Leverage 40x
✅ BTC: open executed successfully
💾 BTC: Trade logged (latency: 1245ms, leverage: 40x)
```

### WebSocket Reconnection State Machine

```typescript
// State variables
wsTransport: WebSocket connection
wsClient: Subscription client
reconnectAttempts: Counter for exponential backoff
reconnectTimer: Scheduled reconnection
healthCheckTimer: Periodic health check

// Events
on 'open':
  - Reset reconnectAttempts to 0
  - Start health check

on 'close':
  - Stop health check
  - Schedule reconnect with exponential backoff

on 'error':
  - Log error
  - Wait for 'close' event (don't double-reconnect)

on 'message':
  - Update lastMessageTime (for health check)

healthCheck (every 30s):
  - If no messages for 2 minutes → force close
  - Log health status
```

### Leverage Matching

**Before:**
```typescript
if (tickerConfig.leverage > MAX_LEVERAGE) {
  logger.warn(`Leverage ${tickerConfig.leverage}x exceeds max ${MAX_LEVERAGE}x, skipping`);
  return;
}
```

**After:**
```typescript
const targetLeverage = targetPosition?.leverage?.value || 1;
// ... use targetLeverage directly, no limits
logger.info(`💰 ${symbol}: Position value $${positionValueUSD.toFixed(2)}, Leverage ${targetLeverage}x`);
```

---

## Testing Checklist

Before deploying to production, verify:

- [ ] Bot starts without errors
- [ ] WebSocket connects successfully
- [ ] Positions are discovered automatically (check logs for "Checking X symbols")
- [ ] Leverage matches target vault exactly
- [ ] Position sizes scale correctly to our vault size
- [ ] WebSocket reconnects automatically after disconnect (test by restarting Hyperliquid)
- [ ] Health check logs appear every 30 seconds
- [ ] Trades are logged to database with correct leverage

---

## Monitoring Commands

```bash
# Watch logs in real-time
tail -f logs/vault3.log

# Check database
npx prisma studio

# Test WebSocket health
# Look for: "💓 WebSocket healthy" every 30s

# Force WebSocket reconnect test
# Temporarily block Hyperliquid API, should see:
# "⚠️  WebSocket health check failed"
# "🔄 Forcing WebSocket reconnection..."

# Check copied positions
# Look for: "🔍 Checking X symbols (Y target, Z ours)"
```

---

## Rollback Plan

If issues arise, you can revert to previous behavior:

1. **Add back ticker whitelist** (`.env`):
   ```bash
   COPY_TICKERS=BTC,ETH,SOL
   ```

2. **Restore limits** (`.env`):
   ```bash
   MAX_LEVERAGE=20
   MAX_POSITION_PERCENT=30
   ```

3. **Update CopyTradingManager.ts**:
   - Uncomment the limit checks
   - Use COPY_TICKERS instead of auto-discovery

---

## Next Steps

1. **Import Historical CSV Data**
   ```bash
   npm run import-csv ./data/vault-fills.csv
   ```

2. **Start the Bot**
   ```bash
   npm run dev  # or npm start
   ```

3. **Monitor for 24 Hours**
   - Watch logs closely
   - Verify all positions are being copied
   - Check WebSocket stays connected
   - Validate leverage and position sizes match target

4. **After Validation**
   - Deploy to production
   - Set up alerting
   - Continue to Phase 1 Week 2 tasks

---

## Summary

**Simplified**: No more manual ticker lists, no more artificial limits
**Smarter**: Auto-discovers all positions, matches target exactly
**Resilient**: Exponential backoff + health checks = rock-solid WebSocket
**Accurate**: 1:1 leverage matching, scaled position sizes

The bot is now truly "hands-off" - it will copy whatever the target vault does, with automatic position discovery and robust connection management.
