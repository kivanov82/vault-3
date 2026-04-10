/**
 * Target Lifecycle Analysis v2 — CORRECTED
 *
 * Uses HL's `dir` field for action classification (ground truth from exchange)
 * and cumulative signed-delta summation for position size tracking.
 *
 *  dir field semantics (from HL):
 *    'Open Long'    → position size going more positive (buying into long)
 *    'Close Long'   → position size going less positive (selling out of long)
 *    'Open Short'   → position size going more negative (selling into short)
 *    'Close Short'  → position size going less negative (buying out of short)
 *    'Long > Short' → flip from long to short (crosses zero)
 *    'Short > Long' → flip from short to long (crosses zero)
 *
 * Position lifecycle = sequence between (Open event with prior position ≈ 0)
 * and (Close event that brings position back to 0) or a flip.
 *
 * Usage: npx tsx scripts/ml/target-lifecycle-v2.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-03-15T00:00:00Z');
const TARGET = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

// For detecting flat position — if we're within this fraction of any prior peak we treat as "effectively closed"
const FLAT_EPSILON = 1e-6;

interface Fill {
  symbol: string;
  timestamp: Date;
  side: 'B' | 'A';
  price: number;
  size: number;
  dir: string;
  closedPnl: number;
}

interface Position {
  symbol: string;
  side: 'long' | 'short';
  openedAt: Date;
  closedAt: Date | null;
  openPrice: number;            // VWAP of open + add fills
  closePrice: number | null;    // VWAP of reduce + close fills
  peakSize: number;             // max |cumulative size|
  peakNotional: number;         // peakSize × avg entry price
  totalOpenNotional: number;    // sum of open+add fill notionals
  openFillCount: number;
  reduceFillCount: number;
  realizedPnl: number;
  closedBy: 'CLOSE' | 'FLIP' | 'STILL_OPEN';
  // For computing VWAP
  openSizeSum: number;
  openNotionalSum: number;
  closeSizeSum: number;
  closeNotionalSum: number;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor((p / 100) * s.length), s.length - 1)];
}

function median(arr: number[]): number {
  return pctile(arr, 50);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(n: number, d = 2): string {
  if (!isFinite(n)) return '-';
  return n.toFixed(d);
}

async function main() {
  console.log(`\n🔬 Target Lifecycle v2 (CORRECTED) — ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}\n`);

  // Load all fills
  const rawFills = await prisma.fill.findMany({
    where: { traderAddress: TARGET, timestamp: { gte: START, lte: END } },
    orderBy: { timestamp: 'asc' },
  });

  const fills: Fill[] = rawFills.map((f) => ({
    symbol: f.symbol,
    timestamp: f.timestamp,
    side: f.side as 'B' | 'A',
    price: f.price,
    size: f.size,
    dir: (f.rawData as any)?.dir ?? '',
    closedPnl: (f.rawData as any)?.closedPnl ? parseFloat((f.rawData as any).closedPnl) : 0,
  }));

  console.log(`Loaded ${fills.length} fills`);

  // =============================================================
  // Classify dir → action
  // =============================================================
  const dirDistribution = new Map<string, number>();
  for (const f of fills) dirDistribution.set(f.dir, (dirDistribution.get(f.dir) ?? 0) + 1);
  console.log('\nDir distribution:');
  for (const [d, c] of [...dirDistribution.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d.padEnd(30)} ${c}`);
  }

  // =============================================================
  // Per-symbol position reconstruction using dir + cumulative size
  // =============================================================
  const bySymbol = new Map<string, Fill[]>();
  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol)!.push(f);
  }

  const positions: Position[] = [];

  for (const [symbol, symFills] of bySymbol) {
    // Compute cumulative position as running signed sum
    // Start assumption: position is flat at window start.
    // If the first fill is "Close *", the real prior position was non-zero;
    // we'll treat the segment up to the first true 0-crossing as an "opening position"
    // for analysis purposes.
    let cum = 0;
    let current: Position | null = null;

    // First, detect initial state. If the earliest fill is "Close *", there's a prior
    // position we didn't see open. Back-fill the initial position.
    // Walk fills and find the first zero crossing (or window end).
    let inferredStart = 0;
    for (const f of symFills) {
      const delta = f.side === 'B' ? f.size : -f.size;
      inferredStart += delta;
    }
    // The final cumulative should be the final position relative to start.
    // If the window started with a non-zero position, we need to offset.
    // Simplest heuristic: if first fills are Close-* and cumulative eventually goes to zero,
    // the initial position was -finalCumulative (i.e., initial size = -sum of all deltas for that "existing" run).

    // A cleaner method: find all zero-crossing points (positions in fills array where
    // the running cumulative hits zero or flips sign). Each non-zero segment = one position.
    // But we need to seed with the initial position.

    // Approach: find the first time cumulative returns to zero. The initial position
    // is -(cumulative up to that point's first delta sign). Complicated. Let me use HL's
    // dir field to infer initial state instead.

    // Look at the first few fills — if they're all "Close X", seed initial position as X direction.
    const firstOpenIdx = symFills.findIndex((f) => f.dir.startsWith('Open ') || f.dir.includes(' > '));
    let initialPosition = 0;
    if (firstOpenIdx > 0) {
      // There are Close-* fills before any Open. Compute sum of their deltas.
      let closePreludeSum = 0;
      for (let i = 0; i < firstOpenIdx; i++) {
        const f = symFills[i];
        closePreludeSum += f.side === 'B' ? f.size : -f.size;
      }
      // Initial position was opposite sign of closePreludeSum (since we're closing it)
      initialPosition = -closePreludeSum;
    }

    cum = initialPosition;
    // Seed an initial position object if initialPosition != 0
    if (Math.abs(initialPosition) > FLAT_EPSILON) {
      current = {
        symbol,
        side: initialPosition > 0 ? 'long' : 'short',
        openedAt: new Date(START.getTime() - 1), // before window
        closedAt: null,
        openPrice: symFills[0].price, // unknown — use first fill price as estimate
        closePrice: null,
        peakSize: Math.abs(initialPosition),
        peakNotional: Math.abs(initialPosition) * symFills[0].price,
        totalOpenNotional: Math.abs(initialPosition) * symFills[0].price,
        openFillCount: 0, // we didn't see the open
        reduceFillCount: 0,
        realizedPnl: 0,
        closedBy: 'STILL_OPEN',
        openSizeSum: Math.abs(initialPosition),
        openNotionalSum: Math.abs(initialPosition) * symFills[0].price,
        closeSizeSum: 0,
        closeNotionalSum: 0,
      };
    }

    for (const f of symFills) {
      const delta = f.side === 'B' ? f.size : -f.size;
      const prevCum = cum;
      cum += delta;
      const crossedZero = (prevCum > FLAT_EPSILON && cum < -FLAT_EPSILON) || (prevCum < -FLAT_EPSILON && cum > FLAT_EPSILON);
      const reachedZero = Math.abs(cum) < FLAT_EPSILON && Math.abs(prevCum) > FLAT_EPSILON;
      const leftZero = Math.abs(prevCum) < FLAT_EPSILON && Math.abs(cum) > FLAT_EPSILON;
      const isOpen = f.dir.startsWith('Open ');
      const isClose = f.dir.startsWith('Close ');
      const isFlip = f.dir.includes(' > ');

      if (leftZero || (!current && isOpen)) {
        // Start a new position
        current = {
          symbol,
          side: cum > 0 ? 'long' : 'short',
          openedAt: f.timestamp,
          closedAt: null,
          openPrice: f.price,
          closePrice: null,
          peakSize: Math.abs(cum),
          peakNotional: Math.abs(cum) * f.price,
          totalOpenNotional: f.size * f.price,
          openFillCount: 1,
          reduceFillCount: 0,
          realizedPnl: 0,
          closedBy: 'STILL_OPEN',
          openSizeSum: f.size,
          openNotionalSum: f.size * f.price,
          closeSizeSum: 0,
          closeNotionalSum: 0,
        };
      } else if (current && isOpen) {
        // ADD to existing position
        current.openFillCount++;
        current.totalOpenNotional += f.size * f.price;
        current.openSizeSum += f.size;
        current.openNotionalSum += f.size * f.price;
        if (Math.abs(cum) > current.peakSize) {
          current.peakSize = Math.abs(cum);
          current.peakNotional = Math.abs(cum) * f.price;
        }
      } else if (current && isClose) {
        // REDUCE existing position
        current.reduceFillCount++;
        current.realizedPnl += f.closedPnl;
        current.closeSizeSum += f.size;
        current.closeNotionalSum += f.size * f.price;
        if (reachedZero) {
          // Position closed
          current.closedAt = f.timestamp;
          current.closePrice = current.closeSizeSum > 0 ? current.closeNotionalSum / current.closeSizeSum : f.price;
          current.openPrice = current.openSizeSum > 0 ? current.openNotionalSum / current.openSizeSum : current.openPrice;
          current.closedBy = 'CLOSE';
          positions.push(current);
          current = null;
        }
      } else if (current && isFlip) {
        // Close existing and open new on the other side
        current.reduceFillCount++;
        current.realizedPnl += f.closedPnl;
        current.closedAt = f.timestamp;
        current.closeSizeSum += f.size;
        current.closeNotionalSum += f.size * f.price;
        current.closePrice = current.closeSizeSum > 0 ? current.closeNotionalSum / current.closeSizeSum : f.price;
        current.openPrice = current.openSizeSum > 0 ? current.openNotionalSum / current.openSizeSum : current.openPrice;
        current.closedBy = 'FLIP';
        positions.push(current);
        // Open new opposite
        current = {
          symbol,
          side: cum > 0 ? 'long' : 'short',
          openedAt: f.timestamp,
          closedAt: null,
          openPrice: f.price,
          closePrice: null,
          peakSize: Math.abs(cum),
          peakNotional: Math.abs(cum) * f.price,
          totalOpenNotional: Math.abs(cum) * f.price,
          openFillCount: 1,
          reduceFillCount: 0,
          realizedPnl: 0,
          closedBy: 'STILL_OPEN',
          openSizeSum: Math.abs(cum),
          openNotionalSum: Math.abs(cum) * f.price,
          closeSizeSum: 0,
          closeNotionalSum: 0,
        };
      }
    }
    if (current) {
      // Still open at window end — use avg prices
      current.openPrice = current.openSizeSum > 0 ? current.openNotionalSum / current.openSizeSum : current.openPrice;
      positions.push(current);
    }
  }

  // =============================================================
  // REPORT
  // =============================================================
  const closed = positions.filter((p) => p.closedAt !== null);
  const stillOpen = positions.filter((p) => p.closedAt === null);
  const closeEnded = closed.filter((p) => p.closedBy === 'CLOSE');
  const flipEnded = closed.filter((p) => p.closedBy === 'FLIP');

  console.log('\n━'.repeat(40));
  console.log(`POSITIONS RECONSTRUCTED: ${positions.length}`);
  console.log('━'.repeat(40));
  console.log(`  Closed:               ${closed.length}`);
  console.log(`    via CLOSE (→ flat): ${closeEnded.length} (${((closeEnded.length / closed.length) * 100).toFixed(0)}%)`);
  console.log(`    via FLIP:           ${flipEnded.length} (${((flipEnded.length / closed.length) * 100).toFixed(0)}%)`);
  console.log(`  Still open at end:    ${stillOpen.length}`);
  const longs = positions.filter((p) => p.side === 'long');
  const shorts = positions.filter((p) => p.side === 'short');
  console.log(`  Longs: ${longs.length}   Shorts: ${shorts.length}`);

  // Hold times
  const holds = closed.filter((p) => p.openedAt.getTime() >= START.getTime())
    .map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / 3600000);
  const longHolds = closed.filter((p) => p.side === 'long' && p.openedAt.getTime() >= START.getTime())
    .map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / 3600000);
  const shortHolds = closed.filter((p) => p.side === 'short' && p.openedAt.getTime() >= START.getTime())
    .map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / 3600000);

  console.log('\n━'.repeat(40));
  console.log('HOLD TIMES (closed positions that opened within window)');
  console.log('━'.repeat(40));
  console.log(`  All:     n=${holds.length}   median ${fmt(median(holds))}h   p25 ${fmt(pctile(holds, 25))}h   p75 ${fmt(pctile(holds, 75))}h   mean ${fmt(mean(holds))}h`);
  console.log(`  Longs:   n=${longHolds.length}   median ${fmt(median(longHolds))}h   p25 ${fmt(pctile(longHolds, 25))}h   p75 ${fmt(pctile(longHolds, 75))}h`);
  console.log(`  Shorts:  n=${shortHolds.length}   median ${fmt(median(shortHolds))}h   p25 ${fmt(pctile(shortHolds, 25))}h   p75 ${fmt(pctile(shortHolds, 75))}h`);

  const buckets = { '<1h': 0, '1-4h': 0, '4-12h': 0, '12-24h': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
  for (const h of holds) {
    if (h < 1) buckets['<1h']++;
    else if (h < 4) buckets['1-4h']++;
    else if (h < 12) buckets['4-12h']++;
    else if (h < 24) buckets['12-24h']++;
    else if (h < 72) buckets['1-3d']++;
    else if (h < 168) buckets['3-7d']++;
    else buckets['>7d']++;
  }
  console.log('\n  Distribution:');
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`    ${k.padEnd(8)} ${v.toString().padStart(5)} (${((v / holds.length) * 100).toFixed(0)}%)`);
  }

  // Sizing
  console.log('\n━'.repeat(40));
  console.log('POSITION SIZING');
  console.log('━'.repeat(40));
  const peakNots = positions.map((p) => p.peakNotional);
  console.log(`Peak notional per position (USD):`);
  console.log(`  median ${fmt(median(peakNots), 0)}  p25 ${fmt(pctile(peakNots, 25), 0)}  p75 ${fmt(pctile(peakNots, 75), 0)}  p95 ${fmt(pctile(peakNots, 95), 0)}  max ${fmt(Math.max(...peakNots), 0)}`);

  const fillCounts = positions.map((p) => p.openFillCount + p.reduceFillCount);
  console.log(`\nFills per position: median ${fmt(median(fillCounts), 0)}  p75 ${fmt(pctile(fillCounts, 75), 0)}  p95 ${fmt(pctile(fillCounts, 95), 0)}`);
  console.log(`Open fills (TWAP entry slices): median ${fmt(median(positions.map((p) => p.openFillCount)), 0)}  p75 ${fmt(pctile(positions.map((p) => p.openFillCount), 75), 0)}`);
  console.log(`Reduce fills (TWAP exit slices): median ${fmt(median(positions.map((p) => p.reduceFillCount)), 0)}  p75 ${fmt(pctile(positions.map((p) => p.reduceFillCount), 75), 0)}`);

  // P&L
  console.log('\n━'.repeat(40));
  console.log('P&L PER POSITION (closed only, sum of closedPnl per position)');
  console.log('━'.repeat(40));
  const pnls = closed.map((p) => p.realizedPnl);
  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p <= 0);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  console.log(`Closed positions: ${closed.length}`);
  console.log(`Total P&L: $${fmt(totalPnl, 0)}`);
  console.log(`Win rate: ${((winners.length / closed.length) * 100).toFixed(0)}% (${winners.length}W / ${losers.length}L)`);
  console.log(`Avg winner: $${fmt(mean(winners), 0)}`);
  console.log(`Avg loser:  $${fmt(mean(losers), 0)}`);
  console.log(`Median winner: $${fmt(median(winners), 0)}`);
  console.log(`Median loser:  $${fmt(median(losers), 0)}`);
  console.log(`Winner/loser ratio: ${fmt(Math.abs(mean(winners) / (mean(losers) || 1)))}x`);

  // Exit style
  console.log('\n━'.repeat(40));
  console.log('EXIT STYLE BY DIRECTION');
  console.log('━'.repeat(40));
  for (const dir of ['long', 'short'] as const) {
    const dirClosed = closed.filter((p) => p.side === dir);
    if (dirClosed.length === 0) continue;
    const dirFlip = dirClosed.filter((p) => p.closedBy === 'FLIP');
    const dirClose = dirClosed.filter((p) => p.closedBy === 'CLOSE');
    const wins = dirClosed.filter((p) => p.realizedPnl > 0);
    const dirPnl = dirClosed.reduce((s, p) => s + p.realizedPnl, 0);
    console.log(
      `  ${dir.toUpperCase().padEnd(6)} n=${dirClosed.length.toString().padStart(4)}  ` +
      `CLOSE ${dirClose.length} FLIP ${dirFlip.length}  ` +
      `WR ${((wins.length / dirClosed.length) * 100).toFixed(0)}%  ` +
      `P&L $${fmt(dirPnl, 0).padStart(10)}`
    );
  }

  // By symbol
  console.log('\n━'.repeat(40));
  console.log('BY SYMBOL (closed positions)');
  console.log('━'.repeat(40));
  const bySym = new Map<string, { n: number; longs: number; shorts: number; wins: number; pnl: number; holds: number[] }>();
  for (const p of closed) {
    const s = bySym.get(p.symbol) ?? { n: 0, longs: 0, shorts: 0, wins: 0, pnl: 0, holds: [] };
    s.n++;
    if (p.side === 'long') s.longs++;
    else s.shorts++;
    if (p.realizedPnl > 0) s.wins++;
    s.pnl += p.realizedPnl;
    if (p.openedAt.getTime() >= START.getTime()) {
      s.holds.push((p.closedAt!.getTime() - p.openedAt.getTime()) / 3600000);
    }
    bySym.set(p.symbol, s);
  }
  const top = [...bySym.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  console.log(
    'Symbol'.padEnd(12) + 'n'.padStart(5) + 'L'.padStart(5) + 'S'.padStart(5) +
    'WR'.padStart(6) + 'Pnl$'.padStart(13) + 'MedHold'.padStart(10)
  );
  console.log('─'.repeat(60));
  for (const [sym, s] of top) {
    const medHold = s.holds.length > 0 ? fmt(median(s.holds), 1) + 'h' : '-';
    console.log(
      sym.padEnd(12) +
      s.n.toString().padStart(5) +
      s.longs.toString().padStart(5) +
      s.shorts.toString().padStart(5) +
      (((s.wins / s.n) * 100).toFixed(0) + '%').padStart(6) +
      fmt(s.pnl, 0).padStart(13) +
      medHold.padStart(10)
    );
  }

  console.log('');
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
