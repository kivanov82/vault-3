import dotenv from "dotenv";
import * as hl from "@nktkas/hyperliquid";
import {HyperliquidConnector, TICKERS} from "./HyperliquidConnector";
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

// Database
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Track last scan time for latency calculation
const tradeStartTimes = new Map<string, number>();

// WebSocket reconnection state
let wsTransport: hl.WebSocketTransport | null = null;
let wsClient: hl.SubscriptionClient | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

export class CopyTradingManager {

    /**
     * Position-based scanning - polls every 30 seconds to sync positions
     * This is resilient to TWAP orders since we compare final states, not individual fills
     */
    static async scanTraders() {
        const scanStartTime = Date.now();

        try {
            // Get both vault portfolios to calculate scaling factor
            const [targetPortfolio, ourPortfolio, targetPositions] = await Promise.all([
                HyperliquidConnector.getPortfolio(COPY_TRADER),
                HyperliquidConnector.getPortfolio(WALLET),
                HyperliquidConnector.getOpenPositions(COPY_TRADER),
            ]);

            // Calculate scaling factor based on vault sizes
            const scaleFactor = COPY_MODE === 'exact' ? 1.0 :
                                (ourPortfolio.portfolio / targetPortfolio.portfolio);

            logger.info(`📊 Copy Trading Scan (Scale: ${(scaleFactor * 100).toFixed(1)}%)`);

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

            logger.info(`🔍 Checking ${allSymbols.length} symbols (${targetSymbols.length} target, ${ourSymbols.length} ours)`);

            // Process each symbol
            for (const symbol of allSymbols) {
                try {
                    await this.syncPosition(symbol, scaleFactor, scanStartTime);
                } catch (e: any) {
                    logger.error(`Error syncing ${symbol}: ${e.message}`);
                }
            }
        } catch (e: any) {
            logger.error(`COPY TRADING: Scan failed - ${e.message}`);
        }
    }

    /**
     * Sync a single position with the target vault
     */
    private static async syncPosition(ticker: string, scaleFactor: number, scanStartTime: number) {
        // Check if ticker is in our config, if not, log warning but continue
        const tickerConfig = TICKERS[ticker];
        if (!tickerConfig) {
            logger.warn(`⚠️  ${ticker}: Not in TICKERS config - will use dynamic config`);
            // We'll need to fetch ticker metadata from Hyperliquid
            // For now, skip unsupported tickers
            return;
        }

        // Get positions from both vaults
        const [targetPosition, ourPosition] = await Promise.all([
            HyperliquidConnector.getOpenPosition(COPY_TRADER, ticker),
            HyperliquidConnector.getOpenPosition(WALLET, ticker),
        ]);

        const targetSide = targetPosition ? HyperliquidConnector.positionSide(targetPosition) : 'none';
        const ourSide = ourPosition ? HyperliquidConnector.positionSide(ourPosition) : 'none';
        const targetSize = targetPosition ? Math.abs(Number(targetPosition.szi)) : 0;
        const ourSize = ourPosition ? Math.abs(Number(ourPosition.szi)) : 0;
        const targetLeverage = targetPosition?.leverage?.value || 1;

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
            const sizeThreshold = targetSizeForUs * 0.1; // 10% tolerance

            if (sizeDiff > sizeThreshold) {
                positionDelta.needsAction = true;
                positionDelta.action = 'adjust';
            } else {
                // Positions match, check for take profit
                await HyperliquidConnector.considerTakingProfit(ourPosition);
            }
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
        const { symbol, action, targetSide, ourSide, targetSizeForUs, targetLeverage } = delta;
        const isLong = targetSide === 'long';

        logger.info(`🔄 ${symbol}: ${action.toUpperCase()} (Target: ${targetSide} ${targetLeverage}x, Ours: ${ourSide})`);

        // Track trade start time for latency measurement
        const tradeKey = `${symbol}_${scanStartTime}`;
        tradeStartTimes.set(tradeKey, Date.now());

        try {
            const market = await HyperliquidConnector.getMarket(symbol);
            const positionValueUSD = targetSizeForUs * market;

            // Only check minimum position size
            if (positionValueUSD < MIN_POSITION_SIZE_USD) {
                logger.warn(`⚠️  ${symbol}: Position size $${positionValueUSD.toFixed(2)} below minimum $${MIN_POSITION_SIZE_USD}, skipping`);
                return;
            }

            logger.info(`💰 ${symbol}: Position value $${positionValueUSD.toFixed(2)}, Leverage ${targetLeverage}x`);

            // Execute the action
            switch (action) {
                case 'close':
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long');
                    await this.logCopyTrade(symbol, 'close', ourSide, 0, market, targetLeverage, scanStartTime);
                    break;

                case 'open':
                    await HyperliquidConnector.openOrder(tickerConfig, isLong);
                    await this.logCopyTrade(symbol, 'open', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    break;

                case 'flip':
                    // Close current position
                    await HyperliquidConnector.marketClosePosition(tickerConfig, ourSide === 'long');
                    // Wait a bit for close to settle
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    // Open new position
                    await HyperliquidConnector.openOrder(tickerConfig, isLong);
                    await this.logCopyTrade(symbol, 'flip', targetSide, targetSizeForUs, market, targetLeverage, scanStartTime);
                    break;

                case 'adjust':
                    // For now, we don't adjust position sizes (too risky with partial closes/adds)
                    // In Phase 2, we can implement incremental adjustments
                    logger.info(`ℹ️  ${symbol}: Size adjustment skipped (Phase 2 feature)`);
                    break;
            }

            logger.info(`✅ ${symbol}: ${action} executed successfully`);
        } catch (error: any) {
            logger.error(`❌ ${symbol}: ${action} failed - ${error.message}`);
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

            logger.info(`💾 ${symbol}: Trade logged (latency: ${latencyMs}ms, leverage: ${leverage}x)`);
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
            // Clean up existing connections
            if (wsTransport) {
                try {
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
                reconnectAttempts = 0; // Reset reconnect counter on successful connection

                // Start health check
                this.startHealthCheck();
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

            // Subscribe to target vault fills
            wsClient.userEvents({ user: COPY_TRADER }, async (data) => {
                try {
                    if (data && 'fills' in data) {
                        const fills = data.fills;

                        // Log fills to database for TWAP detection and analysis
                        for (const fill of fills) {
                            await this.logTargetFill(fill);
                        }

                        logger.info(`📥 Target vault fill: ${fills[0].coin} ${fills[0].side} ${fills[0].sz} @ ${fills[0].px}`);
                    }
                } catch (error: any) {
                    logger.error(`Error processing userEvents: ${error.message}`);
                }
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
     * If no messages received for 60 seconds, force reconnect
     */
    private static startHealthCheck() {
        let lastMessageTime = Date.now();

        // Update timestamp on any message
        if (wsTransport) {
            wsTransport.socket.addEventListener("message", () => {
                lastMessageTime = Date.now();
            });
        }

        // Check every 30 seconds
        healthCheckTimer = setInterval(() => {
            const timeSinceLastMessage = Date.now() - lastMessageTime;

            if (timeSinceLastMessage > 120000) { // 2 minutes without messages
                logger.warn(`⚠️  WebSocket health check failed (no messages for ${(timeSinceLastMessage / 1000).toFixed(0)}s)`);
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
            } else {
                logger.debug(`💓 WebSocket healthy (last message ${(timeSinceLastMessage / 1000).toFixed(0)}s ago)`);
            }
        }, 30000); // Check every 30 seconds
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
