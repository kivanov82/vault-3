import dotenv from "dotenv";
import * as hl from "@nktkas/hyperliquid";
import {HyperliquidConnector} from "./HyperliquidConnector";
import {logger} from "../utils/logger";
import { prisma } from '../utils/db';
import { PredictionLogger } from '../ml/PredictionLogger';
import { IndependentTrader } from './IndependentTrader';
import { MarketDataCollector } from '../data/MarketDataCollector';

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;
const COPY_MODE = process.env.COPY_MODE || 'scaled';

// Multi-target copy trading: comma-separated vault/wallet addresses
// e.g. "0xabc...,0xdef..."
const COPY_TRADERS: `0x${string}`[] = (process.env.COPY_TRADERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0) as `0x${string}`[];

// Minimal risk limit
const MIN_POSITION_SIZE_USD = parseFloat(process.env.MIN_POSITION_SIZE_USD || '5');

// Position adjustment threshold (e.g., 0.1 = 10% difference triggers rebalance)
const POSITION_ADJUST_THRESHOLD = parseFloat(process.env.POSITION_ADJUST_THRESHOLD || '0.1');

// Scale multiplier for copy positions (3.0 = 3x larger than proportional)
const COPY_SCALE_MULTIPLIER = parseFloat(process.env.COPY_SCALE_MULTIPLIER || '3.0');

// Maximum fraction of our portfolio that a SINGLE target can demand as margin.
// Without this cap, a diversified multi-symbol target (e.g. bd9c running 8 concurrent positions
// each at ~10% of his portfolio) produces a per-target demand of ~0.8 × COPY_SCALE_MULTIPLIER,
// which easily exceeds 100% of our portfolio on its own, leading to margin exhaustion and
// repeated "Order has zero size" thrashing. When a target's aggregate demand exceeds the cap,
// all of that target's per-symbol contributions are scaled down proportionally so relative
// allocation within the target is preserved.
const MAX_PORTFOLIO_UTILIZATION = parseFloat(process.env.MAX_PORTFOLIO_UTILIZATION || '0.7');

// Track last scan time for latency calculation
const tradeStartTimes = new Map<string, number>();

// Track failed orders to prevent immediate retries (symbol -> timestamp)
const failedOrders = new Map<string, number>();
const FAILED_ORDER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown after failed order

// Asset metadata cache (fetched from Hyperliquid) - exported for IndependentTrader
export const assetMetadataCache = new Map<string, any>();
let assetMetadataFetched = false;

// Scan mutex to prevent overlapping scans
let isScanRunning = false;
let lastScanStartTime = 0;
const SCAN_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes max per scan

export class CopyTradingManager {

    /**
     * Fetch asset metadata from Hyperliquid (one-time on first scan)
     */
    private static async fetchAssetMetadata(): Promise<void> {
        if (assetMetadataFetched) return;

        try {
            const transport = new hl.HttpTransport();
            const info = new hl.InfoClient({ transport });
            const meta = await info.meta();

            // Cache all asset metadata with index (used as asset ID)
            meta.universe.forEach((asset, index) => {
                assetMetadataCache.set(asset.name, {
                    name: asset.name,
                    id: index, // Asset ID is the index in the universe array
                    szDecimals: asset.szDecimals,
                    maxLeverage: asset.maxLeverage,
                    onlyIsolated: asset.onlyIsolated,
                });
            });

            assetMetadataFetched = true;
            logger.info(`✅ Cached metadata for ${assetMetadataCache.size} assets`);
        } catch (error: any) {
            logger.error(`Failed to fetch asset metadata: ${error.message}`);
        }
    }

    /**
     * Get ticker config dynamically from Hyperliquid metadata
     */
    private static getTickerConfig(symbol: string, targetLeverage: number): any {
        // Build dynamic config from Hyperliquid metadata
        const metadata = assetMetadataCache.get(symbol);
        if (!metadata) {
            logger.warn(`⚠️  ${symbol}: No metadata found in Hyperliquid universe`);
            return null;
        }

        // Build dynamic config
        const config = {
            syn: symbol,
            id: metadata.id,
            leverage: Math.min(targetLeverage, metadata.maxLeverage), // Use target's leverage, capped at max
            szDecimals: metadata.szDecimals,
        };

        // Only log once per symbol
        if (!this.hasLoggedConfig(symbol)) {
            logger.info(`📋 ${symbol}: Dynamic config (id: ${config.id}, leverage: ${config.leverage}x, decimals: ${config.szDecimals})`);
        }

        return config;
    }

