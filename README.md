# Vault-3: Hyperliquid Copytrading + Autonomous Trading Bot

**Production copytrading system with integrated prediction engine and autonomous trading on Hyperliquid perpetuals.**

---

## Overview

Vault-3 copies positions from a top-performing Hyperliquid vault while running an independent prediction-based trading system alongside it. The prediction engine uses technical indicators and BTC macro regime detection to generate autonomous trading signals.

### Current State (Phase 5)

- **Copytrading**: Fully operational, +30% scaled position sizing
- **Predictions**: v5 — indicator-based scoring with BTC macro regime detection
- **Independent Trading**: v5.1 — indicator-based exits with 30min min hold, -10% hard stop
- **Infrastructure**: Google Cloud Run + Cloud SQL (PostgreSQL)

---

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env  # Edit with your settings

# Database
npx prisma generate
npx prisma db push

# Run
npm run dev     # Development (auto-restart)
npm start       # Production
```

---

## How It Works

### Copy Trading (every 5 min)

1. Fetch positions from target vault and our vault
2. Calculate scale factor: `(ourVault / targetVault) * 1.3`
3. For each symbol: OPEN, CLOSE, FLIP, or ADJUST as needed
4. Execute with exact leverage matching, 1% slippage

### Prediction Engine (v5)

Runs before each copy cycle:

1. Collect 210 1h candles per symbol, compute indicators (RSI, MACD, BB, EMA, ATR)
2. Detect BTC macro regime (bull/bear/neutral) using EMA50, EMA200, 7d change, MACD
3. Score each symbol (0-100) with indicator signals + regime bias
4. Log predictions for paper trading validation

### Independent Trading (v5)

Opens autonomous positions on high-confidence signals:

- **Entry**: Score >= 90 (LONG) or >= 95 (SHORT), whitelist symbol, no existing position
- **Exit**: Indicator-based (BB > 0.8 unless breakout entry, RSI > 70, price < EMAs, BB mean reversion)
- **Safety**: -10% hard stop, 72h max hold, target confirmation/opposite handling
- **Allocation**: 10% of vault, max 3 positions, 5x leverage

---

## Configuration

```bash
# Copytrading
COPY_TRADER=0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3
COPY_MODE=scaled
COPY_POLL_INTERVAL_MINUTES=5
COPY_SCALE_MULTIPLIER=1.3

# Phase Control
ENABLE_COPY_TRADING=true
ENABLE_INDEPENDENT_TRADING=true

# Independent Trading
INDEPENDENT_MAX_ALLOCATION_PCT=0.10
INDEPENDENT_MAX_POSITIONS=3
INDEPENDENT_LEVERAGE=5
INDEPENDENT_HARD_STOP_PCT=0.10
INDEPENDENT_MAX_HOLD_HOURS=72

# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
```

---

## Monitoring

```bash
npm run ml:stats              # Prediction performance
npm run ml:independent-stats  # Independent trading stats
npm run ml:strategy           # Strategy analysis
npm run ml:deep               # Deep behavioral analysis
```

---

## Deployment

```bash
npm run docker-build    # Build image
npm run docker-tag      # Tag for GCR
npm run docker-push     # Push to registry
gcloud run deploy vault-3 --image gcr.io/bright-union/vault-3:latest --region europe-west1
```

---

## Architecture

```
src/
├── index.ts                              # Express server
├── service/
│   ├── Vault3.ts                         # Orchestrator
│   ├── trade/
│   │   ├── CopyTradingManager.ts         # Position syncing + prediction integration
│   │   ├── IndependentTrader.ts          # v5: indicator-based autonomous trading
│   │   └── HyperliquidConnector.ts       # Exchange API
│   ├── data/
│   │   ├── MarketDataCollector.ts        # Candle + indicator collection (210 candles)
│   │   └── StartupSync.ts               # Startup synchronization
│   ├── ml/
│   │   ├── PredictionLogger.ts           # v5: macro regime + indicator scoring
│   │   ├── PredictionEngine.ts           # Pattern-matching predictor
│   │   └── FeatureEngine.ts              # Feature generator
│   └── utils/
│       ├── logger.ts                     # Logging
│       └── indicators.ts                 # Technical indicators (RSI, MACD, BB, EMA, ATR, etc.)
```

---

## Technical Stack

- **Runtime**: Node.js 22 + TypeScript 5.7
- **Exchange SDK**: @nktkas/hyperliquid
- **Database**: PostgreSQL (Google Cloud SQL) + Prisma ORM
- **Deployment**: Docker + Google Cloud Run

---

**See CLAUDE.md for detailed technical documentation and changelog.**
