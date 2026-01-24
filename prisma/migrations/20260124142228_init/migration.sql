-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "fillId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "positionSzi" DOUBLE PRECISION NOT NULL,
    "aggregateTradeId" TEXT,
    "isFirstFill" BOOLEAN NOT NULL DEFAULT false,
    "isLastFill" BOOLEAN NOT NULL DEFAULT false,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "trader" TEXT NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "size" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "holdTimeSeconds" INTEGER,
    "isCopyTrade" BOOLEAN NOT NULL DEFAULT false,
    "targetTradeId" TEXT,
    "latencyMs" INTEGER,
    "slippageBps" DOUBLE PRECISION,
    "isTwapOrder" BOOLEAN NOT NULL DEFAULT false,
    "fillCount" INTEGER,
    "twapDurationSeconds" INTEGER,
    "avgEntryPrice" DOUBLE PRECISION,
    "worstSlippage" DOUBLE PRECISION,
    "btcPrice" DOUBLE PRECISION,
    "ethPrice" DOUBLE PRECISION,
    "fundingRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "rsi14" DOUBLE PRECISION,
    "macd" DOUBLE PRECISION,
    "macdSignal" DOUBLE PRECISION,
    "macdHist" DOUBLE PRECISION,
    "bbUpper" DOUBLE PRECISION,
    "bbMiddle" DOUBLE PRECISION,
    "bbLower" DOUBLE PRECISION,
    "atr14" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingRate" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionSnapshot" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION,
    "entryPrice" DOUBLE PRECISION,
    "unrealizedPnl" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Fill_fillId_key" ON "Fill"("fillId");

-- CreateIndex
CREATE INDEX "Fill_traderAddress_timestamp_idx" ON "Fill"("traderAddress", "timestamp");

-- CreateIndex
CREATE INDEX "Fill_symbol_timestamp_idx" ON "Fill"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Fill_aggregateTradeId_idx" ON "Fill"("aggregateTradeId");

-- CreateIndex
CREATE INDEX "Trade_traderAddress_timestamp_idx" ON "Trade"("traderAddress", "timestamp");

-- CreateIndex
CREATE INDEX "Trade_symbol_timestamp_idx" ON "Trade"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Trade_trader_timestamp_idx" ON "Trade"("trader", "timestamp");

-- CreateIndex
CREATE INDEX "Candle_symbol_timeframe_timestamp_idx" ON "Candle"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_symbol_timeframe_timestamp_key" ON "Candle"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "FundingRate_symbol_timestamp_idx" ON "FundingRate"("symbol", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "FundingRate_symbol_timestamp_key" ON "FundingRate"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "PositionSnapshot_traderAddress_timestamp_idx" ON "PositionSnapshot"("traderAddress", "timestamp");

-- CreateIndex
CREATE INDEX "PositionSnapshot_symbol_timestamp_idx" ON "PositionSnapshot"("symbol", "timestamp");
