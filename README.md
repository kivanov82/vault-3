# Vault-3: Hyperliquid Copytrading + Autonomous Trading Bot

**Production copytrading system with integrated prediction engine and autonomous trading on Hyperliquid perpetuals.**

---

## Overview

Vault-3 copies positions from a top-performing Hyperliquid vault while running an independent prediction-based trading system alongside it. The prediction engine uses technical indicators and BTC macro regime detection to generate autonomous trading signals.

### Current State (Phase 5)

- **Copytrading**: 3 targets (Bitcoin MA + Archangel + bd9c personal), priority-ordered budget allocation, per-target multipliers `3.0, 3.0, 1.0`, 70% global margin cap
- **Predictions**: `momentum-v6` — indicator scoring with BTC macro regime detection
- **Independent Trading**: v5.1 — symmetric longs/shorts at score ≥ 90, indicator-based exits, -10% hard stop, 72h max hold, 30% margin cap
- **Infrastructure**: Google Cloud Run + Cloud SQL (PostgreSQL)
- **Backtest framework**: full in-sample/OOS engine in `scripts/ml/backtest/`

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

1. Fetch positions from each copy target (3 targets) and our vault
2. Aggregate desired positions via priority-ordered budget allocation: each target's `marginPct × multiplier` is summed in `COPY_TRADERS` order under a 70% global margin cap; higher-priority targets fully satisfied first, low-priority tail positions dropped if budget runs out (see CLAUDE.md "Aggregation" for the full algorithm)
3. For each symbol: OPEN, CLOSE, FLIP, or ADJUST as needed
4. Margin guards: if the full target size can't be funded from `available`, skip with `⚠️ SYM: doesn't fit`. Same rule applies to adjust-up. Adjust-down always allowed (frees margin).
5. Execute with exact leverage matching, 1% slippage

### Prediction Engine (`momentum-v6`)

Runs before each copy cycle:

1. Collect 210 1h candles per symbol, compute indicators (RSI, MACD, BB, EMA, ATR)
2. Detect BTC macro regime (bull/bear/neutral) using EMA50, EMA200, 7d change, MACD
3. Score each symbol (0-100) with indicator signals + regime bias
4. Log predictions for paper trading validation

### Independent Trading (v5.1)

Opens autonomous positions on high-confidence signals:

- **Entry**: Score ≥ 90 for **both** longs and shorts (symmetric), whitelist symbol, no existing position
- **Exit**: Indicator-based (BB > 0.8 unless breakout entry, RSI > 70, price < EMAs, BB mean reversion for shorts)
- **Safety**: -10% hard stop (price move), 72h max hold, target confirmation/opposite handling
- **Allocation**: 30% of vault **margin** (mirrors copy trading's 70% margin budget), max 5 positions, 5x leverage
- **Whitelist**: HYPE, SOL, VVV, ETH, MON, FARTCOIN

---

## Configuration

```bash
# Copytrading (multi-target — comma-separated, parallel lists)
COPY_TRADERS=0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768,0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0,0xbd9c944dcfb31cd24c81ebf1c974d950f44e42b8
COPY_SCALE_MULTIPLIERS=3.0,3.0,1.0        # per-target, parallel to COPY_TRADERS
COPY_ADJUST_THRESHOLDS=0.10,0.10,0.20     # per-target adjust trigger (10% vaults, 20% bd9c)
COPY_MODE=scaled
COPY_POLL_INTERVAL_MINUTES=5
MIN_ADJUSTMENT_VALUE_USD=20               # dust floor above the $10 exchange minimum

# Phase Control
ENABLE_COPY_TRADING=true
ENABLE_INDEPENDENT_TRADING=true

# Independent Trading (all use code defaults — uncomment to override)
# INDEPENDENT_MAX_ALLOCATION_PCT=0.30   # default 0.30 (margin-based)
# INDEPENDENT_MAX_POSITIONS=5           # default 5
# INDEPENDENT_LEVERAGE=5                # default 5
# INDEPENDENT_HARD_STOP_PCT=0.10        # default 0.10 (-10% price move)
# INDEPENDENT_MAX_HOLD_HOURS=72         # default 72

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
gcloud run services update vault-3 --region=europe-west1 --image=gcr.io/bright-union/vault-3
```

Cloud Run service is locked to `min-instances=1 max-instances=1` — single revision at a time to prevent rollout races between old/new containers executing conflicting trades (see CLAUDE.md changelog 2026-04-10 postmortem).

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
