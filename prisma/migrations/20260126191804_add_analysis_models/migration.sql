-- CreateTable
CREATE TABLE "TechnicalIndicator" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "ema9" DOUBLE PRECISION,
    "ema21" DOUBLE PRECISION,
    "ema50" DOUBLE PRECISION,
    "ema200" DOUBLE PRECISION,
    "rsi14" DOUBLE PRECISION,
    "macd" DOUBLE PRECISION,
    "macdSignal" DOUBLE PRECISION,
    "macdHist" DOUBLE PRECISION,
    "bbUpper" DOUBLE PRECISION,
    "bbMiddle" DOUBLE PRECISION,
    "bbLower" DOUBLE PRECISION,
    "bbWidth" DOUBLE PRECISION,
    "atr14" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalIndicator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureSnapshot" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "features" JSONB NOT NULL,
    "label" INTEGER,
    "direction" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "prediction" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "direction" INTEGER,
    "actualLabel" INTEGER,
    "correct" BOOLEAN,
    "modelVersion" TEXT,
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisReport" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechnicalIndicator_symbol_timeframe_timestamp_idx" ON "TechnicalIndicator"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalIndicator_symbol_timeframe_timestamp_key" ON "TechnicalIndicator"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_symbol_timestamp_idx" ON "FeatureSnapshot"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_label_idx" ON "FeatureSnapshot"("label");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSnapshot_symbol_timestamp_key" ON "FeatureSnapshot"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Prediction_symbol_timestamp_idx" ON "Prediction"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Prediction_correct_idx" ON "Prediction"("correct");

-- CreateIndex
CREATE INDEX "AnalysisReport_type_timestamp_idx" ON "AnalysisReport"("type", "timestamp");
