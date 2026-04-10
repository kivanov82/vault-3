/**
 * Target vs Sentiment — position-state correlation.
 *
 * For every hour in Jan 1 - Mar 15, compute the BTC position DIRECTION
 * (long/short/flat) for target + Archangel + Bitcoin MA using cumulative
 * signed deltas from fills.
 *
 * Then measure:
 *   - Agreement rate (% of hours where target direction == sentiment direction)
 *   - Conditional: when target is long, what % of time is Archangel long/short/flat?
 *   - Lead/lag: does sentiment flip BEFORE target, AFTER target, or SAME time?
 *
 * This answers: is target CONTRARY to sentiment, FOLLOWING sentiment, or INDEPENDENT?
 *
 * Usage: npx tsx scripts/ml/position-state-correlation.ts
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
const ARCHANGEL = '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0';
const BITCOIN_MA = '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768';

type Dir = 'long' | 'short' | 'flat';

async function buildBtcPositionTimeline(wallet: string, label: string): Promise<Map<number, Dir>> {
  const fills = await prisma.fill.findMany({
    where: { traderAddress: wallet, symbol: 'BTC', timestamp: { gte: START, lte: END } },
    orderBy: { timestamp: 'asc' },
  });

  // Infer initial position: if earliest fills are "Close *", the prior position was non-zero
  let initialPos = 0;
  const firstOpenOrFlipIdx = fills.findIndex((f) => {
    const d = (f.rawData as any)?.dir ?? '';
    return d.startsWith('Open ') || d.includes(' > ');
  });
  if (firstOpenOrFlipIdx > 0) {
    // Sum deltas of the Close prelude — opposite = initial
    let sum = 0;
    for (let i = 0; i < firstOpenOrFlipIdx; i++) {
      const f = fills[i];
      sum += f.side === 'B' ? f.size : -f.size;
    }
    initialPos = -sum;
  }

  console.log(`  ${label}: ${fills.length} BTC fills, inferred initial position: ${initialPos.toFixed(4)}`);

  const states = new Map<number, Dir>();
  let cum = initialPos;
  let fi = 0;
  for (let h = START.getTime(); h <= END.getTime(); h += 3600 * 1000) {
    while (fi < fills.length && fills[fi].timestamp.getTime() <= h) {
      const f = fills[fi];
      cum += f.side === 'B' ? f.size : -f.size;
      fi++;
    }
    const dir: Dir = cum > 1e-6 ? 'long' : cum < -1e-6 ? 'short' : 'flat';
    states.set(h, dir);
  }

  // Sanity print: distribution
  const dist = { long: 0, short: 0, flat: 0 };
  for (const d of states.values()) dist[d]++;
  const tot = states.size;
  console.log(
    `    Time distribution: long ${((dist.long / tot) * 100).toFixed(0)}% (${dist.long}h), ` +
    `short ${((dist.short / tot) * 100).toFixed(0)}% (${dist.short}h), ` +
    `flat ${((dist.flat / tot) * 100).toFixed(0)}% (${dist.flat}h)`
  );
  return states;
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

async function main() {
  console.log(`\n🔬 Position State Correlation — ${START.toISOString().slice(0, 10)} → ${END.toISOString().slice(0, 10)}\n`);

  console.log('Building BTC position timelines...');
  const targetStates = await buildBtcPositionTimeline(TARGET, 'target (0x4cb5)');
  const archangelStates = await buildBtcPositionTimeline(ARCHANGEL, 'archangel');
  const bitcoinMaStates = await buildBtcPositionTimeline(BITCOIN_MA, 'bitcoin-ma');

  // =============================================================
  // 1. Conditional distribution — when target is X, sentiment is Y
  // =============================================================
  console.log('\n━'.repeat(50));
  console.log('CONDITIONAL: when target is X, what is sentiment wallet doing?');
  console.log('━'.repeat(50));

  const wallets: Array<[string, Map<number, Dir>]> = [
    ['archangel', archangelStates],
    ['bitcoin-ma', bitcoinMaStates],
  ];

  for (const [label, walletStates] of wallets) {
    console.log(`\n${label}:`);
    const table = new Map<Dir, { long: number; short: number; flat: number; total: number }>();
    for (const d of ['long', 'short', 'flat'] as Dir[]) {
      table.set(d, { long: 0, short: 0, flat: 0, total: 0 });
    }

    for (const [h, tDir] of targetStates) {
      const wDir = walletStates.get(h) ?? 'flat';
      const row = table.get(tDir)!;
      row[wDir]++;
      row.total++;
    }

    console.log(`  Target state      ${label} long    ${label} short    ${label} flat    total`);
    console.log('  ' + '─'.repeat(70));
    for (const tDir of ['long', 'short', 'flat'] as Dir[]) {
      const row = table.get(tDir)!;
      if (row.total === 0) continue;
      console.log(
        `  ${tDir.padEnd(18)}` +
        `${row.long}(${fmtPct(row.long / row.total)})`.padStart(14) +
        `${row.short}(${fmtPct(row.short / row.total)})`.padStart(15) +
        `${row.flat}(${fmtPct(row.flat / row.total)})`.padStart(14) +
        row.total.toString().padStart(10)
      );
    }
  }

  // =============================================================
  // 2. Agreement & contrarian rate
  // =============================================================
  console.log('\n━'.repeat(50));
  console.log('AGREEMENT vs CONTRARIAN RATES');
  console.log('━'.repeat(50));

  for (const [label, walletStates] of wallets) {
    let agree = 0, contrary = 0, eitherFlat = 0, bothFlat = 0;
    for (const [h, tDir] of targetStates) {
      const wDir = walletStates.get(h) ?? 'flat';
      if (tDir === 'flat' && wDir === 'flat') bothFlat++;
      else if (tDir === 'flat' || wDir === 'flat') eitherFlat++;
      else if (tDir === wDir) agree++;
      else contrary++;
    }
    const directional = agree + contrary;
    console.log(`\n${label}:`);
    console.log(`  Both directional (both long or both short or opposite): ${directional}h`);
    console.log(`    Agree (same direction):    ${agree} (${fmtPct(agree / directional)})`);
    console.log(`    Contrary (opposite):        ${contrary} (${fmtPct(contrary / directional)})`);
    console.log(`  Either flat: ${eitherFlat}h`);
    console.log(`  Both flat:   ${bothFlat}h`);
  }

  // =============================================================
  // 3. Lead/lag: when target flips BTC direction, when does sentiment flip?
  // =============================================================
  console.log('\n━'.repeat(50));
  console.log('LEAD/LAG: flip timing');
  console.log('━'.repeat(50));

  // Find hours where target direction changed
  const targetHours = [...targetStates.keys()].sort((a, b) => a - b);
  const flips: Array<{ hour: number; from: Dir; to: Dir }> = [];
  let prev: Dir = targetStates.get(targetHours[0])!;
  for (let i = 1; i < targetHours.length; i++) {
    const cur = targetStates.get(targetHours[i])!;
    if (cur !== prev && (cur !== 'flat' && prev !== 'flat')) {
      flips.push({ hour: targetHours[i], from: prev, to: cur });
    }
    prev = cur;
  }
  console.log(`\nTarget BTC directional flips (long↔short): ${flips.length}`);

  // For each flip, find when each sentiment wallet flipped to match (or opposite)
  for (const [label, walletStates] of wallets) {
    let leadSum = 0, leadCount = 0;
    let lagSum = 0, lagCount = 0;
    let sameHour = 0;
    let neverMatched = 0;

    for (const flip of flips) {
      // Find when sentiment wallet's state became `flip.to` or went flat around this time
      // Search ±168h (±7 days)
      let leadHours: number | null = null;
      for (let dh = 1; dh <= 168; dh++) {
        const wBefore = walletStates.get(flip.hour - dh * 3600000);
        if (wBefore === flip.to) { leadHours = dh; break; }
      }
      let lagHours: number | null = null;
      for (let dh = 1; dh <= 168; dh++) {
        const wAfter = walletStates.get(flip.hour + dh * 3600000);
        if (wAfter === flip.to) { lagHours = dh; break; }
      }

      const wSame = walletStates.get(flip.hour);
      if (wSame === flip.to) {
        sameHour++;
      } else if (leadHours !== null && (lagHours === null || leadHours <= lagHours)) {
        leadSum += leadHours;
        leadCount++;
      } else if (lagHours !== null) {
        lagSum += lagHours;
        lagCount++;
      } else {
        neverMatched++;
      }
    }
    console.log(`\n${label}:`);
    console.log(`  Sentiment at same direction ALREADY at flip: ${sameHour}`);
    console.log(`  Sentiment LED (flipped before target):       ${leadCount}   avg lead: ${leadCount > 0 ? (leadSum / leadCount).toFixed(0) + 'h' : '-'}`);
    console.log(`  Sentiment LAGGED (flipped after target):     ${lagCount}   avg lag: ${lagCount > 0 ? (lagSum / lagCount).toFixed(0) + 'h' : '-'}`);
    console.log(`  Never matched within ±168h:                  ${neverMatched}`);
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
