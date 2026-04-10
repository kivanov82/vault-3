/**
 * Test sentiment threshold on MAJORS whitelist (BTC, ETH, SOL) — the symbols
 * where BTC macro sentiment should actually matter.
 *
 * Compares:
 *   - Current alt whitelist vs BTC/ETH/SOL whitelist
 *   - For each: baseline vs best-sentiment variants
 *   - On both in-sample and OOS windows
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { runBacktest, computeStats, DEFAULT_ENTRY_CONFIG, SimulatedTrade } from './backtest/engine';
import { DEFAULT_EXIT_CONFIG } from './backtest/strategy';
import { buildSentimentPanel } from './backtest/sentiment';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const ALT_WL = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN']; // current
const MAJORS_WL = ['BTC', 'ETH', 'SOL'];                         // proposed
const COMBINED_WL = ['BTC', 'ETH', 'SOL', 'HYPE', 'VVV', 'MON', 'FARTCOIN']; // test combined

const WINDOWS = [
  { label: 'IN-SAMPLE', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
  { label: 'OUT-SAMPLE', start: new Date('2026-03-16T00:00:00Z'), end: new Date('2026-04-10T23:59:59Z') },
];

const NOTIONAL = 100;
const LEVERAGE = 5;

const CONFIGS: Array<{ name: string; whitelist: string[]; scorer: 'v6' | 'v6_threshold'; agree?: number; disagree?: number }> = [
  // Current: alt whitelist
  { name: 'alt_v6',              whitelist: ALT_WL,      scorer: 'v6' },
  { name: 'alt_sent±5',          whitelist: ALT_WL,      scorer: 'v6_threshold', agree: 5,  disagree: 5  },
  { name: 'alt_sent±20',         whitelist: ALT_WL,      scorer: 'v6_threshold', agree: 20, disagree: 20 },
  // Majors only
  { name: 'majors_v6',           whitelist: MAJORS_WL,   scorer: 'v6' },
  { name: 'majors_sent±5',       whitelist: MAJORS_WL,   scorer: 'v6_threshold', agree: 5,  disagree: 5  },
  { name: 'majors_sent±10',      whitelist: MAJORS_WL,   scorer: 'v6_threshold', agree: 10, disagree: 10 },
  { name: 'majors_sent±15',      whitelist: MAJORS_WL,   scorer: 'v6_threshold', agree: 15, disagree: 15 },
  { name: 'majors_sent±20',      whitelist: MAJORS_WL,   scorer: 'v6_threshold', agree: 20, disagree: 20 },
  { name: 'majors_sent+15/-5',   whitelist: MAJORS_WL,   scorer: 'v6_threshold', agree: 15, disagree: 5  },
  // Combined (majors + alts)
  { name: 'combined_v6',         whitelist: COMBINED_WL, scorer: 'v6' },
  { name: 'combined_sent±10',    whitelist: COMBINED_WL, scorer: 'v6_threshold', agree: 10, disagree: 10 },
  { name: 'combined_sent+15/-5', whitelist: COMBINED_WL, scorer: 'v6_threshold', agree: 15, disagree: 5 },
];

function fmt(n: number, d = 0, sign = false): string {
  const s = n.toFixed(d);
  return sign && n >= 0 ? '+' + s : s;
}

async function runOne(cfg: typeof CONFIGS[number], windowStart: Date, windowEnd: Date, panel: any): Promise<SimulatedTrade[]> {
  return runBacktest(prisma, {
    symbols: cfg.whitelist,
    windowStart,
    windowEnd,
    leverage: LEVERAGE,
    notionalUsdPerTrade: NOTIONAL,
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG },
    scorer: cfg.scorer,
    sentimentPanel: cfg.scorer !== 'v6' ? panel : undefined,
    sentimentAgreeBoost: cfg.agree,
    sentimentDisagreePenalty: cfg.disagree,
  });
}

async function main() {
  console.log('\n🔬 Majors whitelist + sentiment sweep\n');

  const panels = new Map<string, any>();
  for (const w of WINDOWS) panels.set(w.label, await buildSentimentPanel(prisma, w.start, w.end));

  const rows: Array<{ cfg: typeof CONFIGS[number]; inStats: ReturnType<typeof computeStats>; oosStats: ReturnType<typeof computeStats> }> = [];

  for (const cfg of CONFIGS) {
    const inTrades = await runOne(cfg, WINDOWS[0].start, WINDOWS[0].end, panels.get('IN-SAMPLE'));
    const oosTrades = await runOne(cfg, WINDOWS[1].start, WINDOWS[1].end, panels.get('OUT-SAMPLE'));
    rows.push({ cfg, inStats: computeStats(inTrades), oosStats: computeStats(oosTrades) });
  }

  console.log('\n' + '═'.repeat(135));
  console.log('MAJORS WHITELIST + SENTIMENT THRESHOLD SWEEP');
  console.log('═'.repeat(135));
  console.log(
    'Config'.padEnd(22) +
    '│ WL      ' +
    '│ IN '.padStart(5) + 'trades'.padStart(8) + ' WR'.padStart(5) + ' P&L$'.padStart(9) + ' DD%'.padStart(7) +
    ' │ OOS'.padStart(6) + ' trades'.padStart(8) + ' WR'.padStart(5) + ' P&L$'.padStart(9) + ' DD%'.padStart(7) +
    ' │ Σ$'.padStart(6)
  );
  console.log('─'.repeat(135));
  for (const r of rows) {
    const wl = r.cfg.whitelist.length === 3 ? 'majors' : r.cfg.whitelist.length === 6 ? 'alts' : 'combined';
    const sum = r.inStats.totalPnl + r.oosStats.totalPnl;
    console.log(
      r.cfg.name.padEnd(22) +
      '│ ' + wl.padEnd(8) +
      '│ '.padStart(5) +
      r.inStats.totalTrades.toString().padStart(8) +
      (r.inStats.winRate.toFixed(0) + '%').padStart(5) +
      fmt(r.inStats.totalPnl, 0, true).padStart(9) +
      (fmt(r.inStats.maxDrawdownPct, 0) + '%').padStart(7) +
      ' │ '.padStart(6) +
      r.oosStats.totalTrades.toString().padStart(8) +
      (r.oosStats.winRate.toFixed(0) + '%').padStart(5) +
      fmt(r.oosStats.totalPnl, 0, true).padStart(9) +
      (fmt(r.oosStats.maxDrawdownPct, 0) + '%').padStart(7) +
      ' │ '.padStart(6) +
      fmt(sum, 0, true).padStart(6)
    );
  }

  // Best combined
  console.log('\n' + '═'.repeat(135));
  console.log('WINNERS');
  console.log('═'.repeat(135));
  const bestIn = rows.reduce((b, r) => r.inStats.totalPnl > b.inStats.totalPnl ? r : b);
  const bestOos = rows.reduce((b, r) => r.oosStats.totalPnl > b.oosStats.totalPnl ? r : b);
  const bestSum = rows.reduce((b, r) =>
    (r.inStats.totalPnl + r.oosStats.totalPnl) > (b.inStats.totalPnl + b.oosStats.totalPnl) ? r : b);
  const bestBothPositive = rows.filter((r) => r.inStats.totalPnl > 0 && r.oosStats.totalPnl > 0)
    .reduce((b, r) => (r.inStats.totalPnl + r.oosStats.totalPnl) > (b ? b.inStats.totalPnl + b.oosStats.totalPnl : -Infinity) ? r : b, null as any);

  console.log(`  Best in-sample:  ${bestIn.cfg.name.padEnd(22)} $${fmt(bestIn.inStats.totalPnl, 0, true)}`);
  console.log(`  Best OOS:        ${bestOos.cfg.name.padEnd(22)} $${fmt(bestOos.oosStats.totalPnl, 0, true)}`);
  console.log(`  Best combined:   ${bestSum.cfg.name.padEnd(22)} $${fmt(bestSum.inStats.totalPnl + bestSum.oosStats.totalPnl, 0, true)}`);
  if (bestBothPositive) {
    console.log(`  Best both positive: ${bestBothPositive.cfg.name.padEnd(22)} in=$${fmt(bestBothPositive.inStats.totalPnl, 0, true)} oos=$${fmt(bestBothPositive.oosStats.totalPnl, 0, true)}`);
  } else {
    console.log(`  Best both positive: NONE — no config wins both windows`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); await pool.end(); process.exit(1); });
