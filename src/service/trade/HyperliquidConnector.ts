import * as hl from "@nktkas/hyperliquid";
import {privateKeyToAccount} from "viem/accounts";
import dotenv from "dotenv";
import {singleOrderSize, takeProfitSize, TP_SL_PER_TICKER} from "../strategies/execution-config";
import {logger} from "../utils/logger";

dotenv.config(); // Load environment variables

const TRADING_WALLET = process.env.WALLET as `0x${string}`;
const TRADING_PKEY = process.env.WALLET_PK as `0x${string}`;

export const TICKERS = {
    BTC: {
        syn: 'BTC',
        id: 0,
        leverage: 40,
        szDecimals: 5,
    },
    ETH: {
        syn: 'ETH',
        id: 1,
        leverage: 25,
        szDecimals: 4,
    },
    SOL: {
        syn: 'SOL',
        id: 5,
        leverage: 20,
        szDecimals: 2,
    },
    SUI: {
        syn: 'SUI',
        id: 14,
        leverage: 10,
        szDecimals: 1,
    },
    kPEPE: {
        syn: 'kPEPE',
        id: 15,
        leverage: 10,
        szDecimals: 0,
    },
    XRP: {
        syn: 'XRP',
        id: 25,
        leverage: 20,
        szDecimals: 0,
    },
    GOAT: {
        syn: 'GOAT',
        id: 149,
        leverage: 5,
        szDecimals: 0,
    },
    FARTCOIN: {
        syn: 'FARTCOIN',
        id: 165,
        leverage: 5,
        szDecimals: 1,
    },
    TRUMP: {
        syn: 'TRUMP',
        id: 174,
        leverage: 10,
        szDecimals: 1,
    }
}

export class HyperliquidConnector {

