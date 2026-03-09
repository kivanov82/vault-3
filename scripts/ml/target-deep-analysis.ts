/**
 * Deep Target Vault Analysis
 *
 * Analyzes 27K+ fills from the target vault to understand:
 * - Entry/exit patterns and timing
 * - Hold durations
 * - TP/SL behavior (realized P&L distribution)
 * - Position building (TWAP/accumulation patterns)
 * - Win rates by symbol, direction, session
 * - Behavioral signals we can learn from
 *
 * Usage: npm run ml:target-analysis
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TARGET_ADDR = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

interface Fill {
  symbol: string;
  side: string;
  price: number;
  size: number;
  positionSzi: number;
  timestamp: Date;
  rawData: any;
}

interface PositionCycle {
  symbol: string;
  direction: 'long' | 'short';
  entryFills: Fill[];
  exitFills: Fill[];
  entryPrice: number;
  exitPrice: number;
  peakSize: number;
  holdTimeMs: number;
  realizedPnl: number;
  pnlPct: number;
  entryTime: Date;
  exitTime: Date;
}

function getSession(date: Date): string {
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 8) return 'asia';
  if (hour >= 8 && hour < 16) return 'europe';
  return 'us';
}

async function main() {
  console.log('Loading target vault fills...');

  const fills = await prisma.fill.findMany({
    where: { traderAddress: TARGET_ADDR },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`Loaded ${fills.length} fills`);
  if (fills.length === 0) return;

  const dateFrom = fills[0].timestamp.toISOString().slice(0, 10);
  const dateTo = fills[fills.length - 1].timestamp.toISOString().slice(0, 10);
  console.log(`Date range: ${dateFrom} to ${dateTo}\n`);

  // ═══════════════════════════════════════════════════════
  // RECONSTRUCT POSITION CYCLES
  // ═══════════════════════════════════════════════════════

  // Track position state per symbol to identify open/close cycles
  const positionState = new Map<string, {
    direction: 'long' | 'short' | null;
    size: number;
    entryFills: Fill[];
    peakSize: number;
    totalEntryValue: number;
    totalEntrySize: number;
  }>();

  const cycles: PositionCycle[] = [];

  for (const fill of fills) {
    const raw = fill.rawData as any;
    const dir = raw?.dir as string || '';
    const closedPnl = parseFloat(raw?.closedPnl || '0');
    const sym = fill.symbol;

    let state = positionState.get(sym);
    if (!state) {
      state = { direction: null, size: 0, entryFills: [], peakSize: 0, totalEntryValue: 0, totalEntrySize: 0 };
      positionState.set(sym, state);
    }

    const fillData: Fill = {
      symbol: sym,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      positionSzi: fill.positionSzi,
      timestamp: fill.timestamp,
      rawData: raw,
    };

    const isOpen = dir.startsWith('Open');
    const isClose = dir.startsWith('Close');
    const isLong = dir.includes('Long');
    const isShort = dir.includes('Short');

    if (isOpen) {
      if (state.direction === null || state.size === 0) {
        // New position
        state.direction = isLong ? 'long' : 'short';
        state.entryFills = [fillData];
        state.totalEntryValue = fill.price * fill.size;
        state.totalEntrySize = fill.size;
        state.peakSize = fill.size;
      } else {
        // Adding to position
        state.entryFills.push(fillData);
        state.totalEntryValue += fill.price * fill.size;
        state.totalEntrySize += fill.size;
        state.size += fill.size;
        if (state.size > state.peakSize) state.peakSize = state.size;
      }
      state.size += fill.size;
      if (state.size > state.peakSize) state.peakSize = state.size;
    } else if (isClose) {
      state.size -= fill.size;

      // Check if position fully closed (or near zero)
      if (Math.abs(fill.positionSzi) < 0.0001 || state.size <= 0.0001) {
        // Position cycle complete
        if (state.entryFills.length > 0) {
          const avgEntry = state.totalEntryValue / state.totalEntrySize;
          const cycle: PositionCycle = {
            symbol: sym,
            direction: state.direction!,
            entryFills: state.entryFills,
            exitFills: [fillData],
            entryPrice: avgEntry,
            exitPrice: fill.price,
            peakSize: state.peakSize,
            holdTimeMs: fill.timestamp.getTime() - state.entryFills[0].timestamp.getTime(),
            realizedPnl: closedPnl,
            pnlPct: state.direction === 'long'
              ? ((fill.price - avgEntry) / avgEntry) * 100
              : ((avgEntry - fill.price) / avgEntry) * 100,
            entryTime: state.entryFills[0].timestamp,
            exitTime: fill.timestamp,
          };
          cycles.push(cycle);
        }
        // Reset
        state.direction = null;
        state.size = 0;
        state.entryFills = [];
        state.peakSize = 0;
        state.totalEntryValue = 0;
        state.totalEntrySize = 0;
      }
    }
  }

  console.log('═'.repeat(70));
  console.log('TARGET VAULT DEEP ANALYSIS');
  console.log('═'.repeat(70));

  // ═══════════════════════════════════════════════════════
  // FILL-LEVEL ANALYSIS
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(70));
  console.log('FILL-LEVEL PATTERNS');
  console.log('─'.repeat(70));

  // Direction distribution
  const opens = fills.filter(f => (f.rawData as any)?.dir?.startsWith('Open'));
  const closes = fills.filter(f => (f.rawData as any)?.dir?.startsWith('Close'));
  const openLongs = opens.filter(f => (f.rawData as any)?.dir?.includes('Long'));
  const openShorts = opens.filter(f => (f.rawData as any)?.dir?.includes('Short'));

  console.log(`  Total fills: ${fills.length}`);
  console.log(`  Opens: ${opens.length} (${openLongs.length} long, ${openShorts.length} short)`);
  console.log(`  Closes: ${closes.length}`);
  console.log(`  Long bias: ${(openLongs.length / opens.length * 100).toFixed(1)}%`);

  // Session distribution
  const sessionFills: Record<string, { opens: number; closes: number; longOpens: number; shortOpens: number }> = {
    asia: { opens: 0, closes: 0, longOpens: 0, shortOpens: 0 },
    europe: { opens: 0, closes: 0, longOpens: 0, shortOpens: 0 },
    us: { opens: 0, closes: 0, longOpens: 0, shortOpens: 0 },
  };

  for (const fill of fills) {
    const session = getSession(fill.timestamp);
    const dir = (fill.rawData as any)?.dir || '';
    if (dir.startsWith('Open')) {
      sessionFills[session].opens++;
      if (dir.includes('Long')) sessionFills[session].longOpens++;
      if (dir.includes('Short')) sessionFills[session].shortOpens++;
    }
    if (dir.startsWith('Close')) sessionFills[session].closes++;
  }

  console.log('\n  Session behavior:');
  console.log(`  ${'Session'.padEnd(10)} ${'Opens'.padStart(7)} ${'Closes'.padStart(8)} ${'Long%'.padStart(7)} ${'Short%'.padStart(8)}`);
  for (const [session, data] of Object.entries(sessionFills)) {
    const longPct = data.opens > 0 ? (data.longOpens / data.opens * 100).toFixed(1) : '0';
    const shortPct = data.opens > 0 ? (data.shortOpens / data.opens * 100).toFixed(1) : '0';
    console.log(`  ${session.padEnd(10)} ${String(data.opens).padStart(7)} ${String(data.closes).padStart(8)} ${(longPct + '%').padStart(7)} ${(shortPct + '%').padStart(8)}`);
  }

  // TWAP detection: consecutive fills on same symbol within short window
  console.log('\n' + '─'.repeat(70));
  console.log('TWAP / ACCUMULATION PATTERNS');
  console.log('─'.repeat(70));

  const twapGroups: { symbol: string; dir: string; fills: typeof fills; durationMs: number }[] = [];
  let currentGroup: typeof fills = [];
  let currentDir = '';
  let currentSymbol = '';

  for (const fill of fills) {
    const dir = (fill.rawData as any)?.dir || '';
    const isOpen = dir.startsWith('Open');
    const dirType = dir;

    if (fill.symbol === currentSymbol && dirType === currentDir && currentGroup.length > 0) {
      const gap = fill.timestamp.getTime() - currentGroup[currentGroup.length - 1].timestamp.getTime();
      if (gap < 600000) { // within 10 min
        currentGroup.push(fill);
        continue;
      }
    }

    // Save previous group if > 1 fill
    if (currentGroup.length > 1) {
      twapGroups.push({
        symbol: currentSymbol,
        dir: currentDir,
        fills: currentGroup,
        durationMs: currentGroup[currentGroup.length - 1].timestamp.getTime() - currentGroup[0].timestamp.getTime(),
      });
    }

    currentGroup = [fill];
    currentDir = dirType;
    currentSymbol = fill.symbol;
  }

  const twapSizes = twapGroups.map(g => g.fills.length);
  const twapDurations = twapGroups.map(g => g.durationMs / 60000);

  console.log(`  TWAP groups detected: ${twapGroups.length}`);
  if (twapSizes.length > 0) {
    console.log(`  Avg fills per group: ${(twapSizes.reduce((a, b) => a + b, 0) / twapSizes.length).toFixed(1)}`);
    console.log(`  Max fills per group: ${Math.max(...twapSizes)}`);
    console.log(`  Avg TWAP duration: ${(twapDurations.reduce((a, b) => a + b, 0) / twapDurations.length).toFixed(1)} min`);

    // Distribution of TWAP sizes
    const sizeDistribution: Record<string, number> = {};
    for (const s of twapSizes) {
      const bucket = s <= 2 ? '2' : s <= 5 ? '3-5' : s <= 10 ? '6-10' : s <= 20 ? '11-20' : '21+';
      sizeDistribution[bucket] = (sizeDistribution[bucket] || 0) + 1;
    }
    console.log('  TWAP size distribution:');
    for (const [bucket, count] of Object.entries(sizeDistribution)) {
      console.log(`    ${bucket.padStart(5)} fills: ${count} groups`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // POSITION CYCLE ANALYSIS
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(70));
  console.log('POSITION CYCLE ANALYSIS');
  console.log('─'.repeat(70));

  console.log(`  Total completed cycles: ${cycles.length}`);

  const longCycles = cycles.filter(c => c.direction === 'long');
  const shortCycles = cycles.filter(c => c.direction === 'short');

  console.log(`  Long cycles: ${longCycles.length}`);
  console.log(`  Short cycles: ${shortCycles.length}`);

  // Hold time analysis
  const holdHours = cycles.map(c => c.holdTimeMs / 3600000);
  const sortedHold = [...holdHours].sort((a, b) => a - b);

  console.log('\n  Hold time distribution:');
  const holdBuckets = [
    { label: '< 1h', max: 1 },
    { label: '1-4h', max: 4 },
    { label: '4-12h', max: 12 },
    { label: '12-24h', max: 24 },
    { label: '1-3d', max: 72 },
    { label: '3-7d', max: 168 },
    { label: '7-14d', max: 336 },
    { label: '14d+', max: Infinity },
  ];

  for (const bucket of holdBuckets) {
    const prev = holdBuckets[holdBuckets.indexOf(bucket) - 1]?.max || 0;
    const count = holdHours.filter(h => h >= prev && h < bucket.max).length;
    const pct = (count / cycles.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(count / cycles.length * 50));
    console.log(`    ${bucket.label.padEnd(8)} ${String(count).padStart(5)} (${pct.padStart(5)}%) ${bar}`);
  }

  if (sortedHold.length > 0) {
    const median = sortedHold[Math.floor(sortedHold.length / 2)];
    const avg = holdHours.reduce((a, b) => a + b, 0) / holdHours.length;
    console.log(`\n  Median hold: ${median.toFixed(1)}h`);
    console.log(`  Average hold: ${avg.toFixed(1)}h`);
  }

  // P&L distribution
  console.log('\n  P&L % distribution (per cycle):');
  const pnlPcts = cycles.map(c => c.pnlPct).filter(p => isFinite(p) && !isNaN(p));
  const wins = pnlPcts.filter(p => p > 0);
  const losses = pnlPcts.filter(p => p <= 0);

  console.log(`  Win rate: ${(wins.length / pnlPcts.length * 100).toFixed(1)}%`);
  if (wins.length > 0) {
    const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
    const medianWin = [...wins].sort((a, b) => a - b)[Math.floor(wins.length / 2)];
    console.log(`  Avg win:  +${avgWin.toFixed(2)}%  (median: +${medianWin.toFixed(2)}%)`);
  }
  if (losses.length > 0) {
    const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
    const medianLoss = [...losses].sort((a, b) => a - b)[Math.floor(losses.length / 2)];
    console.log(`  Avg loss: ${avgLoss.toFixed(2)}%  (median: ${medianLoss.toFixed(2)}%)`);
  }

  // TP/SL analysis - what % moves do they take profit / cut losses?
  console.log('\n  Exit P&L buckets (potential TP/SL levels):');
  const exitBuckets = [
    { label: '< -10%', min: -Infinity, max: -10 },
    { label: '-10 to -5%', min: -10, max: -5 },
    { label: '-5 to -3%', min: -5, max: -3 },
    { label: '-3 to -1%', min: -3, max: -1 },
    { label: '-1 to 0%', min: -1, max: 0 },
    { label: '0 to +1%', min: 0, max: 1 },
    { label: '+1 to +3%', min: 1, max: 3 },
    { label: '+3 to +5%', min: 3, max: 5 },
    { label: '+5 to +10%', min: 5, max: 10 },
    { label: '+10 to +20%', min: 10, max: 20 },
    { label: '+20 to +50%', min: 20, max: 50 },
    { label: '> +50%', min: 50, max: Infinity },
  ];

  for (const bucket of exitBuckets) {
    const count = pnlPcts.filter(p => p >= bucket.min && p < bucket.max).length;
    const pct = (count / pnlPcts.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(count / pnlPcts.length * 50));
    console.log(`    ${bucket.label.padEnd(14)} ${String(count).padStart(5)} (${pct.padStart(5)}%) ${bar}`);
  }

  // By symbol - win rate, avg P&L, hold time, direction
  console.log('\n' + '─'.repeat(70));
  console.log('PERFORMANCE BY SYMBOL');
  console.log('─'.repeat(70));

  const symbolStats = new Map<string, {
    cycles: number; wins: number; avgPnl: number; totalPnl: number;
    avgHoldH: number; longPct: number; longs: number; shorts: number;
    avgEntryFills: number;
  }>();

  for (const cycle of cycles) {
    const s = symbolStats.get(cycle.symbol) || {
      cycles: 0, wins: 0, avgPnl: 0, totalPnl: 0,
      avgHoldH: 0, longPct: 0, longs: 0, shorts: 0, avgEntryFills: 0,
    };
    s.cycles++;
    if (cycle.pnlPct > 0) s.wins++;
    s.totalPnl += cycle.pnlPct;
    s.avgHoldH += cycle.holdTimeMs / 3600000;
    if (cycle.direction === 'long') s.longs++;
    else s.shorts++;
    s.avgEntryFills += cycle.entryFills.length;
    symbolStats.set(cycle.symbol, s);
  }

  console.log(`  ${'Symbol'.padEnd(12)} ${'Cycles'.padStart(7)} ${'Win%'.padStart(7)} ${'AvgP&L%'.padStart(9)} ${'AvgHold'.padStart(9)} ${'Long%'.padStart(7)} ${'AvgFills'.padStart(9)}`);
  console.log('  ' + '─'.repeat(64));

  const sortedSymbols = [...symbolStats.entries()]
    .sort((a, b) => b[1].cycles - a[1].cycles);

  for (const [sym, data] of sortedSymbols.slice(0, 30)) {
    const winRate = (data.wins / data.cycles * 100).toFixed(0);
    const avgPnl = (data.totalPnl / data.cycles).toFixed(2);
    const avgHold = (data.avgHoldH / data.cycles).toFixed(1) + 'h';
    const longPct = (data.longs / data.cycles * 100).toFixed(0);
    const avgFills = (data.avgEntryFills / data.cycles).toFixed(1);
    console.log(`  ${sym.padEnd(12)} ${String(data.cycles).padStart(7)} ${(winRate + '%').padStart(7)} ${(avgPnl + '%').padStart(9)} ${avgHold.padStart(9)} ${(longPct + '%').padStart(7)} ${avgFills.padStart(9)}`);
  }

  // ═══════════════════════════════════════════════════════
  // ENTRY TIMING PATTERNS
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(70));
  console.log('ENTRY TIMING PATTERNS');
  console.log('─'.repeat(70));

  // Hour of day distribution for entries
  const hourDist = new Array(24).fill(0);
  for (const cycle of cycles) {
    hourDist[cycle.entryTime.getUTCHours()]++;
  }

  console.log('  Entry by UTC hour:');
  const maxHour = Math.max(...hourDist);
  for (let h = 0; h < 24; h++) {
    const bar = '#'.repeat(Math.round(hourDist[h] / maxHour * 30));
    const session = h < 8 ? 'Asia' : h < 16 ? 'EU' : 'US';
    console.log(`    ${String(h).padStart(2)}:00  ${String(hourDist[h]).padStart(4)}  ${bar}  [${session}]`);
  }

  // Day of week
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayDist = new Array(7).fill(0);
  for (const cycle of cycles) {
    dayDist[cycle.entryTime.getUTCDay()]++;
  }

  console.log('\n  Entry by day of week:');
  for (let d = 0; d < 7; d++) {
    console.log(`    ${dayNames[d]}: ${dayDist[d]}`);
  }

  // ═══════════════════════════════════════════════════════
  // WIN RATE BY SESSION / DIRECTION / HOLD TIME
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(70));
  console.log('WIN RATE BREAKDOWN');
  console.log('─'.repeat(70));

  // By entry session
  const sessionWins: Record<string, { wins: number; total: number; avgPnl: number }> = {};
  for (const cycle of cycles) {
    const session = getSession(cycle.entryTime);
    if (!sessionWins[session]) sessionWins[session] = { wins: 0, total: 0, avgPnl: 0 };
    sessionWins[session].total++;
    if (cycle.pnlPct > 0) sessionWins[session].wins++;
    sessionWins[session].avgPnl += cycle.pnlPct;
  }

  console.log('  By entry session:');
  for (const [session, data] of Object.entries(sessionWins)) {
    const wr = (data.wins / data.total * 100).toFixed(1);
    const avg = (data.avgPnl / data.total).toFixed(2);
    console.log(`    ${session.padEnd(8)} ${wr}% win rate  (${data.total} cycles, avg ${avg}%)`);
  }

  // By direction
  console.log('\n  By direction:');
  for (const dir of ['long', 'short'] as const) {
    const dirCycles = cycles.filter(c => c.direction === dir);
    const dirWins = dirCycles.filter(c => c.pnlPct > 0);
    const avgPnl = dirCycles.reduce((s, c) => s + c.pnlPct, 0) / dirCycles.length;
    console.log(`    ${dir.padEnd(8)} ${(dirWins.length / dirCycles.length * 100).toFixed(1)}% win rate  (${dirCycles.length} cycles, avg ${avgPnl.toFixed(2)}%)`);
  }

  // By hold time bucket
  console.log('\n  By hold time:');
  for (const bucket of holdBuckets.slice(0, 6)) {
    const prev = holdBuckets[holdBuckets.indexOf(bucket) - 1]?.max || 0;
    const bucketCycles = cycles.filter(c => {
      const h = c.holdTimeMs / 3600000;
      return h >= prev && h < bucket.max;
    });
    if (bucketCycles.length < 3) continue;
    const bucketWins = bucketCycles.filter(c => c.pnlPct > 0);
    const avgPnl = bucketCycles.reduce((s, c) => s + c.pnlPct, 0) / bucketCycles.length;
    console.log(`    ${bucket.label.padEnd(8)} ${(bucketWins.length / bucketCycles.length * 100).toFixed(1)}% win rate  (${bucketCycles.length} cycles, avg ${avgPnl.toFixed(2)}%)`);
  }

  // ═══════════════════════════════════════════════════════
  // CONSECUTIVE TRADE PATTERNS
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(70));
  console.log('POSITION SIZING PATTERNS');
  console.log('─'.repeat(70));

  // How many fills to build a position?
  const entryFillCounts = cycles.map(c => c.entryFills.length);
  const avgEntryFills = entryFillCounts.reduce((a, b) => a + b, 0) / entryFillCounts.length;
  const singleEntry = entryFillCounts.filter(c => c === 1).length;

  console.log(`  Avg entry fills per position: ${avgEntryFills.toFixed(1)}`);
  console.log(`  Single-fill entries: ${singleEntry} (${(singleEntry / cycles.length * 100).toFixed(1)}%)`);
  console.log(`  Multi-fill (TWAP) entries: ${cycles.length - singleEntry} (${((cycles.length - singleEntry) / cycles.length * 100).toFixed(1)}%)`);

  // Do multi-fill entries perform better?
  const singleFillCycles = cycles.filter(c => c.entryFills.length === 1);
  const multiFillCycles = cycles.filter(c => c.entryFills.length > 1);

  if (singleFillCycles.length > 0 && multiFillCycles.length > 0) {
    const singleWR = singleFillCycles.filter(c => c.pnlPct > 0).length / singleFillCycles.length * 100;
    const multiWR = multiFillCycles.filter(c => c.pnlPct > 0).length / multiFillCycles.length * 100;
    const singleAvg = singleFillCycles.reduce((s, c) => s + c.pnlPct, 0) / singleFillCycles.length;
    const multiAvg = multiFillCycles.reduce((s, c) => s + c.pnlPct, 0) / multiFillCycles.length;
    console.log(`\n  Single-fill win rate: ${singleWR.toFixed(1)}%, avg P&L: ${singleAvg.toFixed(2)}%`);
    console.log(`  Multi-fill win rate:  ${multiWR.toFixed(1)}%, avg P&L: ${multiAvg.toFixed(2)}%`);
  }

  // ═══════════════════════════════════════════════════════
  // RECENT BEHAVIOR (last 30 days)
  // ═══════════════════════════════════════════════════════

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentCycles = cycles.filter(c => c.exitTime > thirtyDaysAgo);

  if (recentCycles.length > 0) {
    console.log('\n' + '─'.repeat(70));
    console.log('RECENT BEHAVIOR (last 30 days)');
    console.log('─'.repeat(70));

    const recentWins = recentCycles.filter(c => c.pnlPct > 0);
    const recentLongs = recentCycles.filter(c => c.direction === 'long');
    const recentAvgHold = recentCycles.reduce((s, c) => s + c.holdTimeMs / 3600000, 0) / recentCycles.length;
    const recentAvgPnl = recentCycles.reduce((s, c) => s + c.pnlPct, 0) / recentCycles.length;

    console.log(`  Cycles: ${recentCycles.length}`);
    console.log(`  Win rate: ${(recentWins.length / recentCycles.length * 100).toFixed(1)}%`);
    console.log(`  Avg P&L: ${recentAvgPnl.toFixed(2)}%`);
    console.log(`  Avg hold: ${recentAvgHold.toFixed(1)}h`);
    console.log(`  Long%: ${(recentLongs.length / recentCycles.length * 100).toFixed(1)}%`);

    // Recent top symbols
    const recentSymbolStats = new Map<string, { cycles: number; wins: number; avgPnl: number }>();
    for (const c of recentCycles) {
      const s = recentSymbolStats.get(c.symbol) || { cycles: 0, wins: 0, avgPnl: 0 };
      s.cycles++;
      if (c.pnlPct > 0) s.wins++;
      s.avgPnl += c.pnlPct;
      recentSymbolStats.set(c.symbol, s);
    }

    console.log(`\n  Recent by symbol:`);
    console.log(`  ${'Symbol'.padEnd(12)} ${'Cycles'.padStart(7)} ${'Win%'.padStart(7)} ${'AvgP&L%'.padStart(9)}`);
    for (const [sym, data] of [...recentSymbolStats.entries()].sort((a, b) => b[1].cycles - a[1].cycles).slice(0, 15)) {
      console.log(`  ${sym.padEnd(12)} ${String(data.cycles).padStart(7)} ${((data.wins / data.cycles * 100).toFixed(0) + '%').padStart(7)} ${((data.avgPnl / data.cycles).toFixed(2) + '%').padStart(9)}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // KEY INSIGHTS SUMMARY
  // ═══════════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(70));
  console.log('KEY INSIGHTS FOR INDEPENDENT TRADING MODEL');
  console.log('═'.repeat(70));

  // Best performing symbols with enough data
  const goodSymbols = [...symbolStats.entries()]
    .filter(([_, d]) => d.cycles >= 5)
    .map(([sym, d]) => ({
      sym,
      winRate: d.wins / d.cycles,
      avgPnl: d.totalPnl / d.cycles,
      cycles: d.cycles,
    }))
    .sort((a, b) => b.avgPnl - a.avgPnl);

  console.log('\n  Best symbols (>= 5 cycles, by avg P&L):');
  for (const s of goodSymbols.slice(0, 10)) {
    console.log(`    ${s.sym.padEnd(12)} ${(s.winRate * 100).toFixed(0)}% WR, avg ${s.avgPnl.toFixed(2)}%, ${s.cycles} cycles`);
  }

  console.log('\n  Worst symbols:');
  for (const s of goodSymbols.slice(-5)) {
    console.log(`    ${s.sym.padEnd(12)} ${(s.winRate * 100).toFixed(0)}% WR, avg ${s.avgPnl.toFixed(2)}%, ${s.cycles} cycles`);
  }

  // Optimal hold time
  const holdTimeWinRates = holdBuckets.slice(0, 6).map(bucket => {
    const prev = holdBuckets[holdBuckets.indexOf(bucket) - 1]?.max || 0;
    const bucketCycles = cycles.filter(c => {
      const h = c.holdTimeMs / 3600000;
      return h >= prev && h < bucket.max;
    });
    if (bucketCycles.length < 3) return null;
    return {
      label: bucket.label,
      winRate: bucketCycles.filter(c => c.pnlPct > 0).length / bucketCycles.length,
      avgPnl: bucketCycles.reduce((s, c) => s + c.pnlPct, 0) / bucketCycles.length,
      count: bucketCycles.length,
    };
  }).filter(Boolean);

  console.log('\n  Optimal hold time (by avg P&L):');
  for (const h of holdTimeWinRates.sort((a: any, b: any) => b.avgPnl - a.avgPnl)) {
    if (!h) continue;
    console.log(`    ${h.label.padEnd(8)} ${(h.winRate * 100).toFixed(0)}% WR, avg ${h.avgPnl.toFixed(2)}%, ${h.count} cycles`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
