import Taapi from "taapi";
import { getSignalH1, type IndicatorRow, type Symbol } from "../utils/smart-signal";
import {
    REVERSAL_1H,
    RISK_1H,
} from "./execution-config";
import { HyperliquidConnector, TICKERS } from "../trade/HyperliquidConnector";
import { logger } from "../utils/logger";
import moment from "moment/moment";
import dotenv from "dotenv";
import * as hl from "@nktkas/hyperliquid";

dotenv.config(); // Load environment variables
const TRADING_WALLET = process.env.WALLET as `0x${string}`;
const taapi = new Taapi(process.env.TAAPI_SECRET);

export function subscribeToEvents() {
    const transport = new hl.WebSocketTransport();
    const client = new hl.SubscriptionClient({ transport });
    client.userFills({ user: TRADING_WALLET }, (data) => {
        const pnlByCoin: Record<string, number> = {};
        const feeByCoin: Record<string, number> = {};
        const priceByCoin: Record<string, number> = {};
        const directionByCoin: Record<string, string> = {};
        for (const fill of data.fills) {
            if (fill.time >= Date.now() - 10 * 60 * 1000) {
                pnlByCoin[fill.coin] = (pnlByCoin[fill.coin] ?? 0) + Number(fill.closedPnl) - Number(fill.fee);
                feeByCoin[fill.coin] = (feeByCoin[fill.coin] ?? 0) + Number(fill.fee);
                priceByCoin[fill.coin] = Number(fill.px);  // just last price if many fills
                directionByCoin[fill.coin] = fill.dir;  // just last direction
            }
        }
        for (const coin in pnlByCoin) {
            logger.info(`[1H] TRADE ${coin} ${directionByCoin[coin]}`, { fee: feeByCoin[coin], Pnl: pnlByCoin[coin], price: priceByCoin[coin]});
            if (feeByCoin[coin] != Math.abs(pnlByCoin[coin])) {
                //TP or SL
                updateLossStreak(coin as Symbol, pnlByCoin[coin]);
            }
        }
    });
}

function fetchLast10H1(ticker: Symbol, interval: string): Promise<IndicatorRow[]> {
    taapi.resetBulkConstructs();
    taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 10});
    taapi.addCalculation("stochrsi", `${ticker}/USDT`, interval, `stochrsi_${interval}`, {"results": 10});
    taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 10});

    return HyperliquidConnector.candleSnapshot1h(ticker, 10).then((candles) => {
        return taapi.executeBulk().then(indicators => {
            // Process the data and update our data structure
            const rsiValues = indicators[`rsi_${interval}`].value;
            const stochRsiValues = indicators[`stochrsi_${interval}`].valueFastK;
            const aoValues = indicators[`ao_${interval}`].value;

            // Create data points from the API responses
            const newDataPoints: IndicatorRow[] = [];

            // Loop through up to 10 most recent candles
            for (let i = 0; i < Math.min(10, candles.length); i++) {
                const candle = candles[i];
                newDataPoints.push({
                    time: moment(candle.T).toISOString(),
                    close: parseFloat(candle.c),
                    AO: aoValues[i].toFixed(1),
                    RSI: rsiValues[i].toFixed(1),
                    SRSI: stochRsiValues[i].toFixed(1),
                });
            }
            return newDataPoints;
        }).catch(error => {
            logger.error('Error when getting indicators, trying again in 20 seconds');
            return fetchLast10H1(ticker, interval);
        });
    });
}

function sideFromAction(action: "buy" | "sell" | "hold"): "long" | "short" | "flat" {
    if (action === "buy") return "long";
    if (action === "sell") return "short";
    return "flat";
}

function positionSide(pos: any): "long" | "short" | "flat" {
    if (!pos) return "flat";
    return HyperliquidConnector.positionSide(pos); // your helper: 'long' | 'short'
}

function withinBp(a: number, b: number, maxBp: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const drift = Math.abs((a / b - 1) * 10000); // basis points
    return drift <= maxBp;
}

