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
const COPY_TRADER = process.env.COPY_TRADER as `0x${string}`;
const COPY_MODE = process.env.COPY_MODE || 'scaled';

// Minimal risk limit
const MIN_POSITION_SIZE_USD = parseFloat(process.env.MIN_POSITION_SIZE_USD || '5');

// Position adjustment threshold (e.g., 0.1 = 10% difference triggers rebalance)
const POSITION_ADJUST_THRESHOLD = parseFloat(process.env.POSITION_ADJUST_THRESHOLD || '0.1');

// Scale multiplier for copy positions (1.3 = 30% larger than proportional)
const COPY_SCALE_MULTIPLIER = parseFloat(process.env.COPY_SCALE_MULTIPLIER || '1.3');

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
     * Internal scan implementation
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

            // Get both vault portfolios and all market prices in a single batch
            // This avoids calling getMarket() for each symbol (which was causing timeouts)
            const [targetPortfolio, ourPortfolio, targetPositions, allMarkets] = await Promise.all([
                HyperliquidConnector.getPortfolio(COPY_TRADER),
                HyperliquidConnector.getPortfolio(WALLET),
                HyperliquidConnector.getOpenPositions(COPY_TRADER),
                HyperliquidConnector.getMarkets(), // Fetch ALL markets once
            ]);

            // Calculate scaling factor based on vault sizes (with multiplier)
            const scaleFactor = COPY_MODE === 'exact' ? 1.0 :
                                (ourPortfolio.portfolio / targetPortfolio.portfolio) * COPY_SCALE_MULTIPLIER;

            // Get all symbols that target trader has positions in
            const targetSymbols = targetPositions.assetPositions
                .filter(ap => ap.position.szi !== '0')
                .map(ap => ap.position.coin);

            // Also check our positions to close any that target doesn't have
            const ourPositions = await HyperliquidConnector.getOpenPositions(WALLET);
            const ourSymbols = ourPositions.assetPositions
                .filter(ap => ap.position.szi !== '0')
                .map(ap => ap.position.coin);

            // Get unique set of all symbols to check
            // Include independent trading whitelist so we can detect signals on fresh symbols
            const independentWhitelist = IndependentTrader.isEnabled()
                ? IndependentTrader.getConfig().WHITELIST
                : [];
            const allSymbols = [...new Set([...targetSymbols, ...ourSymbols, ...independentWhitelist])];

            // Log scan summary
            const scanSummary = `📊 Scan: ${allSymbols.length} symbols (${targetSymbols.length} target, ${ourSymbols.length} ours) | Scale: ${(scaleFactor * 100).toFixed(1)}% | Available: $${ourPortfolio.available.toFixed(2)}`;
            logger.info(scanSummary);

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
            if (IndependentTrader.isEnabled()) {
                try {
                    // Process new signals for entry opportunities
                    await IndependentTrader.processSignals(allMarkets, targetPositions);
                    // Manage existing positions (TP/SL/timeout)
                    await IndependentTrader.managePositions(allMarkets, targetPositions);
                } catch (indepError: any) {
                    logger.error(`Independent trading error: ${indepError.message}`);
                }
            }

            // Re-fetch our positions after independent trading to avoid stale data
            // (IndependentTrader may have opened/closed positions above)
            const freshOurPositions = IndependentTrader.isEnabled()
                ? await HyperliquidConnector.getOpenPositions(WALLET)
                : ourPositions;

            // Track which symbols had copy actions
            const tradedSymbols = new Set<string>();

            // Process symbols in batches to avoid overwhelming the API
            // Batch size of 5 prevents connection timeouts
            const BATCH_SIZE = 5;
            for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
                const batch = allSymbols.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(symbol =>
                    Promise.race([
                        this.syncPosition(symbol, scaleFactor, scanStartTime, targetPositions, freshOurPositions, allMarkets, tradedSymbols),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Sync timeout')), 30000) // 30 second timeout per symbol
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
     * Sync a single position with the target vault
     */
    private static async syncPosition(
        ticker: string,
        scaleFactor: number,
        scanStartTime: number,
        targetPositions: any,
        ourPositions: any,
        allMarkets: Record<string, string>,
        tradedSymbols: Set<string>
    ) {
        // Extract positions from already-fetched data (no additional API calls)
        const targetPosition = targetPositions.assetPositions
            .find((ap: any) => ap.position.coin === ticker)?.position;
        const ourPosition = ourPositions.assetPositions
            .find((ap: any) => ap.position.coin === ticker)?.position;

        const targetSide = targetPosition ? HyperliquidConnector.positionSide(targetPosition) : 'none';
        const ourSide = ourPosition ? HyperliquidConnector.positionSide(ourPosition) : 'none';
        const targetSize = targetPosition ? Math.abs(Number(targetPosition.szi)) : 0;
        const ourSize = ourPosition ? Math.abs(Number(ourPosition.szi)) : 0;
        const targetLeverage = targetPosition?.leverage?.value || 1;

        // Get ticker config (static or dynamic)
        const tickerConfig = this.getTickerConfig(ticker, targetLeverage);
        if (!tickerConfig) {
            logger.warn(`⚠️  ${ticker}: No config available, skipping`);
            return;
        }

        // Calculate target size for us (scaled)
        const targetSizeForUs = targetSize * scaleFactor;

        // Calculate position delta
        const positionDelta = {
            symbol: ticker,
            targetSide,
            ourSide,
            targetSize,
            ourSize,
            targetSizeForUs,
            targetLeverage,
            needsAction: false,
            action: '' as 'open' | 'close' | 'flip' | 'adjust' | '',
        };

        // Determine required action
        if (targetSide === 'none' && ourSide !== 'none') {
            // Target closed, we need to close
            // BUT: Check if this is an unconfirmed independent position
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    // Don't close unconfirmed independent positions via copy trading
                    // They have their own TP/SL/timeout management
                    return;
                }
            }
            positionDelta.needsAction = true;
            positionDelta.action = 'close';
        } else if (targetSide !== 'none' && ourSide === 'none') {
            // Target opened, we need to open
            positionDelta.needsAction = true;
            positionDelta.action = 'open';
        } else if (targetSide !== 'none' && ourSide !== 'none' && targetSide !== ourSide) {
            // Target flipped direction, we need to flip
            // Copy trading ALWAYS takes priority over independent positions
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    // Close the independent position record in DB before flipping
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
            // Same direction - check if this confirms an independent position
            if (IndependentTrader.isEnabled()) {
                const indepStatus = await IndependentTrader.hasIndependentPosition(ticker);
                if (indepStatus.exists && !indepStatus.confirmed) {
                    // Mark as confirmed - copy trading will now manage sizing
                    await IndependentTrader.confirmPosition(ticker);
                    logger.info(`✅ ${ticker}: Independent position confirmed by target`);
                }
            }

            // Check if size adjustment needed
            const sizeDiff = Math.abs(ourSize - targetSizeForUs);
            const sizeThreshold = targetSizeForUs * POSITION_ADJUST_THRESHOLD;

            if (sizeDiff > sizeThreshold) {
                positionDelta.needsAction = true;
                positionDelta.action = 'adjust';
            }
            // else: Positions match within threshold - do nothing, stay synced with target
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
                case 'close':
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', 1, market);
                    logger.info(`✅ ${symbol}: CLOSE ${ourSide} ${ourSize.toFixed(4)}`);
                    await this.logCopyTrade(symbol, 'close', ourSide, 0, market, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'close', ourSide, ourSize);
                    break;

                case 'open':
                    await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage, false, market);
                    logger.info(`✅ ${symbol}: OPEN ${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x`);
                    await this.logCopyTrade(symbol, 'open', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'open', targetSide, targetSizeForUs);
                    break;

                case 'flip':
                    // Step 1: Close existing position first (frees up margin)
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', 1, market);
                    logger.info(`✅ ${symbol}: FLIP step 1 - closed ${ourSide}`);
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Step 2: Check margin after close before opening new direction
                    const flipPortfolio = await HyperliquidConnector.getPortfolio(WALLET);
                    const flipMarginNeeded = (positionValueUSD / targetLeverage) * 1.2;
                    if (flipMarginNeeded > flipPortfolio.available) {
                        logger.warn(`⚠️  ${symbol}: FLIP step 2 - closed ${ourSide} but insufficient margin for ${targetSide} (need $${flipMarginNeeded.toFixed(2)}, have $${flipPortfolio.available.toFixed(2)})`);
                        await this.logCopyTrade(symbol, 'close', ourSide, 0, market, targetLeverage, scanStartTime);
                        tradedSymbols.add(symbol);
                        break;
                    }

                    // Step 3: Open new position in target direction
                    await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage, false, market);
                    logger.info(`✅ ${symbol}: FLIP ${ourSide}→${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x`);
                    await this.logCopyTrade(symbol, 'flip', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    tradedSymbols.add(symbol);
                    await PredictionLogger.logCopyAction(symbol, 'flip', targetSide, targetSizeForUs);
                    break;

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
     * Find the most recent open trade for a symbol and update it with exit price and P&L
     */
    private static async updateOpenTradeWithPnl(
        symbol: string,
        closedSide: string,
        exitPrice: number
    ) {
        try {
            // Find the most recent open trade for this symbol that hasn't been closed yet
            const openTrade = await prisma.trade.findFirst({
                where: {
                    trader: 'us',
                    symbol,
                    side: closedSide,
                    exitPrice: null,
                    isCopyTrade: true,
                },
                orderBy: { timestamp: 'desc' },
            });

            if (!openTrade) return;

            const entryPrice = openTrade.entryPrice;
            const tradeSize = openTrade.size;
            const tradeLeverage = openTrade.leverage || 1;

            // P&L calculation: (exit - entry) * size for longs, (entry - exit) * size for shorts
            const priceDiff = exitPrice - entryPrice;
            const pnl = closedSide === 'long'
                ? priceDiff * tradeSize
                : -priceDiff * tradeSize;
            const pnlPercent = (priceDiff / entryPrice) * 100 * (closedSide === 'long' ? 1 : -1);
            const holdTimeSeconds = Math.round((Date.now() - openTrade.timestamp.getTime()) / 1000);

            await prisma.trade.update({
                where: { id: openTrade.id },
                data: {
                    exitPrice,
                    pnl,
                    pnlPercent: pnlPercent,
                    holdTimeSeconds,
                },
            });

            logger.info(`📊 ${symbol}: P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%) held ${Math.round(holdTimeSeconds / 60)}m`);
        } catch (error: any) {
            logger.error(`Failed to update P&L for ${symbol}: ${error.message}`);
        }
    }
}
