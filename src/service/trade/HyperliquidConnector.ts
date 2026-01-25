import * as hl from "@nktkas/hyperliquid";
import {privateKeyToAccount} from "viem/accounts";
import dotenv from "dotenv";
import {logger} from "../utils/logger";

dotenv.config(); // Load environment variables

const TRADING_WALLET = process.env.WALLET as `0x${string}`;
const TRADING_PKEY = process.env.WALLET_PK as `0x${string}`;

export class HyperliquidConnector {

    static marketClosePosition(ticker, long: boolean, percent: number = 1) {
        return this.getOpenPosition(TRADING_WALLET, ticker.syn).then(position => {
            if (position && ((this.positionSide(position) === 'long' && long) || (this.positionSide(position) === 'short' && !long))) {
                return this.getMarket(ticker.syn).then(market => {
                    const priceDecimals = market < 1 ? 5 : (market < 10 ? 2 : 0);
                    //for instant fill
                    const orderInstantPrice = long ? (market * 99 / 100) : (market * 101 / 100);
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
                });
            }
        });
    }

    /**
     * Open a copy position with specified size and leverage (no TP/SL)
     * Used for copytrading where we match target vault's positions exactly
     */
    static async openCopyPosition(ticker: any, long: boolean, size: number, leverage: number) {
        const position = await this.getOpenPosition(TRADING_WALLET, ticker.syn);
        if (position) {
            logger.info('Position already exists');
            return;
        }

        const market = await this.getMarket(ticker.syn);
        const priceDecimals = market < 1 ? 5 : (market < 10 ? 2 : 0);

        // Set leverage first (Cross margin mode)
        logger.info(`⚙️  ${ticker.syn}: Setting leverage to ${leverage}x Cross (asset id: ${ticker.id})`);
        try {
            const leverageResult = await this.getClients().wallet.updateLeverage({
                asset: ticker.id,
                isCross: true,
                leverage: leverage
            });
            logger.info(`✅ ${ticker.syn}: Leverage set to ${leverage}x Cross - ${JSON.stringify(leverageResult)}`);

            // Wait for leverage update to propagate
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error: any) {
            logger.error(`❌ ${ticker.syn}: Failed to set leverage - ${error.message}`);
            throw error;
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

        // Place market order for instant fill with 1% slippage
        const orderInstantPrice = long ? (market * 1.01) : (market * 0.99);
        const orderInstantPriceString = orderInstantPrice.toFixed(priceDecimals).toString();
        const orderSizeString = actualSize.toFixed(ticker.szDecimals).toString();

        logger.info(`📝 ${ticker.syn}: ${long ? 'BUY' : 'SELL'} ${orderSizeString} @ ${orderInstantPriceString} | $${(actualSize * market).toFixed(2)} @ ${leverage}x`);

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
                setTimeout(() => reject(new Error('getOpenPositions timeout')), 10000)
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
                setTimeout(() => reject(new Error('getPortfolio timeout')), 10000)
            )
        ]);
    }

    static positionSide(position) {
        return Number(position.entryPx) > Number(position.liquidationPx) ? 'long' : 'short';
    }

    static getClients() {
        const transport = new hl.HttpTransport({
            timeout: null,
            //server: "api2"
            server: {
                mainnet: {
                    //rpc: 'https://rpc.hypurrscan.io',
                    rpc: 'https://rpc.hyperlend.finance',
                }
            }
        });
        const viemAccount = privateKeyToAccount(TRADING_PKEY);
        // Trade on behalf of the vault (WALLET is the vault address)
        const viemClient = new hl.ExchangeClient({
            wallet: viemAccount,
            transport,
            defaultVaultAddress: TRADING_WALLET  // Specify we're trading for the vault
        });
        const client = new hl.InfoClient({transport});
        return {
            public: client,
            wallet: viemClient
        };
    }


}