// Optional: in-memory cooldown tracker
const lossStreak: Record<string, number> = {}; // key: `${symbol}:${side}`

function keySS(sym: Symbol, side: "long"|"short") { return `${sym}:${side}`; }

// When a position closes and you know its realized PnL:
function updateLossStreak(symbol: "BTC" | "ETH", pnl: number) {
    if (pnl < 0) {
        lossStreak[symbol] = (lossStreak[symbol] || 0) + 1;
    } else {
        lossStreak[symbol] = 0; // reset on any win or break-even
    }
}

export async function runMainStrategy1h(symbols: Symbol[]) {
    for (const symbol of symbols) {
        try {
            const last10 = await fetchLast10H1(symbol, '1h');
            const signal = getSignalH1(symbol, last10, { returnDebug: true });

            // Hard parse guard
            if (!Number.isFinite(signal.confidence)) continue;

            const desiredSide = sideFromAction(signal.action);
            const score = signal.debug?.score ?? 0;
            // Logging
            const dbg = {
                symbol, desiredSide,
                confidence: signal.confidence,
                score,
                volZ1h: signal.debug?.volZ1h,
                feats: signal.debug?.feats,
                closes: signal.debug?.closes,
                ts: new Date().toISOString(),
            };

            if (desiredSide === "flat") {
                logger.info(`[1H] HOLDING ${symbol} action=${signal.action} actionReason=${signal.actionReason} conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);
                continue;
            }

            // Cooldown gating
            const streakKey = keySS(symbol, desiredSide);
            const extraScore = (lossStreak[streakKey] ?? 0) >= 2 ? RISK_1H.COOLDOWN_SCORE_BONUS : 0;
            const buyLimitH1 = symbol === "BTC" ? 30 : 28;
            const sellLimitH1 = symbol === "BTC" ? -10 : -8;
            const passScore =
                desiredSide === "long" ? score >= (buyLimitH1 + extraScore)
                    : score <= (sellLimitH1 - extraScore);
            if (!passScore) {
                logger.info(`[1H] REJECTED ${symbol} by score cooldown gate. conf=${signal.confidence} score=${score} extra=${extraScore} json=${JSON.stringify(dbg)}`);
                continue;
            }

            // One-position rule
            const pos = await HyperliquidConnector.getOpenPosition(TRADING_WALLET, symbol);
            const posSide = positionSide(pos);

            // Reversal policy: only flip if close to entry and strong opposite evidence
            if (posSide !== "flat" && posSide !== desiredSide && REVERSAL_1H.ENABLED) {
                const lastPrice = last10[9].close;
                const entryPx = pos ? Number(pos.entryPx) : NaN;
                const strong = signal.confidence >= REVERSAL_1H.MIN_CONF;
                const nearEntry = withinBp(lastPrice, entryPx, REVERSAL_1H.MAX_ENTRY_DRIFT_BP);
                if (strong && nearEntry) {
                    logger.info(`[1H] REVERSAL ${symbol} ${posSide} -> ${desiredSide}, close & flip. conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);
                    await HyperliquidConnector.marketClosePosition(TICKERS[symbol], posSide === "long");
                    await HyperliquidConnector.openOrder(TICKERS[symbol], desiredSide === "long");
                    continue;
                } else {
                    // Hold existing; do not add
                    logger.info(`[1H] REVERSAL ${symbol}  ${posSide} CONSIDERED BUT NOT STRONG. conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);
                    continue;
                }
            }

            // Already in same-side? Don't add.
            if (posSide === desiredSide) {
                logger.info(`[1H] HOLDING ${symbol} ALREADY ${desiredSide.toUpperCase()} conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);
                continue;
            }

            logger.info(`[1H] OPENING ${symbol} ${desiredSide.toUpperCase()} conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);

            // Open new position
            await HyperliquidConnector.openOrder(TICKERS[symbol], desiredSide === "long");

        } catch (e: any) {
            logger.error(`[1H] ${symbol} error: ${e?.message || String(e)}`);
        }
    }
}
