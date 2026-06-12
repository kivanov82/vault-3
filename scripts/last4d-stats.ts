/**
 * Last-N-day trading stats: copy (per target) + independent.
 * Usage: npx tsx scripts/last4d-stats.ts [days]
 */
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as hl from '@nktkas/hyperliquid';

const DAYS = Number(process.argv[2] || 4);
const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;

const VAULT = '0xc94376c6e3e85dfbe22026d9fe39b000bcf649f0' as const;
const TARGETS: { addr: `0x${string}`; name: string }[] = [
  { addr: '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768', name: 'Bitcoin MA (b1505)' },
  { addr: '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0', name: 'Archangel  (8c7bd)' },
  { addr: '0xbd9c944dcfb31cd24c81ebf1c974d950f44e42b8', name: 'NIE wallet (bd9c)' },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const fmtUsd = (n: number) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

type Fill = {
  time: number;
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B'; // A=sell, B=buy
  dir?: string;    // "Open Long", "Close Short", etc.
  closedPnl?: string;
  fee?: string;
};

async function fetchAllFills(info: hl.InfoClient, user: `0x${string}`, startTime: number): Promise<Fill[]> {
  const out: Fill[] = [];
  let cursor = startTime;
  for (let page = 0; page < 20; page++) {
    const batch = (await info.userFillsByTime({ user, startTime: cursor, aggregateByTime: false })) as any[];
    if (batch.length === 0) break;
    out.push(...(batch as Fill[]));
    if (batch.length < 2000) break;
    cursor = Math.max(...batch.map(f => f.time)) + 1;
    await new Promise(r => setTimeout(r, 350));
  }
  // dedupe by tid/oid+time
  const seen = new Set<string>();
  return out.filter(f => {
    const key = `${(f as any).tid ?? (f as any).oid}-${f.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.time - b.time);
}

function dirToSide(dir?: string): 'long' | 'short' | null {
  if (!dir) return null;
  if (dir.includes('Long')) return 'long';
  if (dir.includes('Short')) return 'short';
  return null;
}

async function main() {
  const sinceISO = new Date(since).toISOString();
  console.log(`\n📊 Trading stats — last ${DAYS} days   (since ${sinceISO})\n`);

  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });

  // 1. Our wallet fills
  console.log('Fetching our wallet fills…');
  const ourFills = await fetchAllFills(info, VAULT as `0x${string}`, since);
  console.log(`  ${ourFills.length} fills`);

  // 2. Each target's fills + their *current* open positions (for carry-over attribution)
  const targetFills: Record<string, Fill[]> = {};
  const targetOpenSyms: Record<string, Set<string>> = {};
  for (const t of TARGETS) {
    console.log(`Fetching target ${t.name}…`);
    targetFills[t.addr] = await fetchAllFills(info, t.addr, since);
    const state: any = await info.clearinghouseState({ user: t.addr });
    const openSyms = new Set<string>(
      (state.assetPositions || [])
        .filter((p: any) => Math.abs(parseFloat(p.position?.szi || '0')) > 0)
        .map((p: any) => p.position.coin as string)
    );
    targetOpenSyms[t.addr] = openSyms;
    console.log(`  ${targetFills[t.addr].length} fills, holds: ${[...openSyms].join(',') || '(none)'}`);
  }

  // 3. Independent positions in window
  const indep = await prisma.independentPosition.findMany({
    where: { createdAt: { gte: new Date(since) } },
    orderBy: { createdAt: 'asc' },
  });

  // ── OUR FILLS: split copy vs independent ────────────────────────────────
  // A wallet fill is "independent" if it falls inside the lifetime of an
  // open/closed IndependentPosition for that symbol+side.
  function isIndependentFill(f: Fill): boolean {
    const fillSide = f.side === 'B' ? 'long' : 'short'; // buy = open long / close short
    // IndependentPosition.side is the position's direction.
    return indep.some(p => {
      if (p.symbol !== f.coin) return false;
      const start = p.createdAt.getTime();
      const end = p.closedAt ? p.closedAt.getTime() : Date.now();
      if (f.time < start - 60_000 || f.time > end + 60_000) return false;
      // Either direction (open or close fill matches by symbol+timeframe)
      return true;
    });
  }

  const ourCopyFills: Fill[] = [];
  const ourIndepFills: Fill[] = [];
  for (const f of ourFills) {
    if (isIndependentFill(f)) ourIndepFills.push(f);
    else ourCopyFills.push(f);
  }

  // ── COPY: per-target attribution ────────────────────────────────────────
  // For each of our copy fills, find the most recent target fill on same
  // symbol+side within 10 min before. That target gets credit for the action.
  type TargetStat = {
    name: string;
    targetFillCount: number;
    targetSymbols: Set<string>;
    ourCopyCount: number;
    copyNotional: number;
    closedPnl: number;
    fees: number;
  };
  const stats: Record<string, TargetStat> = {};
  for (const t of TARGETS) {
    stats[t.addr] = {
      name: t.name,
      targetFillCount: targetFills[t.addr].length,
      targetSymbols: new Set(targetFills[t.addr].map(f => f.coin)),
      ourCopyCount: 0,
      copyNotional: 0,
      closedPnl: 0,
      fees: 0,
    };
  }

  let unattributed = 0;
  let unattribPnl = 0;
  let unattribFees = 0;
  let unattribNotional = 0;

  const WINDOW_MS = 10 * 60 * 1000;
  for (const f of ourCopyFills) {
    let best: { addr: string; dt: number } | null = null;
    for (const t of TARGETS) {
      // find latest target fill on same symbol+side before our fill, within window
      const tf = targetFills[t.addr];
      for (let i = tf.length - 1; i >= 0; i--) {
        const x = tf[i];
        if (x.time > f.time) continue;
        const dt = f.time - x.time;
        if (dt > WINDOW_MS) break; // sorted asc; further back = older only
        if (x.coin !== f.coin) continue;
        if (x.side !== f.side) continue;
        if (best == null || dt < best.dt) best = { addr: t.addr, dt };
        break; // first match for this target is the latest before f
      }
    }
    const px = parseFloat(f.px), sz = parseFloat(f.sz);
    const notional = px * sz;
    const pnl = parseFloat(f.closedPnl || '0');
    const fee = parseFloat(f.fee || '0');
    if (!best) {
      // carry-over rebalance: attribute to whichever target currently holds this symbol
      // (use TARGETS order so highest priority wins when more than one holds it)
      for (const t of TARGETS) {
        if (targetOpenSyms[t.addr].has(f.coin)) {
          best = { addr: t.addr, dt: -1 };
          break;
        }
      }
    }
    if (best) {
      const s = stats[best.addr];
      s.ourCopyCount++;
      s.copyNotional += notional;
      s.closedPnl += pnl;
      s.fees += fee;
    } else {
      unattributed++;
      unattribPnl += pnl;
      unattribFees += fee;
      unattribNotional += notional;
    }
  }

  // ── COPY TOTALS ─────────────────────────────────────────────────────────
  const copyTotalPnl = ourCopyFills.reduce((s, f) => s + parseFloat(f.closedPnl || '0'), 0);
  const copyTotalFees = ourCopyFills.reduce((s, f) => s + parseFloat(f.fee || '0'), 0);
  const copyTotalNotional = ourCopyFills.reduce((s, f) => s + parseFloat(f.px) * parseFloat(f.sz), 0);
  const copyNet = copyTotalPnl - copyTotalFees;

  console.log('\n' + '═'.repeat(72));
  console.log('COPY TRADING (totals)');
  console.log('═'.repeat(72));
  console.log(`  Our copy fills:          ${ourCopyFills.length}`);
  console.log(`  Total notional traded:   $${copyTotalNotional.toFixed(0)}`);
  console.log(`  Realized P&L (gross):    ${fmtUsd(copyTotalPnl)}`);
  console.log(`  Fees:                    ${fmtUsd(-copyTotalFees)}`);
  console.log(`  Realized P&L (net):      ${fmtUsd(copyNet)}`);

  console.log('\n' + '═'.repeat(72));
  console.log('COPY TRADING — per target');
  console.log('═'.repeat(72));
  console.log(
    'Target'.padEnd(22) +
      'TgtFills'.padStart(10) +
      'OurFills'.padStart(10) +
      'Notional'.padStart(13) +
      'Gross P&L'.padStart(13) +
      'Fees'.padStart(10) +
      'Net'.padStart(11)
  );
  console.log('─'.repeat(72));
  for (const t of TARGETS) {
    const s = stats[t.addr];
    const net = s.closedPnl - s.fees;
    console.log(
      s.name.padEnd(22) +
        String(s.targetFillCount).padStart(10) +
        String(s.ourCopyCount).padStart(10) +
        ('$' + s.copyNotional.toFixed(0)).padStart(13) +
        fmtUsd(s.closedPnl).padStart(13) +
        fmtUsd(-s.fees).padStart(10) +
        fmtUsd(net).padStart(11)
    );
  }
  if (unattributed > 0) {
    console.log(
      'unattributed'.padEnd(22) +
        '-'.padStart(10) +
        String(unattributed).padStart(10) +
        ('$' + unattribNotional.toFixed(0)).padStart(13) +
        fmtUsd(unattribPnl).padStart(13) +
        fmtUsd(-unattribFees).padStart(10) +
        fmtUsd(unattribPnl - unattribFees).padStart(11)
    );
    console.log('  (unattributed = our fill had no preceding target fill on same symbol+side within 10 min)');
  }

  // Per-symbol breakdown of our copy fills
  console.log('\n' + '═'.repeat(72));
  console.log('COPY — by symbol (our fills only)');
  console.log('═'.repeat(72));
  const bySym = new Map<string, { count: number; notional: number; pnl: number; fees: number }>();
  for (const f of ourCopyFills) {
    const e = bySym.get(f.coin) ?? { count: 0, notional: 0, pnl: 0, fees: 0 };
    e.count++;
    e.notional += parseFloat(f.px) * parseFloat(f.sz);
    e.pnl += parseFloat(f.closedPnl || '0');
    e.fees += parseFloat(f.fee || '0');
    bySym.set(f.coin, e);
  }
  console.log('Symbol'.padEnd(12) + 'Fills'.padStart(8) + 'Notional'.padStart(13) + 'Gross P&L'.padStart(13) + 'Net'.padStart(13));
  console.log('─'.repeat(72));
  const sorted = [...bySym.entries()].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
  for (const [sym, e] of sorted) {
    console.log(
      sym.padEnd(12) +
        String(e.count).padStart(8) +
        ('$' + e.notional.toFixed(0)).padStart(13) +
        fmtUsd(e.pnl).padStart(13) +
        fmtUsd(e.pnl - e.fees).padStart(13)
    );
  }

  // ── INDEPENDENT TRADING ─────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('INDEPENDENT TRADING');
  console.log('═'.repeat(72));
  const closed = indep.filter(p => p.status === 'closed');
  const open = indep.filter(p => p.status === 'open');
  const confirmed = indep.filter(p => p.status === 'confirmed');
  console.log(`  Created in window:       ${indep.length}`);
  console.log(`  Closed / Open / Conf:    ${closed.length} / ${open.length} / ${confirmed.length}`);
  console.log(`  Longs / Shorts:          ${indep.filter(p => p.side === 'long').length} / ${indep.filter(p => p.side === 'short').length}`);

  if (closed.length > 0) {
    const totalPnl = closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const wins = closed.filter(p => (p.realizedPnl ?? 0) > 0);
    const losses = closed.filter(p => (p.realizedPnl ?? 0) <= 0);
    const avgPct = closed.reduce((s, p) => s + (p.realizedPnlPct ?? 0), 0) / closed.length;
    const winRate = (wins.length / closed.length) * 100;
    const best = closed.reduce((b, p) => (p.realizedPnlPct ?? -Infinity) > (b.realizedPnlPct ?? -Infinity) ? p : b);
    const worst = closed.reduce((w, p) => (p.realizedPnlPct ?? Infinity) < (w.realizedPnlPct ?? Infinity) ? p : w);
    console.log(`  Realized P&L:            ${fmtUsd(totalPnl)}`);
    console.log(`  Avg P&L per trade:       ${fmtPct(avgPct)}`);
    console.log(`  Win rate:                ${winRate.toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
    console.log(`  Best:                    ${best.symbol} ${best.side} ${fmtPct(best.realizedPnlPct ?? 0)}`);
    console.log(`  Worst:                   ${worst.symbol} ${worst.side} ${fmtPct(worst.realizedPnlPct ?? 0)}`);

    // by exit reason
    console.log('\n  By exit reason:');
    const byReason = new Map<string, { n: number; pnl: number }>();
    for (const p of closed) {
      const r = p.exitReason ?? 'unknown';
      const e = byReason.get(r) ?? { n: 0, pnl: 0 };
      e.n++; e.pnl += p.realizedPnl ?? 0;
      byReason.set(r, e);
    }
    for (const [r, e] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`    ${r.padEnd(20)} ${String(e.n).padStart(3)}   ${fmtUsd(e.pnl)}`);
    }

    // by symbol
    console.log('\n  By symbol:');
    const bySymI = new Map<string, { n: number; pnl: number; w: number }>();
    for (const p of closed) {
      const e = bySymI.get(p.symbol) ?? { n: 0, pnl: 0, w: 0 };
      e.n++; e.pnl += p.realizedPnl ?? 0; if ((p.realizedPnl ?? 0) > 0) e.w++;
      bySymI.set(p.symbol, e);
    }
    for (const [sym, e] of [...bySymI.entries()].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
      console.log(`    ${sym.padEnd(10)} ${String(e.n).padStart(3)} pos   ${fmtUsd(e.pnl).padStart(10)}   win ${((e.w/e.n)*100).toFixed(0)}%`);
    }
  }

  if (open.length > 0) {
    console.log('\n  Currently open:');
    for (const p of open) {
      const ageH = (Date.now() - p.createdAt.getTime()) / 3_600_000;
      console.log(`    ${p.symbol.padEnd(10)} ${p.side.padEnd(5)} entry $${p.entryPrice.toFixed(4)}  size ${p.size}  age ${ageH.toFixed(1)}h  score ${p.predictionScore?.toFixed(0)}`);
    }
  }

  // ── COMBINED ────────────────────────────────────────────────────────────
  const indepRealized = closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  console.log('\n' + '═'.repeat(72));
  console.log('COMBINED REALIZED (last ' + DAYS + ' days)');
  console.log('═'.repeat(72));
  console.log(`  Copy trading (net):      ${fmtUsd(copyNet)}`);
  console.log(`  Independent (closed):    ${fmtUsd(indepRealized)}`);
  console.log(`  TOTAL:                   ${fmtUsd(copyNet + indepRealized)}`);
  console.log('');

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
