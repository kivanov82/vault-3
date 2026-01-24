// logger.ts
// Lightweight logger that prints human text + stable JSON tail for parsing.
// Usage: logger.info("message", { any: "context" })

type Level = "info" | "warn" | "error" | "debug";

function ts() {
    return new Date().toISOString();
}

function base(level: Level, msg: string, ctx?: Record<string, any>) {
    const line = `[${ts()}] ${level.toUpperCase()} ${msg}`;
    if (ctx && Object.keys(ctx).length) {
        // keep the machine-readable tail consistent: json={...}
        // do not include functions/undefined
        const safe: Record<string, any> = {};
        for (const [k, v] of Object.entries(ctx)) {
            if (v === undefined) continue;
            if (typeof v === "function") continue;
            try { JSON.stringify(v); safe[k] = v; } catch { /* skip unserializable */ }
        }
        // print single line for easy ingestion
        // example: ... json={"symbol":"BTC","confidence":72,"score":31}
        // DO NOT add commas after json=... to avoid tail parsing issues
        // If you want a file logger, redirect stdout of the process.
        // (Keeping this dependency-free and portable.)
        // eslint-disable-next-line no-console
        console.log(`${line} json=${JSON.stringify(safe)}`);
        return;
    }
    // eslint-disable-next-line no-console
    console.log(line);
}

export const logger = {
    info: (msg: string, ctx?: Record<string, any>) => base("info", msg, ctx),
    warn: (msg: string, ctx?: Record<string, any>) => base("warn", msg, ctx),
    error: (msg: string, ctx?: Record<string, any>) => base("error", msg, ctx),
    debug: (msg: string, ctx?: Record<string, any>) => {
        if (process.env.DEBUG?.toLowerCase() === "true") base("debug", msg, ctx);
    },
};

// Optional: create child loggers with prebound context
export function childLogger(bind: Record<string, any>) {
    const wrap = (lvl: Level) => (msg: string, ctx?: Record<string, any>) =>
        logger[lvl](
            msg,
            ctx ? { ...bind, ...ctx } : { ...bind }
        );
    return {
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
        debug: wrap("debug"),
    };
}
