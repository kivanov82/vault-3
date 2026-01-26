import dotenv from "dotenv";
import * as hl from "@nktkas/hyperliquid";
import {HyperliquidConnector} from "./HyperliquidConnector";
import {logger} from "../utils/logger";
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;
const COPY_TRADER = process.env.COPY_TRADER as `0x${string}`;
const COPY_MODE = process.env.COPY_MODE || 'scaled';

// Minimal risk limit
const MIN_POSITION_SIZE_USD = parseFloat(process.env.MIN_POSITION_SIZE_USD || '5');

// Position adjustment threshold (e.g., 0.1 = 10% difference triggers rebalance)
const POSITION_ADJUST_THRESHOLD = parseFloat(process.env.POSITION_ADJUST_THRESHOLD || '0.1');

// Database with connection pool limits
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10, // Maximum connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Track last scan time for latency calculation
const tradeStartTimes = new Map<string, number>();

// Track failed orders to prevent immediate retries (symbol -> timestamp)
const failedOrders = new Map<string, number>();
const FAILED_ORDER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown after failed order

// WebSocket reconnection state
let wsTransport: hl.WebSocketTransport | null = null;
let wsClient: hl.SubscriptionClient | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;
let lastWebSocketMessageTime = Date.now();
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

// Asset metadata cache (fetched from Hyperliquid)
const assetMetadataCache = new Map<string, any>();
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

            // Get both vault portfolios to calculate scaling factor
            const [targetPortfolio, ourPortfolio, targetPositions] = await Promise.all([
                HyperliquidConnector.getPortfolio(COPY_TRADER),
                HyperliquidConnector.getPortfolio(WALLET),
                HyperliquidConnector.getOpenPositions(COPY_TRADER),
            ]);

            // Calculate scaling factor based on vault sizes
            const scaleFactor = COPY_MODE === 'exact' ? 1.0 :
                                (ourPortfolio.portfolio / targetPortfolio.portfolio);

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
            const allSymbols = [...new Set([...targetSymbols, ...ourSymbols])];

            // Log scan summary
            const scanSummary = `📊 Scan: ${allSymbols.length} symbols (${targetSymbols.length} target, ${ourSymbols.length} ours) | Scale: ${(scaleFactor * 100).toFixed(1)}% | Available: $${ourPortfolio.available.toFixed(2)}`;
            logger.info(scanSummary);

            // Process each symbol with timeout protection
            // Pass the already-fetched positions to avoid redundant API calls
            const syncPromises = allSymbols.map(symbol =>
                Promise.race([
                    this.syncPosition(symbol, scaleFactor, scanStartTime, targetPositions, ourPositions),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Sync timeout')), 30000) // 30 second timeout per symbol
                    )
                ]).catch((e: any) => {
                    logger.error(`❌ ${symbol}: ${e.message}`);
                })
            );

            await Promise.all(syncPromises);

            // Log completion (only if there were actions)
            const duration = Date.now() - scanStartTime;
            const actionsCount = syncPromises.length;
            if (actionsCount > 0) {
                logger.info(`✅ Scan complete (${duration}ms)`);
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
        ourPositions: any
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
            positionDelta.needsAction = true;
            positionDelta.action = 'close';
        } else if (targetSide !== 'none' && ourSide === 'none') {
            // Target opened, we need to open
            positionDelta.needsAction = true;
            positionDelta.action = 'open';
        } else if (targetSide !== 'none' && ourSide !== 'none' && targetSide !== ourSide) {
            // Target flipped direction, we need to flip
            positionDelta.needsAction = true;
            positionDelta.action = 'flip';
        } else if (targetSide !== 'none' && ourSide !== 'none' && targetSide === ourSide) {
            // Same direction, check if size adjustment needed
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
            await this.executePositionSync(positionDelta, tickerConfig, scanStartTime);
        }
    }

    /**
     * Execute the position sync action
     */
    private static async executePositionSync(
        delta: any,
        tickerConfig: any,
        scanStartTime: number
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
            const market = await HyperliquidConnector.getMarket(symbol);
            const positionValueUSD = targetSizeForUs * market;
            const marginRequired = positionValueUSD / targetLeverage;

            // Check minimum requirements
            const EXCHANGE_MIN_POSITION_VALUE = 10;

            if (marginRequired < MIN_POSITION_SIZE_USD) {
                logger.warn(`⚠️  ${symbol}: Margin $${marginRequired.toFixed(2)} < $${MIN_POSITION_SIZE_USD} minimum`);
                return;
            }

            if (positionValueUSD < EXCHANGE_MIN_POSITION_VALUE) {
                logger.warn(`⚠️  ${symbol}: Position $${positionValueUSD.toFixed(2)} < $${EXCHANGE_MIN_POSITION_VALUE} minimum`);
                return;
            }

            // Check if we have enough margin for open/flip actions
            if (action === 'open' || action === 'flip') {
                const ourPortfolio = await HyperliquidConnector.getPortfolio(WALLET);
                const requiredMargin = positionValueUSD / targetLeverage;
                const requiredMarginWithBuffer = requiredMargin * 1.2;

                if (requiredMarginWithBuffer > ourPortfolio.available) {
                    logger.warn(`⚠️  ${symbol}: Need $${requiredMarginWithBuffer.toFixed(2)}, have $${ourPortfolio.available.toFixed(2)}`);
                    return;
                }
            } else {
                logger.info(`💰 ${symbol}: Position value $${positionValueUSD.toFixed(2)}, Leverage ${targetLeverage}x`);
            }

            // Execute the action
            switch (action) {
                case 'close':
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long');
                    logger.info(`✅ ${symbol}: CLOSE ${ourSide} ${ourSize.toFixed(4)}`);
                    await this.logCopyTrade(symbol, 'close', ourSide, 0, market, targetLeverage, scanStartTime);
                    break;

                case 'open':
                    await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage);
                    logger.info(`✅ ${symbol}: OPEN ${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x`);
                    await this.logCopyTrade(symbol, 'open', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    break;

                case 'flip':
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, targetSizeForUs, targetLeverage);
                    logger.info(`✅ ${symbol}: FLIP ${ourSide}→${targetSide} ${targetSizeForUs.toFixed(4)} @ ${targetLeverage}x`);
                    await this.logCopyTrade(symbol, 'flip', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    break;

                case 'adjust':
                    // Adjust position size to match target allocation
                    const sizeDelta = targetSizeForUs - ourSize;
                    const sizePercent = (sizeDelta / ourSize) * 100;

                    if (sizeDelta > 0) {
                        await HyperliquidConnector.openCopyPosition(tickerConfig, isLong, sizeDelta, targetLeverage, true);
                        logger.info(`✅ ${symbol}: ADJUST +${Math.abs(sizePercent).toFixed(0)}% (${ourSize.toFixed(4)}→${targetSizeForUs.toFixed(4)})`);
                        await this.logCopyTrade(symbol, 'increase', targetSide, sizeDelta, market, targetLeverage, scanStartTime);
                    } else {
                        const reducePercent = Math.abs(sizeDelta) / ourSize;
                        await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long', reducePercent);
                        logger.info(`✅ ${symbol}: ADJUST -${Math.abs(sizePercent).toFixed(0)}% (${ourSize.toFixed(4)}→${targetSizeForUs.toFixed(4)})`);
                        await this.logCopyTrade(symbol, 'decrease', targetSide, Math.abs(sizeDelta), market, targetLeverage, scanStartTime);
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
     * Log copy trade to database with latency tracking
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

            // Removed verbose log - trade is already logged in execution
        } catch (error: any) {
            logger.error(`Failed to log trade for ${symbol}: ${error.message}`);
        }
    }

    /**
     * Real-time WebSocket monitoring for target vault fills
     * Enhanced with robust reconnection logic and health checks
     */
    static watchTraders() {
        this.initializeWebSocket();
    }

    private static initializeWebSocket() {
        try {
            // Clean up existing connections and listeners
            if (wsTransport) {
                try {
                    // Remove all event listeners before closing to prevent leaks
                    wsTransport.socket.removeAllListeners();
                    wsTransport.socket.close();
                } catch (e) {
                    // Ignore errors on close
                }
            }

            // Clear existing timers
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (healthCheckTimer) {
                clearInterval(healthCheckTimer);
                healthCheckTimer = null;
            }

            // Create new WebSocket connection
            wsTransport = new hl.WebSocketTransport();
            wsClient = new hl.SubscriptionClient({ transport: wsTransport });

            // Connection opened
            wsTransport.socket.addEventListener("open", () => {
                logger.info("🔌 COPY TRADING: WebSocket connected");
                reconnectAttempts = 0;
                lastWebSocketMessageTime = Date.now(); // Reset timestamp

                // Start health check
                this.startHealthCheck();
            });

            // Track all messages to update health check timestamp
            wsTransport.socket.addEventListener("message", () => {
                lastWebSocketMessageTime = Date.now();
            });

            // Connection closed
            wsTransport.socket.addEventListener("close", () => {
                logger.warn("❌ COPY TRADING: WebSocket disconnected");

                // Clear health check
                if (healthCheckTimer) {
                    clearInterval(healthCheckTimer);
                    healthCheckTimer = null;
                }

                // Attempt reconnect with exponential backoff
                this.scheduleReconnect();
            });

            // Connection error
            wsTransport.socket.addEventListener("error", (error) => {
                logger.error(`🚨 COPY TRADING: WebSocket error - ${error}`);
                // Don't reconnect here, wait for close event
            });

            // Subscribe to target vault fills (non-blocking)
            wsClient.userEvents({ user: COPY_TRADER }, (data) => {
                // Don't await - process in background to avoid blocking WebSocket
                this.processUserEvents(data).catch((error) => {
                    logger.error(`Error processing userEvents: ${error.message}`);
                });
            });

            logger.info(`👀 Watching target vault: ${COPY_TRADER}`);

        } catch (error: any) {
            logger.error(`Failed to initialize WebSocket: ${error.message}`);
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private static scheduleReconnect() {
        if (reconnectTimer) {
            return; // Already scheduled
        }

        reconnectAttempts++;

        // Exponential backoff: 2^n seconds, capped at MAX_RECONNECT_DELAY
        const baseDelay = 2000; // Start with 2 seconds
        const delay = Math.min(
            baseDelay * Math.pow(2, reconnectAttempts - 1),
            MAX_RECONNECT_DELAY
        );

        logger.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            logger.info(`🔄 Attempting WebSocket reconnection (attempt ${reconnectAttempts})...`);
            this.initializeWebSocket();
        }, delay);
    }

    /**
     * Health check - verify connection is still alive
     * If no messages received for 2 minutes, force reconnect
     */
    private static startHealthCheck() {
        // Check every 30 seconds
        healthCheckTimer = setInterval(() => {
            const timeSinceLastMessage = Date.now() - lastWebSocketMessageTime;

            if (timeSinceLastMessage > 120000) { // 2 minutes without messages
                logger.warn(`⚠️  WebSocket stale (no messages for ${(timeSinceLastMessage / 1000).toFixed(0)}s)`);
                logger.info(`🔄 Forcing WebSocket reconnection...`);

                // Force close and reconnect
                if (wsTransport) {
                    try {
                        wsTransport.socket.close();
                    } catch (e) {
                        // Ignore
                    }
                }
                // scheduleReconnect will be called by close event
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Process user events from WebSocket (non-blocking)
     */
    private static async processUserEvents(data: any) {
        try {
            if (data && 'fills' in data) {
                const fills = data.fills;

                // Log fills to database for TWAP detection and analysis
                // Use Promise.all with timeout to avoid blocking
                const logPromises = fills.map((fill: any) =>
                    Promise.race([
                        this.logTargetFill(fill),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Database write timeout')), 5000)
                        )
                    ]).catch((error) => {
                        logger.error(`Failed to log fill for ${fill.coin}: ${error.message}`);
                    })
                );

                await Promise.all(logPromises);
                logger.info(`📥 Target vault fill: ${fills[0].coin} ${fills[0].side} ${fills[0].sz} @ ${fills[0].px}`);
            }
        } catch (error: any) {
            logger.error(`Error in processUserEvents: ${error.message}`);
        }
    }

    /**
     * Log target vault fills to database for TWAP detection
     */
    private static async logTargetFill(fill: any) {
        try {
            await prisma.fill.create({
                data: {
                    fillId: String(fill.tid || fill.oid),
                    timestamp: new Date(fill.time),
                    traderAddress: COPY_TRADER,
                    symbol: fill.coin,
                    side: fill.side,
                    price: parseFloat(fill.px),
                    size: parseFloat(fill.sz),
                    positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
                    rawData: fill as any,
                },
            });
        } catch (error: any) {
            // Ignore duplicate errors (fills already in DB)
            if (error.code !== 'P2002') {
                logger.error(`Failed to log target fill: ${error.message}`);
            }
        }
    }
}
