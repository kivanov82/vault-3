import {MIN_CONF_ALL, VOL_GATES} from "../strategies/execution-config";

export type Symbol = "BTC" | "ETH";

export interface IndicatorRow {
    time: string;  // ISO or "YYYY-MM-DDTHH:mm:ssZ"
    close: number;
    AO: number;
    RSI: number;   // 0..100
    SRSI: number;  // 0..100
}

export interface SignalResult {
    action: "buy" | "sell" | "hold";
    actionReason: string; // for logging/analysis
    confidence: number; // 0..100
    debug?: Record<string, any>;
}

export function getSignalH1(
    symbol: Symbol,
    last10: IndicatorRow[],
    opts?: { returnDebug?: boolean }
): SignalResult {
    if (!Array.isArray(last10) || last10.length !== 10) {
        throw new Error("Provide exactly 10 rows of 1h indicators.");
    }

    // ---------- helpers ----------
    const closes = last10.map(r => r.close);
    const ao = last10.map(r => r.AO);
    const rsi = last10.map(r => r.RSI);
    const srsi = last10.map(r => r.SRSI);

    const diff = (arr: number[]) => arr.map((v,i)=> i===0 ? NaN : v - arr[i-1]);
    const mean = (a: number[]) => (a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0);
    const stdev = (a: number[]) => {
        if (!a.length) return 0;
        const m = mean(a);
        return Math.sqrt(mean(a.map(v => (v-m)**2)));
    };

    // H1 slopes: short and reactive
    const aoSlopeN   = mean(diff(ao).slice(-3).filter(Number.isFinite));   // 3 deltas
    const rsiSlopeN  = mean(diff(rsi).slice(-3).filter(Number.isFinite));
    const srsiSlopeN = mean(diff(srsi).slice(-3).filter(Number.isFinite));

    // AO zero-cross (last 2 hours)
    const aoZeroCrossUp =
        ao.slice(-2).some((v,i,a)=> i>0 && a[i-1] <= 0 && v > 0);
    const aoZeroCrossDown =
        ao.slice(-2).some((v,i,a)=> i>0 && a[i-1] >= 0 && v < 0);

    // Structure over last 6 H1 bars (using close as proxy)
    let higherHighs = 0, higherLows = 0;
    const start = 10 - 6; // lookback 6 bars
    for (let i = start + 1; i < 10; i++) {
        if (closes[i] > closes[i-1]) higherHighs++;
        if (closes[i] > closes[i-1]) higherLows++;
    }

    // Momentum(2)
    const mom2 = closes[9] - closes[7];

    // Realized vol on H1 (returns)
    const rets = diff(closes).slice(1).map((d,i)=> d / closes[i]);
    const vol10 = stdev(rets);
    // H1 baseline: ~0.8% for majors
    const symBoost = symbol === "ETH" ? 1.06 : 1.0;
    const volZ1h = (vol10 / 0.008) * symBoost;

    // ---------- feature scores (−100..+100) ----------
    let score = 0;
    const feats: Record<string, number> = {};

    // 1) AO regime/trend/cross
    const aoLevel = ao[9];
    const aoBull = aoLevel > 0 ? 1 : (aoLevel < 0 ? -1 : 0);
    const aoTrend = aoSlopeN > 0 ? 1 : (aoSlopeN < 0 ? -1 : 0);
    feats.aoRegime = 24 * aoBull;
    feats.aoTrend  = 22 * aoTrend;
    feats.aoCross  = aoZeroCrossUp ? 14 : (aoZeroCrossDown ? -14 : 0);

    // 2) RSI regime + slope
    const rsiVal = rsi[9];
    let rsiReg = 0;
    if (rsiVal >= 70) rsiReg = -22;
    else if (rsiVal >= 60) rsiReg = -6;
    else if (rsiVal >= 45 && rsiVal <= 60) rsiReg = 10;
    else if (rsiVal <= 35) rsiReg = 22;
    else rsiReg = 4;
    feats.rsiReg   = rsiReg;
    feats.rsiSlope = rsiSlopeN > 0 ? 6 : (rsiSlopeN < 0 ? -6 : 0);

    // 3) StochRSI level + trend
    const s = srsi[9];
    let srsiReg = 0;
    if (s >= 90) srsiReg = -22;
    else if (s >= 80) srsiReg = -12;
    else if (s <= 10) srsiReg = 22;
    else if (s <= 20) srsiReg = 12;
    else if (s >= 40 && s <= 60) srsiReg = 6;
    else srsiReg = 2;
    feats.srsiReg   = srsiReg;
    feats.srsiTrend = 10 * (srsiSlopeN > 0 ? 1 : (srsiSlopeN < 0 ? -1 : 0));

    // 4) Structure & momentum
    feats.structure = (higherHighs + higherLows - 5) * 2.2;
    feats.mom2      = mom2 > 0 ? 8 : (mom2 < 0 ? -8 : 0);

    // 5) Volatility sanity (don’t chase blow-offs/capitulations)
    let volAdj = 0;
    if (volZ1h > 1.6 && (rsiVal > 70 || s > 80)) volAdj -= 12; // penalize longs in blow-off
    if (volZ1h > 1.6 && (rsiVal < 30 || s < 20)) volAdj += 8;   // reward rebound long; mirror logic captured by sign
    feats.volAdj = volAdj;

    // Aggregate
    for (const k of Object.keys(feats)) score += feats[k];

    // ---------- decision ----------
    let action: "buy" | "sell" | "hold" = "hold";
    let actionReason= "none";
    const buyLimitH1: Record<Symbol, number>  = { BTC: 30, ETH: 28 };
    const sellLimitH1: Record<Symbol, number> = { BTC: -10, ETH: -8 };

    if (score >= buyLimitH1[symbol]) {
        action = "buy";
    } else if (score <= sellLimitH1[symbol]) {
        action = "sell";
    } else {
        action = "hold";
        actionReason = "scoreOutsideBuySellLimit";
    }

    // Confidence (softclip, min higher for H1)
    const softclip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const confMin: Record<Symbol, number> = { BTC: 60, ETH: 58 };
    const confidence = softclip(Math.round(50 + (Math.abs(score) / 80) * 50), confMin[symbol], 100);

    let minConf = MIN_CONF_ALL;
    //Adjust minimum confidence requirement
    if (symbol === "ETH" && volZ1h > VOL_GATES.ETH.highVolZ) {
        minConf = VOL_GATES.ETH.minConfHighVol;
    }
    //volume-based gating
    if (symbol === "BTC" && volZ1h > VOL_GATES.BTC.maxVolZ) {
        action = "hold"; // override
        actionReason = "highVol";
    } else  if (confidence < minConf) {
        action = "hold"; // override
        actionReason = "lowConfidence";
    }

    return {
        action,
        actionReason,
        confidence,
        ...(opts?.returnDebug
            ? { debug: {
                    score,
                    feats,
                    aoLevel, aoSlopeN,
                    rsiVal, srsiVal: s,
                    vol10, volZ1h,
                    higherHighs, higherLows,
                    closes: closes.join(',')
                } }
            : undefined)
    };
}
