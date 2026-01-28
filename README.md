# Vault-3: Hyperliquid Copytrading Bot

**Production-ready copytrading system for Hyperliquid perpetuals**

[![Status](https://img.shields.io/badge/status-operational-brightgreen)]()
[![Database](https://img.shields.io/badge/database-PostgreSQL-blue)]()
[![Platform](https://img.shields.io/badge/platform-Hyperliquid-orange)]()

---

## Overview

Vault-3 is an intelligent copytrading bot that replicates the positions of a top-performing Hyperliquid vault with high fidelity. Built for Phase 1 of a two-phase strategy to learn from successful traders and eventually trade independently.

**Current State**: Fully operational with 6,000+ historical fills imported and position-based copying active.

### Key Features

- ✅ **Auto-Discovery**: Automatically detects and copies ALL positions from target vault
- ✅ **TWAP-Resilient**: Position-based syncing handles Time-Weighted Average Price orders seamlessly
- ✅ **Exact Leverage Matching**: Replicates target vault's leverage precisely (no artificial limits)
- ✅ **Scaled Position Sizing**: Proportionally scales positions based on vault size ratio
- ✅ **Robust WebSocket**: Exponential backoff + health checks ensure reliable real-time monitoring
- ✅ **Comprehensive Logging**: All trades logged to PostgreSQL with latency tracking
- ✅ **Historical Data**: 2+ months of target vault history for analysis

---

## Quick Start

### 1. Prerequisites

- Node.js 22+
- PostgreSQL database (Google Cloud SQL or local)
- Hyperliquid wallet with funds

### 2. Installation

```bash
# Clone repository
git clone https://github.com/kivanov82/vault-3.git
cd vault-3

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### 3. Configuration

Edit `.env`:

```bash
# Your Hyperliquid Vault
WALLET=0xYourVaultAddress
WALLET_PK=0xYourPrivateKey
VAULT_LEADER=0xYourLeaderAddress

# Target Vault to Copy
COPY_TRADER=0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3

# Copytrading Settings
COPY_MODE=scaled                    # Proportional position sizing
COPY_POLL_INTERVAL_SECONDS=600      # Check positions every 10 minutes

# Database
DATABASE_URL=postgresql://user:pass@host:5432/vault3

# Risk Management
MIN_POSITION_SIZE_USD=5             # Minimum position size (avoid dust)

# Phase Control
DISABLE_ALGO_STRATEGY=true          # Legacy strategy disabled
ENABLE_COPY_TRADING=true            # Copytrading enabled
```

### 4. Database Setup

The database schema is already migrated. Verify:

```bash
npx prisma migrate status
```

### 5. Import Historical Data (Optional but Recommended)

Download trade history from Hyperliquid UI and import:

```bash
npm run import-csv ./export/trade_history.csv
```

### 6. Start the Bot

```bash
# Development mode (auto-restart)
npm run dev

# Production mode
npm start
```

---

## How It Works

### Startup Sync

**On every startup**, the bot ensures database integrity:

1. **Fetches last 2,000 fills** from Hyperliquid API
2. **Compares with database** - finds any missing fills
3. **Imports missing fills** - ensures 100% data completeness
4. **Aggregates new fills** into logical trades (TWAP detection)

This guarantees you never miss fills due to downtime, WebSocket disconnects, or database issues.

### Position-Based Copytrading

Every 10 minutes (configurable), the bot:

1. **Fetches all positions** from target vault and our vault
2. **Calculates scale factor** based on vault size ratio
3. **Compares positions** symbol by symbol
4. **Determines action**:
   - **OPEN**: Target has position, we don't → open position
   - **CLOSE**: Target closed, we still have position → close position
   - **FLIP**: Target switched direction → close + reopen
   - **ADJUST**: Size mismatch >10% → (Phase 2 feature)
5. **Executes trades** with exact leverage matching
6. **Logs everything** to database with latency tracking

### TWAP Handling

Unlike fill-based copying which would execute on every individual fill (disastrous for TWAP orders), we use **position-based syncing**:

- Compare final position states, not individual fills
- Natural aggregation over polling interval
- Resilient to multi-fill orders
- Lower execution frequency = lower costs

### WebSocket Monitoring

Real-time WebSocket connection for data collection:

- **Health checks** every 30 seconds
- **Auto-reconnect** with exponential backoff (2s → 4s → 8s → 60s max)
- **Force reconnect** if no messages for 2 minutes
- Logs all target vault fills for analysis

---

## Architecture

```
┌─────────────────────────────────────────────┐
│           Express API Server                │
│        (Port 3000, Health Checks)           │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│           Vault3 Orchestrator               │
│  ┌──────────────────┐  ┌─────────────────┐ │
│  │ Position Polling │  │ WebSocket Fill  │ │
│  │   (10 minutes)   │  │   Monitoring    │ │
│  └──────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│        CopyTradingManager (Enhanced)        │
│  - Auto-discover all positions              │
│  - Scaled position sizing                   │
│  - Exact leverage matching                  │
│  - Risk checks (min size)                   │
│  - Latency tracking                         │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│        HyperliquidConnector                 │
│  - Query positions/orders                   │
│  - Execute trades (market/limit)            │
│  - Portfolio management                     │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│     PostgreSQL Database (Google Cloud)      │
│  - Fills (raw events)                       │
│  - Trades (aggregated)                      │
│  - Position snapshots                       │
│  - Market data (future)                     │
└─────────────────────────────────────────────┘
```

---

## Monitoring

### Logs to Watch

**Startup:**
```
🚀 Vault-3 Initializing...
   Algo Strategy: ❌ DISABLED
   Copy Trading: ✅ ENABLED
   Copy Poll Interval: 600s

🔄 Starting startup sync...
📅 Latest fill in DB: 2026-01-23T14:23:45.000Z
📡 Fetching recent fills from Hyperliquid API...
📦 Fetched 2000 fills from API
✅ Database is up to date - no missing fills

✅ Copytrading system started
🔌 COPY TRADING: WebSocket connected
```

**Position Scan (every 10 min):**
```
📊 Copy Trading Scan (Scale: 12.5%)
🔍 Checking 8 symbols (7 target, 3 ours)
```

**Trade Execution:**
```
🔄 BTC: OPEN (Target: long 40x, Ours: none)
💰 BTC: Position value $1,234.56, Leverage 40x
✅ BTC: open executed successfully
💾 BTC: Trade logged (latency: 1245ms, leverage: 40x)
```

---

## Strategy Analysis

After importing historical data, run analysis scripts to understand the target vault's strategy:

```bash
# 1. Collect market data
npm run backfill:candles    # ~80,000 hourly candles
npm run backfill:funding    # ~10,000 funding records
npm run enrich:trades       # Add BTC/ETH prices to trades

# 2. Run analysis
npm run analysis:all        # Run primary analyses

# Individual analyses:
npm run analysis:patterns   # When does target trade? (hour/day/session)
npm run analysis:performance # Win rate, Sharpe, best/worst symbols
npm run analysis:correlation # Does target follow BTC? Funding?
npm run analysis:twap       # TWAP usage patterns
```

Reports are saved to `/reports/` directory and database (`AnalysisReport` table).

---

## Deployment

### Docker

```bash
# Build image
npm run docker-build

# Tag for Google Cloud
npm run docker-tag

# Push to registry
npm run docker-push
```

---

## Roadmap

### Phase 1: Copytrading & Learning (Current - Months 1-6)

- [x] Position-based copytrading
- [x] Historical data import (6,000+ fills)
- [x] TWAP detection & aggregation
- [x] Real-time WebSocket monitoring
- [x] Market data collection (candles, funding rates)
- [x] Technical indicators (RSI, MACD, BB, ATR, EMA)
- [x] Strategy analysis scripts (8 analysis types)
- [x] ML feature engineering (50+ features)
- [ ] Analytics dashboard
- [ ] Predictive modeling (shadow mode)

### Phase 2: Independent Trading (Months 6-12)

- [ ] Deploy learned strategy
- [ ] Hybrid execution (copy + independent)
- [ ] Gradual transition to autonomy

---

## Technical Stack

- **Runtime**: Node.js 22 + TypeScript 5.7
- **Exchange SDK**: @nktkas/hyperliquid ^0.25.0
- **Database**: PostgreSQL (Google Cloud SQL) + Prisma ORM
- **Scheduling**: node-schedule 2.1

---

## License

Proprietary - All rights reserved

---

**Last Updated**: 2026-01-26