    static makePositionRiskNeutral(ticker, long: boolean) {
        this.getOpenPosition(TRADING_WALLET, ticker.syn).then(position => {
            if (position) {
                this.getMarket(ticker.syn).then(market => {
                    const orderInstantPrice = long ? (market * 99 / 100) : (market * 101 / 100);
                    this.getClients().wallet.order({
                        orders: [
                            {
                                a: ticker.id,
                                b: !long,
                                p: orderInstantPrice.toFixed(0).toString(),
                                s: '0',
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: position.entryPx,
                                        tpsl: "sl"
                                    },
                                },
                            }
                        ],
                        grouping: "positionTpsl",
                    }).catch(error => {
                        logger.error(error)
                    });
                });
            }
        })
    }

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

    static openOrder(ticker, long: boolean) {
        return this.getOpenPosition(TRADING_WALLET, ticker.syn).then((position) => {
            if (position) {
                logger.info('Position already exists');
                return;
            }
            return this.getPortfolio(TRADING_WALLET).then(portfolio => {
                return this.getMarket(ticker.syn).then(market => {
                    //const priceDecimals = PERPS_MAX_DECIMALS - ticker.szDecimals - 1;
                    const priceDecimals = market < 1 ? 5 : (market < 10 ? 2 : 0);
                    //for instant fill
                    const orderInstantPrice = long ? (market * 101 / 100) : (market * 99 / 100);
                    const SL = TP_SL_PER_TICKER[ticker.syn][long? 'long' : 'short'].sl
                    const TP = TP_SL_PER_TICKER[ticker.syn][long? 'long' : 'short'].tp
                    const slPrice = long ?
                        (market * (100 - (SL / ticker.leverage)) / 100) :
                        (market * (100 + (SL / ticker.leverage)) / 100);
                    const slInstantPrice = long ? (slPrice * 100.01 / 100) : (slPrice * 99.99 / 100);
                    const tpPrice = long ?
                        (market * (100 + (TP / ticker.leverage)) / 100) :
                        (market * (100 - (TP / ticker.leverage)) / 100);
                    const tpInstantPrice = long ? (tpPrice * 100.01 / 100) : (tpPrice * 99.99 / 100);
                    const sizeInAsset = portfolio.available * singleOrderSize;
                    const orderSize = (sizeInAsset * ticker.leverage)/ market;
                    const tpOrderSize = (sizeInAsset * ticker.leverage * (takeProfitSize / 100))/ market;

                    const orderInstantPriceString = orderInstantPrice.toFixed(priceDecimals).toString();
                    const slPriceString = slPrice.toFixed(priceDecimals).toString();
                    const slInstantPriceString = slInstantPrice.toFixed(priceDecimals).toString();
                    const tpPriceString = tpPrice.toFixed(priceDecimals).toString();
                    const tpInstantPriceString = tpInstantPrice.toFixed(priceDecimals).toString();

                    const orderSizeString = orderSize.toFixed(ticker.szDecimals).toString();
                    const tpOrderSizeString = tpOrderSize.toFixed(ticker.szDecimals).toString();

                    return this.getClients().wallet.order({
                        orders: [
                            //Main order
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
                            },
                            //SL
                            {
                                a: ticker.id,
                                b: !long,
                                p: slInstantPriceString,
                                s: orderSizeString,
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: slPriceString,
                                        tpsl: "sl"
                                    },
                                },
                            },
                            //TP
                            {
                                a: ticker.id,
                                b: !long,
                                p: tpInstantPriceString,
                                s: tpOrderSizeString,
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: tpPriceString,
                                        tpsl: "tp"
                                    },
                                },
                            }
                        ],
                        grouping: "normalTpsl",
                    }).catch(error => {
                        logger.error(error)
                    });
                });
            })
        });
    }

    static getOpenPositions(trader: `0x${string}`) {
        return this.getClients().public.clearinghouseState({user: trader});
    }

    static getOpenPosition(trader: `0x${string}`, tickerSyn: string) {
        return this.getClients().public.clearinghouseState({user: trader}).then(details => {
            return details.assetPositions.find(position => position.position.coin === tickerSyn)?.position;
        })
    }

    static getPerps() {
        return this.getClients().public.meta().then(perps => {
            return perps.universe;
        });
    }

    static getMarkets() {
        return this.getClients().public.allMids();
    }

    static getMarket(ticker) {
        return this.getClients().public.allMids().then(market => {
            return Number(market[ticker]);
        });
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

    static getPortfolio(trader: `0x${string}`) {
        return this.getClients().public.portfolio({user: trader}).then(portfolio => {
            const lastInHistory = portfolio[0][1].accountValueHistory.length - 1;
            const currentBalanceUSDC = portfolio[0][1].accountValueHistory[lastInHistory][1];
            return this.getOpenPositions(trader).then((positions) => {
                const balanceInPositions = positions.assetPositions.reduce((acc, position) => {
                    return Number(position.position.positionValue) / position.position.leverage.value + acc;
                }, 0);
                return {
                    portfolio: Number(currentBalanceUSDC),
                    available: Number(currentBalanceUSDC) - balanceInPositions
                } ;
            });
        })
    }

    static async considerTakingProfit(tradingPosition: {
        coin: any;
        szi?: string;
        leverage?: { type: "isolated"; value: number; rawUsd: string; } | { type: "cross"; value: number; };
        entryPx?: string;
        positionValue?: string;
        unrealizedPnl: any;
        returnOnEquity?: string;
        liquidationPx?: string;
        marginUsed: any;
        maxLeverage?: number;
        cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string; };
    }) {
        const unrealizedPnl = tradingPosition.unrealizedPnl;
        const currentValue = tradingPosition.marginUsed;
        const totalPortfolio = (await this.getPortfolio(TRADING_WALLET)).portfolio;
        if (Number(unrealizedPnl) > 0 &&
            Number(unrealizedPnl) / Number(currentValue) > 0.75 /*75% gain*/ &&
            Number(currentValue) / Number(totalPortfolio) > 0.15 /*15% of portfolio*/) {
            logger.info(`TRADING: taking profit on ${tradingPosition.coin} position`);
            await this.marketClosePosition(TICKERS[tradingPosition.coin],
                this.positionSide(tradingPosition) === 'long', 0.3);
        }
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
        const viemClient = new hl.ExchangeClient({wallet: viemAccount, transport});
        const client = new hl.InfoClient({transport});
        return {
            public: client,
            wallet: viemClient
        };
    }


}
