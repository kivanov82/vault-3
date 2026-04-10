/**
 * Sentiment-to-target correlation analysis.
 *
 *  1. Build an hourly position state for each sentiment wallet by replaying
 *     their fills forward. For each 1h timestamp in the window, we know:
 *       - net direction on BTC (long / short / flat)
 *       - net direction on each symbol they trade
 *       - number of position flips in last 24h
 *  2. For each 0x4cb5 entry event, snapshot the sentiment state AT entry time.
 *  3. Test:
 *       A. Alignment: how often does a sentiment wallet agree with 0x4cb5 on direction at entry?
 *       B. Predictiveness: does sentiment state at time T predict 0x4cb5 entries in T..T+4h?
 *       C. Comparison vs our macro regime: does sentiment beat BTC-EMA regime as a predictor?
 *       D. Consensus value: do 2-of-2 sentiment agreements predict better than either alone?
 *       E. Lead/lag: when 0x4cb5 and sentiment agree, who moves first?
 *
 * Usage: npx tsx scripts/ml/sentiment-correlation.ts
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
const SENTIMENT_WALLETS = [
  { address: '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0', label: 'archangel' },
  { address: '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768', label: 'bitcoin-ma' },
  { address: '0xbd9c944dcfb31cd24c81ebf1c974d950f44e42b8', label: 'bd9c-prior-copy' },
];

// Hourly position state per symbol: signed size (positive = long, negative = short, 0 = flat)
type PositionState = Map<string, number>; // symbol -> signed size

interface HourlyState {
  timestamp: Date;
  // Per-symbol position
  positions: PositionState;
  // Aggregate direction signals
  btcDirection: 'long' | 'short' | 'flat'; // based on BTC position
  anySymbolLong: boolean;
  anySymbolShort: boolean;
  totalNetNotionalSigned: number; // sum of signed sizes × entry price across symbols (rough conviction)
}

// =============================================================================

async function buildHourlyStates(wallet: string, label: string): Promise<Map<number, HourlyState>> {
  // Fetch all fills for the wallet in window, sorted
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: wallet,
      timestamp: { gte: START, lte: END },
    },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, symbol: true, side: true, size: true, price: true, positionSzi: true },
  });

  console.log(`  ${label}: ${fills.length} fills, building hourly states...`);

  // Replay forward. For each fill, apply the delta to position state.
  // Then snapshot at every hour boundary.
  const states = new Map<number, HourlyState>();
  const currentPositions: PositionState = new Map();

  // Initial state (at START, assume all flat — will be corrected by startPosition of first fill if possible)
  let fillIdx = 0;

  for (let h = START.getTime(); h <= END.getTime(); h += 3600 * 1000) {
    // Apply all fills with time <= h
    while (fillIdx < fills.length && fills[fillIdx].timestamp.getTime() <= h) {
      const f = fills[fillIdx];
      // Prefer the exchange's own position tracker (startPosition + signed delta) if available.
      // `positionSzi` on Fill is the signed position AFTER the fill on the live path, but
      // in our seeder we stored startPosition before the fill. Work out the resulting position:
      //   side 'B' adds size, side 'A' subtracts size → new = startPosition + (B? size : -size)
      const delta = f.side === 'B' ? f.size : -f.size;
      const prev = currentPositions.get(f.symbol) ?? 0;
      currentPositions.set(f.symbol, prev + delta);
      fillIdx++;
    }

    // Snapshot
    const btcSize = currentPositions.get('BTC') ?? 0;
    const btcDir: 'long' | 'short' | 'flat' = btcSize > 0 ? 'long' : btcSize < 0 ? 'short' : 'flat';
    let anyLong = false;
    let anyShort = false;
    let netNotional = 0;
    for (const [sym, sz] of currentPositions) {
      if (sz > 0) anyLong = true;
      else if (sz < 0) anyShort = true;
      // Rough notional — use last known fill price isn't tracked here, just use size as a proxy
      netNotional += sz;
    }

    states.set(h, {
      timestamp: new Date(h),
      positions: new Map(currentPositions),
      btcDirection: btcDir,
      anySymbolLong: anyLong,
      anySymbolShort: anyShort,
      totalNetNotionalSigned: netNotional,
    });
  }

  return states;
}

// =============================================================================

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function hourFloor(ts: Date): number {
  return Math.floor(ts.getTime() / (3600 * 1000)) * (3600 * 1000);
}

async function main() {
  console.log(`\n📊 Sentiment correlation analysis — ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}\n`);

  // ========================================================================
  // 1. Build hourly states for each sentiment wallet
  // ========================================================================
  console.log('━━━ Building hourly state timelines ━━━');
  const sentimentStates = new Map<string, Map<number, HourlyState>>();
  for (const s of SENTIMENT_WALLETS) {
    const states = await buildHourlyStates(s.address, s.label);
    sentimentStates.set(s.label, states);
    // Quick stats
    const nonFlatHours = Array.from(states.values()).filter((st) => st.btcDirection !== 'flat').length;
    const longHours = Array.from(states.values()).filter((st) => st.btcDirection === 'long').length;
    const shortHours = Array.from(states.values()).filter((st) => st.btcDirection === 'short').length;
    console.log(
      `    BTC position coverage: ${nonFlatHours}/${states.size} hours  ` +
      `(${longHours} long, ${shortHours} short, ${states.size - nonFlatHours} flat)`
    );
  }

  // ========================================================================
  // 2. Build target entry events
  // ========================================================================
  console.log('\n━━━ Building target entry events ━━━');
  const targetTrades = await prisma.trade.findMany({
    where: {
      traderAddress: TARGET,
      timestamp: { gte: START, lte: END },
    },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`  ${targetTrades.length} target trades in window`);

  // Also build hourly position state for the TARGET itself (so we know their BTC direction at entry time)
  const targetStates = await buildHourlyStates(TARGET, 'target');

  // ========================================================================
  // 3. Alignment analysis: how often does sentiment agree with target at entry?
  // ========================================================================
  console.log('\n━━━ Alignment at target entry time ━━━');
  console.log('Question: when target opens a LONG/SHORT, what is each sentiment wallet doing?');
  console.log();

  const alignmentRows: Array<{
    wallet: string;
    targetLongs: number; targetShorts: number;
    wallSameDirOnLong: number; wallOppDirOnLong: number; wallFlatOnLong: number;
    wallSameDirOnShort: number; wallOppDirOnShort: number; wallFlatOnShort: number;
  }> = [];

  for (const s of SENTIMENT_WALLETS) {
    const states = sentimentStates.get(s.label)!;
    let tL = 0, tS = 0;
    let sameOnL = 0, oppOnL = 0, flatOnL = 0;
    let sameOnS = 0, oppOnS = 0, flatOnS = 0;

    for (const t of targetTrades) {
      const hr = hourFloor(t.timestamp);
      const st = states.get(hr);
      if (!st) continue;

      if (t.side === 'long') {
        tL++;
        if (st.btcDirection === 'long') sameOnL++;
        else if (st.btcDirection === 'short') oppOnL++;
        else flatOnL++;
      } else if (t.side === 'short') {
        tS++;
        if (st.btcDirection === 'short') sameOnS++;
        else if (st.btcDirection === 'long') oppOnS++;
        else flatOnS++;
      }
    }

    alignmentRows.push({
      wallet: s.label,
      targetLongs: tL, targetShorts: tS,
      wallSameDirOnLong: sameOnL, wallOppDirOnLong: oppOnL, wallFlatOnLong: flatOnL,
      wallSameDirOnShort: sameOnS, wallOppDirOnShort: oppOnS, wallFlatOnShort: flatOnS,
    });
  }

  console.log('When target opens a LONG (any symbol):');
  console.log('Wallet            n     sameBTC    oppBTC     flat');
  console.log('─'.repeat(60));
  for (const r of alignmentRows) {
    const n = r.targetLongs;
    console.log(
      '  ' + r.wallet.padEnd(18) +
      n.toString().padStart(5) +
      ('  ' + fmtPct(r.wallSameDirOnLong / n)).padStart(12) +
      ('  ' + fmtPct(r.wallOppDirOnLong / n)).padStart(12) +
      ('  ' + fmtPct(r.wallFlatOnLong / n)).padStart(10)
    );
  }

  console.log('\nWhen target opens a SHORT (any symbol):');
  console.log('Wallet            n     sameBTC    oppBTC     flat');
  console.log('─'.repeat(60));
  for (const r of alignmentRows) {
    const n = r.targetShorts;
    if (n === 0) { console.log('  ' + r.wallet.padEnd(18) + '  no shorts'); continue; }
    console.log(
      '  ' + r.wallet.padEnd(18) +
      n.toString().padStart(5) +
      ('  ' + fmtPct(r.wallSameDirOnShort / n)).padStart(12) +
      ('  ' + fmtPct(r.wallOppDirOnShort / n)).padStart(12) +
      ('  ' + fmtPct(r.wallFlatOnShort / n)).padStart(10)
    );
  }

  // ========================================================================
  // 4. Predictiveness: given a sentiment state at time T, what is P(target entry in T..T+4h | state)?
  // ========================================================================
  console.log('\n━━━ Predictiveness: sentiment → target entry ━━━');
  console.log('Question: given a sentiment wallet\'s BTC direction, how likely is target to enter a long/short in the next 4h?\n');

  // Precompute target entries by hour bucket for fast lookup
  const targetEntriesByHour = new Map<number, { longs: number; shorts: number }>();
  for (const t of targetTrades) {
    const h = hourFloor(t.timestamp);
    const entry = targetEntriesByHour.get(h) ?? { longs: 0, shorts: 0 };
    if (t.side === 'long') entry.longs++;
    else if (t.side === 'short') entry.shorts++;
    targetEntriesByHour.set(h, entry);
  }

  // For each sentiment wallet, bucket hours by BTC direction
  for (const s of SENTIMENT_WALLETS) {
    const states = sentimentStates.get(s.label)!;
    console.log(`${s.label}:`);
    for (const direction of ['long', 'short', 'flat'] as const) {
      const matchingHours = Array.from(states.entries()).filter(([_, st]) => st.btcDirection === direction);
      if (matchingHours.length === 0) continue;

      let longsIn4h = 0, shortsIn4h = 0;
      for (const [h, _] of matchingHours) {
        for (let dh = 0; dh < 4; dh++) {
          const e = targetEntriesByHour.get(h + dh * 3600 * 1000);
          if (e) { longsIn4h += e.longs; shortsIn4h += e.shorts; }
        }
      }
      const n = matchingHours.length;
      const longsPerHour = longsIn4h / n;
      const shortsPerHour = shortsIn4h / n;
      console.log(
        `  BTC ${direction.padEnd(5)}  n=${n.toString().padStart(4)}  ` +
        `target longs/h next 4h: ${longsPerHour.toFixed(2).padStart(6)}   ` +
        `target shorts/h next 4h: ${shortsPerHour.toFixed(2).padStart(6)}`
      );
    }
    console.log();
  }

  // ========================================================================
  // 5. Comparison vs our BTC EMA regime detector
  // ========================================================================
  console.log('━━━ Comparison: sentiment vs BTC EMA macro regime ━━━');
  console.log('Question: does a sentiment signal predict target direction better than our current EMA-based regime detector?\n');

  // Load BTC EMA indicators
  const btcInds = await prisma.technicalIndicator.findMany({
    where: {
      symbol: 'BTC',
      timeframe: '1h',
      timestamp: { gte: START, lte: END },
    },
    orderBy: { timestamp: 'asc' },
  });
  const btcCandlesFull = await prisma.candle.findMany({
    where: { symbol: 'BTC', timeframe: '1h', timestamp: { gte: START, lte: END } },
    orderBy: { timestamp: 'asc' },
  });
  const btcPriceMap = new Map(btcCandlesFull.map((c) => [c.timestamp.getTime(), c.close]));
  const btcIndMap = new Map(btcInds.map((i) => [i.timestamp.getTime(), i]));

  // Classify each hour by: (a) our EMA regime, (b) archangel direction, (c) bitcoin-ma direction, (d) consensus
  const classifications: Array<{ hour: number; emaRegime: string; archangel: string; bitcoinMa: string; consensus: string }> = [];
  for (let h = START.getTime(); h <= END.getTime(); h += 3600 * 1000) {
    const btcPrice = btcPriceMap.get(h);
    const btcInd = btcIndMap.get(h);
    if (!btcPrice || !btcInd || !btcInd.ema50 || !btcInd.ema200 || !btcInd.macdHist) continue;

    // Simplified EMA regime
    let regime: 'bull' | 'bear' | 'neutral' = 'neutral';
    let signals = 0;
    if (btcPrice > btcInd.ema50) signals++; else signals--;
    if (btcPrice > btcInd.ema200) signals++; else signals--;
    if (btcInd.macdHist > 0) signals++; else signals--;
    if (signals >= 2) regime = 'bull';
    else if (signals <= -2) regime = 'bear';

    const archangel = sentimentStates.get('archangel')!.get(h)?.btcDirection ?? 'flat';
    const bitcoinMa = sentimentStates.get('bitcoin-ma')!.get(h)?.btcDirection ?? 'flat';

    let consensus: string;
    if (archangel === bitcoinMa) consensus = archangel;
    else if (archangel === 'flat') consensus = bitcoinMa;
    else if (bitcoinMa === 'flat') consensus = archangel;
    else consensus = 'disagree';

    classifications.push({ hour: h, emaRegime: regime, archangel, bitcoinMa, consensus });
  }

  console.log(`Classified ${classifications.length} hours\n`);

  // For each classifier, compute target's direction distribution within next 4h windows
  const classifiers = [
    { name: 'EMA regime', key: (c: any) => c.emaRegime },
    { name: 'Archangel BTC', key: (c: any) => c.archangel },
    { name: 'Bitcoin MA BTC', key: (c: any) => c.bitcoinMa },
    { name: 'Consensus', key: (c: any) => c.consensus },
  ];

  for (const cls of classifiers) {
    const buckets = new Map<string, { hours: number; targetLongs: number; targetShorts: number }>();
    for (const c of classifications) {
      const k = cls.key(c);
      const b = buckets.get(k) ?? { hours: 0, targetLongs: 0, targetShorts: 0 };
      b.hours++;
      for (let dh = 0; dh < 4; dh++) {
        const e = targetEntriesByHour.get(c.hour + dh * 3600 * 1000);
        if (e) { b.targetLongs += e.longs; b.targetShorts += e.shorts; }
      }
      buckets.set(k, b);
    }

    console.log(`${cls.name}:`);
    for (const [k, b] of buckets) {
      if (b.hours === 0) continue;
      const total = b.targetLongs + b.targetShorts;
      if (total === 0) {
        console.log(`  ${k.padEnd(10)}  n=${b.hours.toString().padStart(4)}  no target entries`);
        continue;
      }
      const longPct = (b.targetLongs / total) * 100;
      console.log(
        `  ${k.padEnd(10)}  n=${b.hours.toString().padStart(4)}  ` +
        `total entries: ${total.toString().padStart(4)}  ` +
        `longs ${longPct.toFixed(0).padStart(3)}%  shorts ${(100 - longPct).toFixed(0).padStart(3)}%  ` +
        `longs/h ${(b.targetLongs / b.hours).toFixed(2).padStart(5)}  ` +
        `shorts/h ${(b.targetShorts / b.hours).toFixed(2).padStart(5)}`
      );
    }
    console.log();
  }

  // ========================================================================
  // 6. Information gain: does sentiment give us signal beyond EMA regime?
  // ========================================================================
  console.log('━━━ Conditional: does sentiment add info ON TOP of EMA regime? ━━━\n');

  // For each EMA regime, further split by archangel direction
  const grid = new Map<string, { hours: number; longs: number; shorts: number }>();
  for (const c of classifications) {
    const k = `${c.emaRegime} + archangel=${c.archangel}`;
    const b = grid.get(k) ?? { hours: 0, longs: 0, shorts: 0 };
    b.hours++;
    for (let dh = 0; dh < 4; dh++) {
      const e = targetEntriesByHour.get(c.hour + dh * 3600 * 1000);
      if (e) { b.longs += e.longs; b.shorts += e.shorts; }
    }
    grid.set(k, b);
  }

  const sorted = Array.from(grid.entries()).sort((a, b) => b[1].hours - a[1].hours);
  console.log('Combo'.padEnd(40) + 'Hours'.padStart(7) + 'TgtL/h'.padStart(10) + 'TgtS/h'.padStart(10) + 'long%'.padStart(8));
  console.log('─'.repeat(80));
  for (const [k, b] of sorted) {
    if (b.hours < 10) continue;
    const total = b.longs + b.shorts;
    const longPct = total > 0 ? (b.longs / total) * 100 : 0;
    console.log(
      k.padEnd(40) +
      b.hours.toString().padStart(7) +
      (b.longs / b.hours).toFixed(2).padStart(10) +
      (b.shorts / b.hours).toFixed(2).padStart(10) +
      (longPct.toFixed(0) + '%').padStart(8)
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
