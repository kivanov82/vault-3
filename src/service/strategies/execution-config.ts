export const TP_SL_PER_TICKER = {
    BTC: { long: { tp: 40, sl: 25 }, short: { tp: 40, sl: 25 } },
    ETH: { long: { tp: 35, sl: 22 }, short: { tp: 35, sl: 22 } },
} as const;

export const singleOrderSize = 0.3;
export const takeProfitSize = 100;  // %

export const MIN_CONF_ALL = 60;            // base confidence floor for any entry
export const VOL_GATES = {
  BTC: { maxVolZ: 0.80 },                  // if volZ1h > 0.80 → HOLD on BTC
  ETH: { highVolZ: 0.60, minConfHighVol: 65 } // if volZ1h > 0.60 → require conf ≥ 65 on ETH
};

// Reversal policy for H1: only near-entry and strong confluence
export const REVERSAL_1H = {
    ENABLED: true,
    MIN_CONF: 80,
    MIN_SCORE_DELTA: 12,     // opposite score must beat current by ≥ 12
    MAX_ENTRY_DRIFT_BP: 15,  // 0.15% distance from entry
};

// Risk policy (executor decides TP/SL/hold-time if you want it here)
export const RISK_1H = {
    ONE_POSITION_PER_SYMBOL: true,
    COOLDOWN_AFTER_2_LOSSES_HOURS: 72,
    COOLDOWN_SCORE_BONUS: 5,  // require +5 score during cooldown
    VOLZ_HOT: 1.6,            // used for logging / optional sizing
};
