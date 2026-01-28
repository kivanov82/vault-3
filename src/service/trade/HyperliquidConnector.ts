import * as hl from "@nktkas/hyperliquid";
import {privateKeyToAccount} from "viem/accounts";
import dotenv from "dotenv";
import {logger} from "../utils/logger";

dotenv.config(); // Load environment variables

const TRADING_WALLET = process.env.WALLET as `0x${string}`;
const TRADING_PKEY = process.env.WALLET_PK as `0x${string}`;

export class HyperliquidConnector {
    // Singleton clients - reuse instead of creating new ones on each call
    private static clientsInstance: {
        public: hl.InfoClient;
        wallet: hl.ExchangeClient<any>;
    } | null = null;

    static marketClosePosition(ticker, long: boolean, percent: number = 1, marketPrice?: number) {
        return this.getOpenPosition(TRADING_WALLET, ticker.syn).then(async position => {
            if (position && ((this.positionSide(position) === 'long' && long) || (this.positionSide(position) === 'short' && !long))) {
                // Use provided market price or fetch if not provided
                const market = marketPrice ?? await this.getMarket(ticker.syn);
                const priceDecimals = market < 1 ? 5 : (market < 10 ? 2 : 0);
                // 2% slippage for instant fill (increased from 1% to handle thin orderbooks)
                const orderInstantPrice = long ? (market * 0.98) : (market * 1.02);
                const orderInstantPriceString = orderInstantPrice.toFixed(priceDecimals).toString();
                const orderSize = Math.abs(Number(position.szi) * percent);
                const orderSizeString = orderSize.toFixed(ticker.szDecimals).toString();
                return this.getClients().wallet.order({
                    orders: [
                        {
                            a: ticker.id,
                            b: !long,
                            p: orderInstantPriceString,
                            s: orderSizeString,
                            r: true,   // reduce-only
                            t: {
                                limit: {
                                    tif: 'FrontendMarket'
                                }
                            }
                        }
                    ],
                    grouping: "na",
                }).catch(error => {
                    logger.error(error)
                });
            }
        });
    }

    /**
     * Open a copy position with specified size and leverage (no TP/SL)
     * Used for copytrading where we match target vault's positions exactly
     * @param allowAddToExisting - If true, allows adding to existing position (for rebalancing)
     * @param marketPrice - Optional pre-fetched market price to avoid API call
     */
    static async openCopyPosition(ticker: any, long: boolean, size: number, leverage: number, allowAddToExisting: boolean = false, marketPrice?: number) {
        const position = await this.getOpenPosition(TRADING_WALLET, ticker.syn);
        if (position && !allowAddToExisting) {
            // Silent return - position already exists (not an error)
            return;
        }

        // Use provided market price or fetch if not provided
        const market = marketPrice ?? await this.getMarket(ticker.syn);
        const priceDecimals = market < 1 ? 5 : (market < 10 ? 2 : 0);

        // Set leverage first (Cross margin mode) - only if opening new position or leverage changed
        if (!position || position.leverage.value !== leverage) {
            try {
                await this.getClients().wallet.updateLeverage({
                    asset: ticker.id,
                    isCross: true,
                    leverage: leverage
                });
                // Wait for leverage update to propagate
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error: any) {
                logger.error(`❌ ${ticker.syn}: Leverage ${leverage}x failed - ${error.message}`);
                throw error;
            }
        }

        // Get actual withdrawable amount and cap size to what we can afford
        const portfolio = await this.getPortfolio(TRADING_WALLET);
        const maxPositionValue = portfolio.available * leverage * 0.95; // 95% of max to leave buffer
        const targetPositionValue = size * market;

        let actualSize = size;
        if (targetPositionValue > maxPositionValue) {
            actualSize = (maxPositionValue / market);
            logger.warn(`⚠️  ${ticker.syn}: Capping size from ${size.toFixed(ticker.szDecimals)} to ${actualSize.toFixed(ticker.szDecimals)} (available margin: $${portfolio.available.toFixed(2)})`);
        }

        // Place market order for instant fill with 2% slippage (increased from 1% to handle thin orderbooks)
        const orderInstantPrice = long ? (market * 1.02) : (market * 0.98);
        const orderInstantPriceString = orderInstantPrice.toFixed(priceDecimals).toString();
        const orderSizeString = actualSize.toFixed(ticker.szDecimals).toString();

        // Removed verbose order log - consolidated into execution result

        return this.getClients().wallet.order({
            orders: [
                {
                    a: ticker.id,
                    b: long,
                    p: orderInstantPriceString,
                    s: orderSizeString,
                    r: false,   // Not reduce-only
                    t: {
                        limit: {
                            tif: 'FrontendMarket'
                        }
                    }
                }
            ],
            grouping: "na",
        }).catch(error => {
            logger.error(error);
            throw error;
        });
    }


    static async getOpenPositions(trader: `0x${string}`) {
        return Promise.race([
            this.getClients().public.clearinghouseState({user: trader}),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('getOpenPositions timeout')), 20000) // 20s for batch fetch
            )
        ]);
    }

    static async getOpenPosition(trader: `0x${string}`, tickerSyn: string) {
        return Promise.race([
            this.getClients().public.clearinghouseState({user: trader}).then(details => {
                return details.assetPositions.find(position => position.position.coin === tickerSyn)?.position;
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('getOpenPosition timeout')), 10000)
            )
        ]);
    }

    static getPerps() {
        return this.getClients().public.meta().then(perps => {
            return perps.universe;
        });
    }

    static getMarkets() {
        return this.getClients().public.allMids();
    }

    static async getMarket(ticker): Promise<number> {
        return Promise.race([
            this.getClients().public.allMids().then(market => {
                return Number(market[ticker]);
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('getMarket timeout')), 10000)
            )
        ]);
    }

    static candleSnapshot1h(ticker, count) {
        return this.getClients().public.candleSnapshot({
            coin: ticker,
            interval: "1h",
            startTime: Date.now() - 1000 * 60 * (60 * count - 3)
        }).then(candles => {
            return candles;
        });
    }

    static async getPortfolio(trader: `0x${string}`): Promise<{portfolio: number, available: number}> {
        return Promise.race([
            this.getClients().public.clearinghouseState({user: trader}).then(state => {
                return {
                    portfolio: Number(state.marginSummary.accountValue),
                    available: Number(state.withdrawable)  // Use Hyperliquid's actual withdrawable amount
                };
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('getPortfolio timeout')), 20000) // 20s for batch fetch
            )
        ]);
    }

    static positionSide(position) {
        return Number(position.entryPx) > Number(position.liquidationPx) ? 'long' : 'short';
    }

    static getClients() {
        // Return cached clients if they exist (singleton pattern)
        if (this.clientsInstance) {
            return this.clientsInstance;
        }

        // Create new clients only once
        const transport = new hl.HttpTransport({
            timeout: 30000, // 30 second timeout for ALL HTTP requests (CRITICAL FIX)
            server: {
                mainnet: {
                    rpc: 'https://rpc.hyperlend.finance',
                }
            }
        });
        const viemAccount = privateKeyToAccount(TRADING_PKEY);
        const viemClient = new hl.ExchangeClient({
            wallet: viemAccount,
            transport,
            defaultVaultAddress: TRADING_WALLET
        });
        const client = new hl.InfoClient({transport});

        this.clientsInstance = {
            public: client,
            wallet: viemClient
        };

        return this.clientsInstance;
    }


}