    private static loggedConfigs = new Set<string>();
    private static hasLoggedConfig(symbol: string): boolean {
        if (this.loggedConfigs.has(symbol)) {
            return true;
        }
        this.loggedConfigs.add(symbol);
        return false;
    }

    /**
     * Position-based scanning - polls every N minutes to sync positions
     * This is resilient to TWAP orders since we compare final states, not individual fills
     */
    static async scanTraders() {
        // Prevent overlapping scans
        if (isScanRunning) {
            const timeSinceLastScan = Date.now() - lastScanStartTime;
            if (timeSinceLastScan < SCAN_TIMEOUT_MS) {
                logger.warn(`⏸️  Scan already running (${Math.floor(timeSinceLastScan / 1000)}s elapsed), skipping this iteration`);
                return;
            } else {
                logger.error(`🚨 Previous scan hung (${Math.floor(timeSinceLastScan / 1000)}s elapsed), force-resetting mutex`);
                isScanRunning = false;
            }
        }

        isScanRunning = true;
        lastScanStartTime = Date.now();
        const scanStartTime = Date.now();

        try {
            await this._doScan(scanStartTime);
        } finally {
            isScanRunning = false;
        }
    }

    /**
     * Internal scan implementation — iterates through all copy targets
     */
    private static async _doScan(scanStartTime: number) {
        // Clean up expired failed order cooldowns
        const now = Date.now();
        for (const [symbol, failedTime] of failedOrders.entries()) {
            if (now - failedTime > FAILED_ORDER_COOLDOWN_MS) {
                failedOrders.delete(symbol);
            }
        }

        try {
            // Test database connection health with timeout
            await Promise.race([
                prisma.$queryRaw`SELECT 1`,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Database health check timeout')), 5000)
                )
            ]);
        } catch (dbError: any) {
            logger.error(`❌ Database connection check failed: ${dbError.message}`);
            // Try to reconnect with timeout
            try {
                await Promise.race([
                    (async () => {
                        await prisma.$disconnect();
                        await prisma.$connect();
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Database reconnection timeout')), 10000)
                    )
                ]);
                logger.info(`✅ Database reconnected`);
            } catch (reconnectError: any) {
                logger.error(`❌ Database reconnection failed: ${reconnectError.message}`);
                return; // Skip this scan if DB is unavailable
            }
        }

        try {
            // Fetch asset metadata on first scan
            await this.fetchAssetMetadata();

            // Fetch our portfolio and all market prices once (shared across all targets)
            const [ourPortfolio, allMarkets] = await Promise.all([
                HyperliquidConnector.getPortfolio(WALLET),
                HyperliquidConnector.getMarkets(),
            ]);

            // Fetch targets sequentially to avoid HL RPC rate limits
            const activeTargets: {
                trader: `0x${string}`;
                portfolio: { portfolio: number; available: number };
                positions: any;
            }[] = [];
            for (const trader of COPY_TRADERS) {
                try {
                    const [portfolio, positions] = await Promise.all([
                        HyperliquidConnector.getPortfolio(trader),
                        HyperliquidConnector.getOpenPositions(trader),
                    ]);
                    activeTargets.push({ trader, portfolio, positions });
                } catch (e: any) {
                    logger.error(`❌ Failed to fetch target ${trader.slice(0, 10)}...: ${e.message}`);
                }
            }

            if (activeTargets.length === 0 && COPY_TRADERS.length > 0) {
                logger.error(`❌ All copy targets unreachable, skipping copy trading`);
            }

            // Aggregate desired positions across ALL targets
            // For each symbol: sum scaled sizes from all targets that hold it
            // If targets disagree on direction, the side with larger total notional wins
            const aggregatedPositions = this.aggregateTargetPositions(activeTargets, ourPortfolio.portfolio, allMarkets);

            // Build combined target positions for IndependentTrader conflict detection
            const combinedTargetPositions = this.mergeTargetPositions(activeTargets);

            // Collect all symbols: target positions + our positions + independent whitelist
            const ourPositions = await HyperliquidConnector.getOpenPositions(WALLET);
            const ourSymbols = ourPositions.assetPositions
                .filter(ap => ap.position.szi !== '0')
                .map(ap => ap.position.coin);

            const independentWhitelist = IndependentTrader.isEnabled()
                ? IndependentTrader.getConfig().WHITELIST
                : [];
            const allSymbols = [...new Set([
                ...aggregatedPositions.keys(),
                ...ourSymbols,
                ...independentWhitelist,
            ])];

            // Log scan summary
            const targetInfo = activeTargets.map(t =>
                `${t.trader.slice(0, 8)}($${(t.portfolio.portfolio / 1000).toFixed(0)}K)`
            ).join(', ');
            logger.info(`📊 Scan: ${allSymbols.length} symbols | Targets: ${targetInfo} | Our: $${ourPortfolio.portfolio.toFixed(0)} avail $${ourPortfolio.available.toFixed(2)}`);

            // Collect fresh market data (candles + indicators) BEFORE predictions
            try {
                await MarketDataCollector.collect(allSymbols);
            } catch (dataError: any) {
                logger.error(`Market data collection failed: ${dataError.message}`);
            }

            // Run predictions BEFORE copy actions (shadow mode)
            try {
                await PredictionLogger.logPredictions(allSymbols, allMarkets);
            } catch (predError: any) {
                logger.error(`Prediction logging failed: ${predError.message}`);
            }

            // Independent trading: process signals and manage positions
            // Pass combined target positions so conflicts with ANY target are detected
            // Copy trading always takes precedence — IndependentTrader checks for conflicts
            if (IndependentTrader.isEnabled()) {
                try {
                    await IndependentTrader.processSignals(allMarkets, combinedTargetPositions);
                    await IndependentTrader.managePositions(allMarkets, combinedTargetPositions);
                } catch (indepError: any) {
                    logger.error(`Independent trading error: ${indepError.message}`);
                }
            }

            // Re-fetch our positions after independent trading to avoid stale data
            const freshOurPositions = IndependentTrader.isEnabled()
                ? await HyperliquidConnector.getOpenPositions(WALLET)
                : ourPositions;

            // Track which symbols had copy actions
            const tradedSymbols = new Set<string>();

            // Sync positions using aggregated targets (one pass per symbol)
            const symbolsToSync = [...new Set([...aggregatedPositions.keys(), ...ourSymbols])];
            const BATCH_SIZE = 5;
            for (let i = 0; i < symbolsToSync.length; i += BATCH_SIZE) {
                const batch = symbolsToSync.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(symbol =>
                    Promise.race([
                        this.syncPosition(symbol, 1.0, scanStartTime, aggregatedPositions, freshOurPositions, allMarkets, tradedSymbols),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Sync timeout')), 30000)
                        )
                    ]).catch((e: any) => {
                        logger.error(`❌ ${symbol}: ${e.message}`);
                    })
                );
                await Promise.all(batchPromises);
            }

            // Finalize predictions for symbols that had no copy action
            try {
                await PredictionLogger.finalizeScanPredictions(tradedSymbols);
            } catch (finalizeError: any) {
                // Non-critical error
            }

            // Validate past predictions periodically (every ~hour = 12 scans at 5 min intervals)
            if (scanStartTime % (12 * 5 * 60 * 1000) < 5 * 60 * 1000) {
                try {
                    await PredictionLogger.validatePastPredictions();
                } catch (validateError: any) {
                    logger.error(`Prediction validation failed: ${validateError.message}`);
                }
            }

            // Log completion (only if there were actions)
            const duration = Date.now() - scanStartTime;
            if (tradedSymbols.size > 0) {
                logger.info(`✅ Scan complete: ${tradedSymbols.size} actions (${duration}ms)`);
            }
        } catch (e: any) {
            logger.error(`❌ Scan failed: ${e.message}`);
            logger.error(e.stack);
        }
    }

    /**
     * Merge all targets' positions into a single assetPositions structure
     * for IndependentTrader conflict detection. If multiple targets hold the
     * same symbol, keeps the first one found.
     */
    private static mergeTargetPositions(targets: { positions: any }[]): any {
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const t of targets) {
            for (const ap of t.positions.assetPositions) {
                const coin = ap.position.coin;
                if (ap.position.szi !== '0' && !seen.has(coin)) {
                    seen.add(coin);
                    merged.push(ap);
                }
            }
        }
        return { assetPositions: merged };
    }

    /**
     * Aggregate desired positions across all copy targets into a single map.
     *
     * For each symbol we sum each target's margin allocation as a percentage of
     * THEIR portfolio (so targets with different sizes/leverages contribute
     * proportional convictions). Long-side and short-side margin pcts accumulate
     * separately, then net out — opposite directions cancel.
     *
     * Sizing formula (independent of `numTargets` — adding a target with 0
     * exposure has zero effect on existing positions):
     *
     *   ourMargin   = abs(netMarginPct) × ourPortfolio × COPY_SCALE_MULTIPLIER
     *   ourNotional = ourMargin × winningSideLeverage
     *   ourSize     = ourNotional / price
     *
     * Examples (COPY_SCALE_MULTIPLIER = 3.0):
     *   1 target with 10% of their portfolio in BTC long → we use 30% of ours
     *   2 targets each with 10% in BTC long → we use 60% of ours (additive conviction)
     *   1 target long 10% + another short 5% on same symbol → net 5% long → we use 15%
     *
     * The previous formula divided by `numTargets`, which made adding/removing
     * a target instantly resize all positions and caused churn during Cloud Run
     * rollouts. The new formula is invariant to `numTargets` for unchanged signals.
     */
    private static aggregateTargetPositions(
        targets: { trader: `0x${string}`; portfolio: { portfolio: number; available: number }; positions: any }[],
        ourPortfolioValue: number,
        allMarkets: Record<string, string>
    ): Map<string, { side: string; size: number; leverage: number }> {
        // Per-target, per-symbol contribution. We compute each target's raw marginPct
        // contributions independently so we can apply a per-target utilization cap before
        // aggregating.
        type TargetContribution = {
            longMarginPct: number;   // sum over longs of (notional / leverage / targetPortfolio) × COPY_SCALE_MULTIPLIER
            shortMarginPct: number;
            longLeverage: number;    // max leverage across this target's long contributions
            shortLeverage: number;   // max leverage across this target's short contributions
        };
        // perTarget[trader][symbol] = contribution
        const perTarget: Array<{ trader: string; contribs: Map<string, TargetContribution> }> = [];

        for (const target of targets) {
            const contribs = new Map<string, TargetContribution>();
            let targetTotalDemand = 0; // sum of |long - short| contribs AFTER scaling, in units of our-portfolio fraction

            // First: raw per-symbol margin pct (relative to OUR portfolio, already scaled by multiplier)
            for (const ap of target.positions.assetPositions) {
                const coin = ap.position.coin;
                const szi = Number(ap.position.szi);
                if (szi === 0) continue;

                const side = HyperliquidConnector.positionSide(ap.position);
                const leverage = ap.position.leverage?.value || 1;
                const price = Number(allMarkets[coin]);
                if (!price) continue;

                // Fraction of target's portfolio allocated as margin for this position
                const notional = Math.abs(szi) * price;
                const targetMarginPct = notional / leverage / target.portfolio.portfolio;

                // Translate into our-portfolio fraction via scale multiplier
                const ourMarginPct = targetMarginPct * COPY_SCALE_MULTIPLIER;

                const existing = contribs.get(coin) || { longMarginPct: 0, shortMarginPct: 0, longLeverage: 0, shortLeverage: 0 };
                if (side === 'long') {
                    existing.longMarginPct += ourMarginPct;
                    existing.longLeverage = Math.max(existing.longLeverage, leverage);
                } else {
                    existing.shortMarginPct += ourMarginPct;
                    existing.shortLeverage = Math.max(existing.shortLeverage, leverage);
                }
                contribs.set(coin, existing);
            }

            // Per-target cap: total demanded margin from THIS target (sum of absolute
            // net-per-symbol contributions) must not exceed MAX_PORTFOLIO_UTILIZATION of our
            // portfolio. If it does, scale every contribution from this target proportionally.
            for (const c of contribs.values()) {
                targetTotalDemand += Math.abs(c.longMarginPct - c.shortMarginPct);
            }

            if (targetTotalDemand > MAX_PORTFOLIO_UTILIZATION) {
                const scale = MAX_PORTFOLIO_UTILIZATION / targetTotalDemand;
                for (const c of contribs.values()) {
                    c.longMarginPct *= scale;
                    c.shortMarginPct *= scale;
                }
                logger.info(
                    `⚖️  Target ${target.trader.slice(0, 10)}: demand ${(targetTotalDemand * 100).toFixed(0)}% > cap ` +
                    `${(MAX_PORTFOLIO_UTILIZATION * 100).toFixed(0)}%, scaling positions by ${(scale * 100).toFixed(0)}%`
                );
            }

            perTarget.push({ trader: target.trader, contribs });
        }

        // Aggregate across targets: net long vs short margin pcts per symbol.
        // Track leverage separately per side — when net direction is short, we must use the
        // max of short leverages (not long), otherwise a small opposite-side long at high
        // leverage would inflate our notional.
        type AggEntry = { longMarginPct: number; shortMarginPct: number; longLeverage: number; shortLeverage: number };
        const symbolAgg = new Map<string, AggEntry>();
        for (const { contribs } of perTarget) {
            for (const [symbol, c] of contribs) {
                const existing = symbolAgg.get(symbol) || { longMarginPct: 0, shortMarginPct: 0, longLeverage: 0, shortLeverage: 0 };
                existing.longMarginPct += c.longMarginPct;
                existing.shortMarginPct += c.shortMarginPct;
                existing.longLeverage = Math.max(existing.longLeverage, c.longLeverage);
                existing.shortLeverage = Math.max(existing.shortLeverage, c.shortLeverage);
                symbolAgg.set(symbol, existing);
            }
        }

        // Resolve direction and convert to position size.
        const result = new Map<string, { side: string; size: number; leverage: number }>();
        for (const [symbol, data] of symbolAgg) {
            const netMarginPct = data.longMarginPct - data.shortMarginPct;
            if (netMarginPct === 0) continue;

            const side = netMarginPct > 0 ? 'long' : 'short';
            const leverage = side === 'long' ? data.longLeverage : data.shortLeverage;
            const price = Number(allMarkets[symbol]);
            if (!price || !leverage) continue;

            // netMarginPct is already in units of our-portfolio fraction and already scaled.
            const ourMargin = Math.abs(netMarginPct) * ourPortfolioValue;
            const notional = ourMargin * leverage;
            const size = notional / price;

            result.set(symbol, { side, size, leverage });
        }

        return result;
    }

    /**
     * Sync a single position with the aggregated target state.
     *
     * @param aggregatedPositions Pre-computed map of desired positions (size already scaled).
     *   scaleFactor param is unused (pass 1.0) since sizing is pre-baked.
     */
    private static async syncPosition(
        ticker: string,
        _scaleFactor: number,
        scanStartTime: number,
        aggregatedPositions: Map<string, { side: string; size: number; leverage: number }>,
        ourPositions: any,
        allMarkets: Record<string, string>,
        tradedSymbols: Set<string>,
    ) {
        // Look up aggregated desired position for this symbol
        const desired = aggregatedPositions.get(ticker);
        const targetSide = desired ? desired.side : 'none';
        const targetSizeForUs = desired ? desired.size : 0;
        const targetLeverage = desired ? desired.leverage : 1;

        // Our current position
        const ourPosition = ourPositions.assetPositions
            .find((ap: any) => ap.position.coin === ticker)?.position;
        const ourSide = ourPosition ? HyperliquidConnector.positionSide(ourPosition) : 'none';
        const ourSize = ourPosition ? Math.abs(Number(ourPosition.szi)) : 0;

        // Get ticker config (static or dynamic)
        const tickerConfig = this.getTickerConfig(ticker, targetLeverage);
        if (!tickerConfig) {
            logger.warn(`⚠️  ${ticker}: No config available, skipping`);
            return;
        }

        // Calculate position delta
        const positionDelta = {
            symbol: ticker,
            targetSide,
            ourSide,
            targetSize: targetSizeForUs, // already scaled
            ourSize,
            targetSizeForUs,
            targetLeverage,
            needsAction: false,
            action: '' as 'open' | 'close' | 'flip' | 'adjust' | '',
        };

        // Determine required action
        if (targetSide === 'none' && ourSide !== 'none') {
            // No target holds this symbol — close (unless independent owns it)
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    // Unconfirmed independent position — let its own TP/SL/timeout manage
                    return;
                }
            }
            positionDelta.needsAction = true;
            positionDelta.action = 'close';
        } else if (targetSide !== 'none' && ourSide === 'none') {
            // Target(s) want a position, we don't have one — open
            // Copy trading takes precedence: force-close any independent position in opposite direction
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    const market = Number(allMarkets[ticker]);
                    if (market && !isNaN(market)) {
                        await IndependentTrader.forceClosePosition(ticker, market, 'copy_override');
                        logger.info(`🔄 ${ticker}: Closed independent position - copy trading taking over (open)`);
                    }
                }
            }
            positionDelta.needsAction = true;
            positionDelta.action = 'open';
        } else if (targetSide !== 'none' && ourSide !== 'none' && targetSide !== ourSide) {
            // Target wants opposite direction — flip
            // Copy trading ALWAYS takes priority over independent positions
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    const market = Number(allMarkets[ticker]);
                    if (market && !isNaN(market)) {
                        await IndependentTrader.forceClosePosition(ticker, market, 'copy_override');
                        logger.info(`🔄 ${ticker}: Closed independent position - copy trading taking over (flip)`);
                    }
                }
            }
            positionDelta.needsAction = true;
            positionDelta.action = 'flip';
        } else if (targetSide !== 'none' && ourSide !== 'none' && targetSide === ourSide) {
            // Same direction — check if this confirms an independent position
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    await IndependentTrader.confirmPosition(ticker);
                    logger.info(`✅ ${ticker}: Independent position confirmed by copy target`);
                }
            }

            // Check if size adjustment needed
            const sizeDiff = Math.abs(ourSize - targetSizeForUs);
            const sizeThreshold = targetSizeForUs * POSITION_ADJUST_THRESHOLD;

            if (sizeDiff > sizeThreshold) {
                positionDelta.needsAction = true;
                positionDelta.action = 'adjust';
            }
        }

        // Execute action if needed
        if (positionDelta.needsAction) {
            await this.executePositionSync(positionDelta, tickerConfig, scanStartTime, allMarkets, tradedSymbols);
        }
    }

    /**
     * Execute the position sync action
     */
    private static async executePositionSync(
        delta: any,
        tickerConfig: any,
        scanStartTime: number,
        allMarkets: Record<string, string>,
        tradedSymbols: Set<string>
    ) {
        const { symbol, action, targetSide, ourSide, targetSizeForUs, ourSize, targetLeverage } = delta;
        const isLong = targetSide === 'long';

        // Check if this symbol recently failed to open
        if (action === 'open' || action === 'flip') {
            const lastFailedTime = failedOrders.get(symbol);
            if (lastFailedTime && (Date.now() - lastFailedTime) < FAILED_ORDER_COOLDOWN_MS) {
                const remainingCooldown = Math.ceil((FAILED_ORDER_COOLDOWN_MS - (Date.now() - lastFailedTime)) / 1000);
                logger.warn(`⏸️  ${symbol}: Skipping ${action} - cooldown ${remainingCooldown}s`);
                return;
            }
        }

        // Track trade start time for latency measurement
        const tradeKey = `${symbol}_${scanStartTime}`;
        tradeStartTimes.set(tradeKey, Date.now());

        try {
            // Use pre-fetched market price (no API call needed)
            const market = Number(allMarkets[symbol]);
            if (!market || isNaN(market)) {
                logger.error(`❌ ${symbol}: No market price available`);
                return;
            }
            const positionValueUSD = targetSizeForUs * market;
            const marginRequired = positionValueUSD / targetLeverage;

            // Check minimum requirements (skip for close - always allow closing positions)
            const EXCHANGE_MIN_POSITION_VALUE = 10;

            if (action !== 'close') {
                if (marginRequired < MIN_POSITION_SIZE_USD) {
                    logger.warn(`⚠️  ${symbol}: Margin $${marginRequired.toFixed(2)} < $${MIN_POSITION_SIZE_USD} minimum`);
                    return;
                }

                if (positionValueUSD < EXCHANGE_MIN_POSITION_VALUE) {
                    logger.warn(`⚠️  ${symbol}: Position $${positionValueUSD.toFixed(2)} < $${EXCHANGE_MIN_POSITION_VALUE} minimum`);
                    return;
                }
            }

            // Check if we have enough margin for open actions (skip for flip - closing frees margin first)
            if (action === 'open') {
                const ourPortfolio = await HyperliquidConnector.getPortfolio(WALLET);
                const requiredMargin = positionValueUSD / targetLeverage;
                const requiredMarginWithBuffer = requiredMargin * 1.2;

                if (requiredMarginWithBuffer > ourPortfolio.available) {
                    logger.warn(`⚠️  ${symbol}: Need $${requiredMarginWithBuffer.toFixed(2)}, have $${ourPortfolio.available.toFixed(2)}`);
                    return;
                }
            } else if (action !== 'close' && action !== 'flip') {
                logger.info(`💰 ${symbol}: Position value $${positionValueUSD.toFixed(2)}, Leverage ${targetLeverage}x`);
            }

            // Execute the action (pass market price to avoid additional API calls)
            switch (action) {
                case 'close': {
                    const closeResult = await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', 1, market);
                    const closeFillPrice = HyperliquidConnector.getFillPrice(closeResult) ?? market;
                    logger.info(`✅ ${symbol}: CLOSE ${ourSide} ${ourSize.toFixed(4)} @ $${closeFillPrice.toFixed(2)}`);
                    await this.logCopyTrade(symbol, 'close', ourSide, 0, closeFillPrice, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'close', ourSide, ourSize);
                    break;
                }

                case 'open': {
                    const openResult = await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage, false, market);
                    const openFillPrice = HyperliquidConnector.getFillPrice(openResult) ?? market;
                    logger.info(`✅ ${symbol}: OPEN ${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x fill $${openFillPrice.toFixed(2)}`);
                    await this.logCopyTrade(symbol, 'open', targetSide, targetSizeForUs, openFillPrice, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'open', targetSide, targetSizeForUs);
                    break;
                }

                case 'flip': {
                    // Step 1: Close existing position first (frees up margin)
                    const flipCloseResult = await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', 1, market);
                    const flipCloseFillPrice = HyperliquidConnector.getFillPrice(flipCloseResult) ?? market;
                    logger.info(`✅ ${symbol}: FLIP step 1 - closed ${ourSide} @ $${flipCloseFillPrice.toFixed(2)}`);
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Step 2: Check margin after close before opening new direction
                    const flipPortfolio = await HyperliquidConnector.getPortfolio(WALLET);
                    const flipMarginNeeded = (positionValueUSD / targetLeverage) * 1.2;
                    if (flipMarginNeeded > flipPortfolio.available) {
                        logger.warn(`⚠️  ${symbol}: FLIP step 2 - closed ${ourSide} but insufficient margin for ${targetSide} (need $${flipMarginNeeded.toFixed(2)}, have $${flipPortfolio.available.toFixed(2)})`);
                        await this.logCopyTrade(symbol, 'close', ourSide, 0, flipCloseFillPrice, targetLeverage, scanStartTime);
                        tradedSymbols.add(symbol);
                        break;
                    }

                    // Step 3: Open new position in target direction
                    const flipOpenResult = await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage, false, market);
                    const flipOpenFillPrice = HyperliquidConnector.getFillPrice(flipOpenResult) ?? market;
                    logger.info(`✅ ${symbol}: FLIP ${ourSide}→${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x fill $${flipOpenFillPrice.toFixed(2)}`);
                    await this.logCopyTrade(symbol, 'flip', targetSide, targetSizeForUs, flipOpenFillPrice, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'flip', targetSide, targetSizeForUs);
                    break;
                }

                case 'adjust':
                    // Adjust position size to match target allocation
                    const sizeDelta = targetSizeForUs - ourSize;
                    const sizePercent = (sizeDelta / ourSize) * 100;
                    const adjustmentValueUSD = Math.abs(sizeDelta) * market;

                    // Check if adjustment is below exchange minimum ($10)
                    if (adjustmentValueUSD < EXCHANGE_MIN_POSITION_VALUE) {
                        // Adjustment too small - skip and keep current position (within threshold tolerance)
                        logger.warn(`⏸️  ${symbol}: Adjustment $${adjustmentValueUSD.toFixed(2)} < $${EXCHANGE_MIN_POSITION_VALUE} minimum, skipping (keeping current position)`);
                        return; // Don't adjust, don't close - just keep as-is to avoid open-close loop
                    }

                    if (sizeDelta > 0) {
                        await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, sizeDelta, targetLeverage, true, market);
                        logger.info(`✅ ${symbol}: ADJUST +${Math.abs(sizePercent).toFixed(0)}% (${ourSize.toFixed(4)}→${targetSizeForUs.toFixed(4)})`);
                        await this.logCopyTrade(symbol, 'increase', targetSide, sizeDelta, market, targetLeverage, scanStartTime);
                        tradedSymbols.add(symbol);
                        await PredictionLogger.logCopyAction(symbol, 'increase', targetSide, sizeDelta);
                    } else {
                        const reducePercent = Math.abs(sizeDelta) / ourSize;
                        await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', reducePercent, market);
                        logger.info(`✅ ${symbol}: ADJUST -${Math.abs(sizePercent).toFixed(0)}% (${ourSize.toFixed(4)}→${targetSizeForUs.toFixed(4)})`);
                        await this.logCopyTrade(symbol, 'decrease', targetSide, Math.abs(sizeDelta), market, targetLeverage, scanStartTime);
                        tradedSymbols.add(symbol);
                        await PredictionLogger.logCopyAction(symbol, 'decrease', targetSide, Math.abs(sizeDelta));
                    }
                    break;
            }

            // Wait for portfolio balance to update on API (important for subsequent trades in same scan)
            if (action !== 'adjust') {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // Clear failed order tracking on success
            if (action === 'open' || action === 'flip') {
                failedOrders.delete(symbol);
            }
        } catch (error: any) {
            logger.error(`❌ ${symbol}: ${action} failed - ${error.message}`);

            // Track failed open/flip orders to prevent immediate retries
            if (action === 'open' || action === 'flip') {
                failedOrders.set(symbol, Date.now());
                logger.info(`⏸️  ${symbol}: Order failure recorded - will skip for ${FAILED_ORDER_COOLDOWN_MS / 1000}s`);
            }
        }
    }

    /**
     * Log copy trade to database with latency tracking.
     * For close/flip actions, also update the original open trade with exit price and P&L.
     */
    private static async logCopyTrade(
        symbol: string,
        action: string,
        side: string,
        size: number,
        price: number,
        leverage: number,
        scanStartTime: number
    ) {
        try {
            const latencyMs = Date.now() - scanStartTime;

            await prisma.trade.create({
                data: {
                    timestamp: new Date(),
                    trader: 'us',
                    traderAddress: WALLET,
                    symbol,
                    side,
                    entryPrice: price,
                    size,
                    leverage,
                    isCopyTrade: true,
                    latencyMs,
                },
            });

            // On close/flip, find the original open trade and record exit P&L
            if (action === 'close' || action === 'flip') {
                await this.updateOpenTradeWithPnl(symbol, side, price);
            }
        } catch (error: any) {
            logger.error(`Failed to log trade for ${symbol}: ${error.message}`);
        }
    }

    /**
     * Find ALL open trade records for a symbol and update them with exit price and P&L
     */
    private static async updateOpenTradeWithPnl(
        symbol: string,
        closedSide: string,
        exitPrice: number
    ) {
        try {
            const openTrades = await prisma.trade.findMany({
                where: {
                    trader: 'us',
                    symbol,
                    side: closedSide,
                    exitPrice: null,
                    isCopyTrade: true,
                },
                orderBy: { timestamp: 'desc' },
            });

            if (openTrades.length === 0) return;

            let totalPnl = 0;
            for (const openTrade of openTrades) {
                const priceDiff = exitPrice - openTrade.entryPrice;
                const pnl = closedSide === 'long'
                    ? priceDiff * openTrade.size
                    : -priceDiff * openTrade.size;
                const pnlPercent = (priceDiff / openTrade.entryPrice) * 100 * (closedSide === 'long' ? 1 : -1);
                const holdTimeSeconds = Math.round((Date.now() - openTrade.timestamp.getTime()) / 1000);

                await prisma.trade.update({
                    where: { id: openTrade.id },
                    data: {
                        exitPrice,
                        pnl,
                        pnlPercent,
                        holdTimeSeconds,
                    },
                });

                totalPnl += pnl;
            }

            logger.info(`📊 ${symbol}: closed ${openTrades.length} trade records, total P&L ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
        } catch (error: any) {
            logger.error(`Failed to update P&L for ${symbol}: ${error.message}`);
        }
    }
}
