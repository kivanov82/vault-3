/**
 * Target Vault Behavioral Analysis (0x4cb5...)
 *
 * For every target trade in Jan 1 - Mar 15, snapshot all observable state
 * at entry time, and answer:
 *
 *   1. INDICATOR STATE at LONG vs SHORT entries
 *      - Is target contrarian to RSI / BB / MACD?
 *      - Distribution comparison long vs short
 *
 *   2. FUNDING / CROWD SENTIMENT at entries
 *      - Is target contrarian to funding (crowd long → target short)?
 *
 *   3. SENTIMENT WALLET STATE at entries
 *      - What are Archangel and Bitcoin MA doing when target enters?
 *
 *   4. HOLD TIME distribution by exit reason
 *      - Do they have consistent TP/SL behavior?
 *
 *   5. ENTRY/EXIT paired analysis — is there a discernible TP/SL pattern?
 *
 * Usage: npx tsx scripts/ml/target-behavior.ts
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

// Symbols we have indicators + sentiment + funding for
const SYMBOLS = ['HYPE', 'SOL', 'VVV', 'ETH', 'MON', 'FARTCOIN', 'BTC'];

interface Snapshot {
  symbol: string;
  side: 'long' | 'short';
  entryTime: Date;
  entryPrice: number;
  // Indicators at entry
  rsi14: number | null;
  bbPosition: number | null;
  macdHist: number | null;
  ema9: number | null;
  ema21: number | null;
  emaBullish: boolean | null;
  priceChange1h: number | null;
  priceChange4h: number | null;
  // Funding (crowd proxy)
  fundingRate: number | null;
  // BTC context
  btcChange7d: number | null;
  btcEmaRegime: 'bull' | 'bear' | 'neutral' | null;
  // Sentiment wallets
  archangelBtc: 'long' | 'short' | 'flat';
  bitcoinMaBtc: 'long' | 'short' | 'flat';
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function median(arr: number[]): number {
  return pctile(arr, 50);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtN(n: number, dec = 2): string {
  if (isNaN(n) || n === null || n === undefined) return '-';
  return n.toFixed(dec);
}

async function buildWalletPositions(wallet: string): Promise<Map<number, Map<string, number>>> {
  // For each hour, the position state (symbol -> signed size) for this wallet
  const fills = await prisma.fill.findMany({
    where: { traderAddress: wallet, timestamp: { gte: START, lte: END } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, symbol: true, side: true, size: true },
  });

  const states = new Map<number, Map<string, number>>();
  const current = new Map<string, number>();
  let fi = 0;

  for (let h = START.getTime(); h <= END.getTime(); h += 3600 * 1000) {
    while (fi < fills.length && fills[fi].timestamp.getTime() <= h) {
      const f = fills[fi];
      const delta = f.side === 'B' ? f.size : -f.size;
      current.set(f.symbol, (current.get(f.symbol) ?? 0) + delta);
      fi++;
    }
    states.set(h, new Map(current));
  }
  return states;
}

async function main() {
  console.log(`\n🔬 Target Behavioral Analysis — ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}\n`);

  // --- Load target trades ---
  const trades = await prisma.trade.findMany({
    where: { traderAddress: TARGET, timestamp: { gte: START, lte: END }, symbol: { in: SYMBOLS } },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`Target trades in scope: ${trades.length} (symbols with indicators: ${SYMBOLS.join(', ')})`);
  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');
  console.log(`  Longs: ${longs.length}, Shorts: ${shorts.length}`);

  // --- Build sentiment position timelines ---
  console.log('\nBuilding sentiment wallet state timelines...');
  const archangelStates = await buildWalletPositions('0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0');
  const bitcoinMaStates = await buildWalletPositions('0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768');

  // --- Load indicators and funding, indexed by (symbol, hour) ---
  console.log('Loading indicators...');
  const indRows = await prisma.technicalIndicator.findMany({
    where: { symbol: { in: SYMBOLS }, timeframe: '1h', timestamp: { gte: START, lte: END } },
  });
  const indMap = new Map<string, any>();
  for (const i of indRows) indMap.set(`${i.symbol}_${i.timestamp.getTime()}`, i);

  const candleRows = await prisma.candle.findMany({
    where: { symbol: { in: SYMBOLS }, timeframe: '1h', timestamp: { gte: START, lte: END } },
    select: { symbol: true, timestamp: true, close: true },
  });
  const priceMap = new Map<string, number>();
  for (const c of candleRows) priceMap.set(`${c.symbol}_${c.timestamp.getTime()}`, c.close);

  const fundingRows = await prisma.fundingRate.findMany({
    where: { symbol: { in: SYMBOLS }, timestamp: { gte: START, lte: END } },
  });
  // Funding is every 8h — for each trade, pick the most recent funding before the trade
  const fundingBySymbol = new Map<string, { ts: number; rate: number }[]>();
  for (const f of fundingRows) {
    if (!fundingBySymbol.has(f.symbol)) fundingBySymbol.set(f.symbol, []);
    fundingBySymbol.get(f.symbol)!.push({ ts: f.timestamp.getTime(), rate: f.rate });
  }
  for (const arr of fundingBySymbol.values()) arr.sort((a, b) => a.ts - b.ts);

  // --- For each target trade, build a Snapshot ---
  const snapshots: Snapshot[] = [];
  for (const t of trades) {
    const h = Math.floor(t.timestamp.getTime() / 3600000) * 3600000;
    const ind = indMap.get(`${t.symbol}_${h}`);
    if (!ind) continue; // skip if no indicator at this hour

    // BB position
    let bbPos: number | null = null;
    const price = priceMap.get(`${t.symbol}_${h}`) ?? t.entryPrice;
    if (ind.bbUpper != null && ind.bbLower != null && ind.bbUpper > ind.bbLower) {
      bbPos = (price - ind.bbLower) / (ind.bbUpper - ind.bbLower);
    }

    // Price change 1h / 4h — from candles
    const price1hAgo = priceMap.get(`${t.symbol}_${h - 3600000}`);
    const price4hAgo = priceMap.get(`${t.symbol}_${h - 4 * 3600000}`);
    const priceChange1h = price1hAgo ? ((price - price1hAgo) / price1hAgo) * 100 : null;
    const priceChange4h = price4hAgo ? ((price - price4hAgo) / price4hAgo) * 100 : null;

    // EMA bullish
    const emaBullish = ind.ema9 != null && ind.ema21 != null ? ind.ema9 > ind.ema21 : null;

    // Funding — most recent funding ≤ trade time
    const fArr = fundingBySymbol.get(t.symbol) ?? [];
    let fundingRate: number | null = null;
    for (let i = fArr.length - 1; i >= 0; i--) {
      if (fArr[i].ts <= t.timestamp.getTime()) {
        fundingRate = fArr[i].rate;
        break;
      }
    }

    // BTC context — load BTC indicators and price at same hour
    const btcInd = indMap.get(`BTC_${h}`);
    const btcPrice = priceMap.get(`BTC_${h}`);
    const btc7dAgoPrice = priceMap.get(`BTC_${h - 168 * 3600000}`);
    const btcChange7d = (btcPrice && btc7dAgoPrice) ? ((btcPrice - btc7dAgoPrice) / btc7dAgoPrice) * 100 : null;
    let btcEmaRegime: 'bull' | 'bear' | 'neutral' | null = null;
    if (btcInd?.ema50 && btcInd?.ema200 && btcInd?.macdHist != null && btcPrice) {
      let s = 0;
      s += btcPrice > btcInd.ema50 ? 1 : -1;
      s += btcPrice > btcInd.ema200 ? 1 : -1;
      s += btcInd.macdHist > 0 ? 1 : -1;
      btcEmaRegime = s >= 2 ? 'bull' : s <= -2 ? 'bear' : 'neutral';
    }

    // Sentiment wallet BTC direction
    const archangelBtcSize = archangelStates.get(h)?.get('BTC') ?? 0;
    const archangelBtc: 'long' | 'short' | 'flat' = archangelBtcSize > 1e-6 ? 'long' : archangelBtcSize < -1e-6 ? 'short' : 'flat';
    const bmaBtcSize = bitcoinMaStates.get(h)?.get('BTC') ?? 0;
    const bitcoinMaBtc: 'long' | 'short' | 'flat' = bmaBtcSize > 1e-6 ? 'long' : bmaBtcSize < -1e-6 ? 'short' : 'flat';

    snapshots.push({
      symbol: t.symbol,
      side: t.side as 'long' | 'short',
      entryTime: t.timestamp,
      entryPrice: t.entryPrice,
      rsi14: ind.rsi14,
      bbPosition: bbPos,
      macdHist: ind.macdHist,
      ema9: ind.ema9,
      ema21: ind.ema21,
      emaBullish,
      priceChange1h,
      priceChange4h,
      fundingRate,
      btcChange7d,
      btcEmaRegime,
      archangelBtc,
      bitcoinMaBtc,
    });
  }

  console.log(`Built ${snapshots.length} snapshots with full feature set\n`);
  const longSnaps = snapshots.filter((s) => s.side === 'long');
  const shortSnaps = snapshots.filter((s) => s.side === 'short');

  // ============================================================
  // 1. INDICATOR STATE at entries
  // ============================================================
  console.log('━'.repeat(80));
  console.log('1. INDICATOR STATE AT ENTRY');
  console.log('━'.repeat(80));
  console.log(`                               LONG entries (n=${longSnaps.length})    SHORT entries (n=${shortSnaps.length})`);
  console.log(`                               median    p25    p75       median    p25    p75`);
  console.log('─'.repeat(80));

  const fields: { name: string; key: (s: Snapshot) => number | null }[] = [
    { name: 'RSI14',               key: (s) => s.rsi14 },
    { name: 'BB position (0-1)',   key: (s) => s.bbPosition },
    { name: 'MACD histogram',      key: (s) => s.macdHist },
    { name: 'Price change 1h %',   key: (s) => s.priceChange1h },
    { name: 'Price change 4h %',   key: (s) => s.priceChange4h },
    { name: 'Funding rate %',      key: (s) => s.fundingRate },
    { name: 'BTC 7d change %',     key: (s) => s.btcChange7d },
  ];

  for (const f of fields) {
    const lVals = longSnaps.map(f.key).filter((v): v is number => v !== null && !isNaN(v));
    const sVals = shortSnaps.map(f.key).filter((v): v is number => v !== null && !isNaN(v));
    console.log(
      f.name.padEnd(30) +
      fmtN(median(lVals), 2).padStart(8) +
      fmtN(pctile(lVals, 25), 2).padStart(8) +
      fmtN(pctile(lVals, 75), 2).padStart(8) +
      '       ' +
      fmtN(median(sVals), 2).padStart(8) +
      fmtN(pctile(sVals, 25), 2).padStart(8) +
      fmtN(pctile(sVals, 75), 2).padStart(8)
    );
  }

  // EMA bullish% at entries
  const lBull = longSnaps.filter((s) => s.emaBullish === true).length;
  const sBull = shortSnaps.filter((s) => s.emaBullish === true).length;
  console.log(
    '% entries with EMA9 > EMA21'.padEnd(30) +
    ((lBull / longSnaps.length) * 100).toFixed(0).padStart(8) + '%' +
    '                     ' +
    ((sBull / shortSnaps.length) * 100).toFixed(0).padStart(8) + '%'
  );

  // ============================================================
  // 2. BTC Regime distribution at entries
  // ============================================================
  console.log('\n━'.repeat(80));
  console.log('2. BTC REGIME DISTRIBUTION AT TARGET ENTRIES');
  console.log('━'.repeat(80));
  const regimeDist = (snaps: Snapshot[]) => {
    const d = { bull: 0, bear: 0, neutral: 0, none: 0 };
    for (const s of snaps) {
      if (s.btcEmaRegime === null) d.none++;
      else d[s.btcEmaRegime]++;
    }
    return d;
  };
  const lRegime = regimeDist(longSnaps);
  const sRegime = regimeDist(shortSnaps);
  console.log('Regime'.padEnd(12) + 'Long entries'.padStart(15) + 'Short entries'.padStart(16));
  console.log('─'.repeat(45));
  for (const k of ['bull', 'bear', 'neutral', 'none'] as const) {
    const lPct = ((lRegime[k] / longSnaps.length) * 100).toFixed(0);
    const sPct = ((sRegime[k] / shortSnaps.length) * 100).toFixed(0);
    console.log(
      k.padEnd(12) +
      `${lRegime[k]} (${lPct}%)`.padStart(15) +
      `${sRegime[k]} (${sPct}%)`.padStart(16)
    );
  }

  // ============================================================
  // 3. Funding rate CONTRARIAN test
  // ============================================================
  console.log('\n━'.repeat(80));
  console.log('3. CONTRARIAN vs CROWD TEST (funding as crowd proxy)');
  console.log('━'.repeat(80));
  console.log('Hypothesis: if target is contrarian, high funding (crowd long) → target short');
  console.log('             low/negative funding (crowd short) → target long\n');

  // Bucket trades by funding
  const bucket = (snaps: Snapshot[]) => {
    const b = { highPos: 0, pos: 0, neutral: 0, neg: 0, highNeg: 0, none: 0 };
    for (const s of snaps) {
      if (s.fundingRate == null) { b.none++; continue; }
      if (s.fundingRate > 0.05) b.highPos++;
      else if (s.fundingRate > 0.01) b.pos++;
      else if (s.fundingRate > -0.01) b.neutral++;
      else if (s.fundingRate > -0.05) b.neg++;
      else b.highNeg++;
    }
    return b;
  };
  const lBuck = bucket(longSnaps);
  const sBuck = bucket(shortSnaps);
  console.log('Funding'.padEnd(22) + 'Target longs'.padStart(14) + 'Target shorts'.padStart(16) + 'Long share'.padStart(14));
  console.log('─'.repeat(70));
  for (const k of ['highPos', 'pos', 'neutral', 'neg', 'highNeg'] as const) {
    const tot = lBuck[k] + sBuck[k];
    if (tot === 0) continue;
    const lSh = ((lBuck[k] / tot) * 100).toFixed(0);
    const label = k === 'highPos' ? '> 0.05% (crowd LONG)' :
                  k === 'pos' ? '0.01-0.05%' :
                  k === 'neutral' ? '-0.01 to 0.01%' :
                  k === 'neg' ? '-0.05 to -0.01%' :
                  '< -0.05% (crowd SHORT)';
    console.log(
      label.padEnd(22) +
      lBuck[k].toString().padStart(14) +
      sBuck[k].toString().padStart(16) +
      (lSh + '%').padStart(14)
    );
  }

  // ============================================================
  // 4. Sentiment wallet state at target entries
  // ============================================================
  console.log('\n━'.repeat(80));
  console.log('4. SENTIMENT WALLET STATE AT TARGET ENTRIES');
  console.log('━'.repeat(80));
  const sentDist = (snaps: Snapshot[], key: (s: Snapshot) => string) => {
    const d = new Map<string, number>();
    for (const s of snaps) {
      const k = key(s);
      d.set(k, (d.get(k) ?? 0) + 1);
    }
    return d;
  };

  console.log('Archangel BTC direction at target entry:');
  console.log('           Target longs   Target shorts');
  console.log('─'.repeat(45));
  const lArch = sentDist(longSnaps, (s) => s.archangelBtc);
  const sArch = sentDist(shortSnaps, (s) => s.archangelBtc);
  for (const k of ['long', 'short', 'flat']) {
    const lc = lArch.get(k) ?? 0;
    const sc = sArch.get(k) ?? 0;
    console.log(
      k.padEnd(12) +
      `${lc} (${((lc / longSnaps.length) * 100).toFixed(0)}%)`.padStart(14) +
      `${sc} (${((sc / shortSnaps.length) * 100).toFixed(0)}%)`.padStart(17)
    );
  }

  console.log('\nBitcoin MA BTC direction at target entry:');
  console.log('           Target longs   Target shorts');
  console.log('─'.repeat(45));
  const lBma = sentDist(longSnaps, (s) => s.bitcoinMaBtc);
  const sBma = sentDist(shortSnaps, (s) => s.bitcoinMaBtc);
  for (const k of ['long', 'short', 'flat']) {
    const lc = lBma.get(k) ?? 0;
    const sc = sBma.get(k) ?? 0;
    console.log(
      k.padEnd(12) +
      `${lc} (${((lc / longSnaps.length) * 100).toFixed(0)}%)`.padStart(14) +
      `${sc} (${((sc / shortSnaps.length) * 100).toFixed(0)}%)`.padStart(17)
    );
  }

  // ============================================================
  // 5. Hold time + exit analysis
  // ============================================================
  console.log('\n━'.repeat(80));
  console.log('5. HOLD TIME & EXIT BEHAVIOR');
  console.log('━'.repeat(80));

  // Pair trades by symbol — assume consecutive same-symbol trades in opposite directions close the prior one
  // This is approximate but works for directional traders
  const bySymbol = new Map<string, typeof trades>();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  const holdHours: number[] = [];
  const longHolds: number[] = [];
  const shortHolds: number[] = [];

  for (const [, symTrades] of bySymbol) {
    for (let i = 0; i < symTrades.length - 1; i++) {
      if (symTrades[i].side !== symTrades[i + 1].side) {
        // Direction change — approximate close
        const h = (symTrades[i + 1].timestamp.getTime() - symTrades[i].timestamp.getTime()) / 3600000;
        if (h > 0 && h < 168 * 3) { // cap at 3 weeks
          holdHours.push(h);
          if (symTrades[i].side === 'long') longHolds.push(h);
          else shortHolds.push(h);
        }
      }
    }
  }

  console.log(`Paired direction-change events: ${holdHours.length}`);
  console.log(`  All:     median ${fmtN(median(holdHours))}h  p25 ${fmtN(pctile(holdHours, 25))}h  p75 ${fmtN(pctile(holdHours, 75))}h  mean ${fmtN(mean(holdHours))}h`);
  console.log(`  Longs:   median ${fmtN(median(longHolds))}h  p25 ${fmtN(pctile(longHolds, 25))}h  p75 ${fmtN(pctile(longHolds, 75))}h`);
  console.log(`  Shorts:  median ${fmtN(median(shortHolds))}h  p25 ${fmtN(pctile(shortHolds, 25))}h  p75 ${fmtN(pctile(shortHolds, 75))}h`);

  // Hold time buckets
  console.log('\nHold time distribution:');
  const holdBuckets = { '<1h': 0, '1-4h': 0, '4-12h': 0, '12-24h': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
  for (const h of holdHours) {
    if (h < 1) holdBuckets['<1h']++;
    else if (h < 4) holdBuckets['1-4h']++;
    else if (h < 12) holdBuckets['4-12h']++;
    else if (h < 24) holdBuckets['12-24h']++;
    else if (h < 72) holdBuckets['1-3d']++;
    else if (h < 168) holdBuckets['3-7d']++;
    else holdBuckets['>7d']++;
  }
  for (const [k, v] of Object.entries(holdBuckets)) {
    const pct = ((v / holdHours.length) * 100).toFixed(0);
    console.log(`  ${k.padEnd(8)} ${v.toString().padStart(5)} (${pct}%)`);
  }

  // ============================================================
  // 6. CONTRARIAN SIGNATURE summary
  // ============================================================
  console.log('\n━'.repeat(80));
  console.log('6. CONTRARIAN SIGNATURE ANALYSIS');
  console.log('━'.repeat(80));
  console.log('For each entry direction, how often was the indicator AGAINST it?\n');

  // Longs: how often was price DOWN (dip entry), RSI LOW (oversold), BB LOW (below lower)?
  const lDipCount = longSnaps.filter((s) => s.priceChange1h !== null && s.priceChange1h < -0.5).length;
  const lChaseCount = longSnaps.filter((s) => s.priceChange1h !== null && s.priceChange1h > 0.5).length;
  const lRsiLow = longSnaps.filter((s) => s.rsi14 !== null && s.rsi14 < 40).length;
  const lRsiHigh = longSnaps.filter((s) => s.rsi14 !== null && s.rsi14 > 60).length;
  const lBbLow = longSnaps.filter((s) => s.bbPosition !== null && s.bbPosition < 0.3).length;
  const lBbHigh = longSnaps.filter((s) => s.bbPosition !== null && s.bbPosition > 0.7).length;

  const sDipCount = shortSnaps.filter((s) => s.priceChange1h !== null && s.priceChange1h < -0.5).length;
  const sChaseCount = shortSnaps.filter((s) => s.priceChange1h !== null && s.priceChange1h > 0.5).length;
  const sRsiLow = shortSnaps.filter((s) => s.rsi14 !== null && s.rsi14 < 40).length;
  const sRsiHigh = shortSnaps.filter((s) => s.rsi14 !== null && s.rsi14 > 60).length;
  const sBbLow = shortSnaps.filter((s) => s.bbPosition !== null && s.bbPosition < 0.3).length;
  const sBbHigh = shortSnaps.filter((s) => s.bbPosition !== null && s.bbPosition > 0.7).length;

  const pct = (num: number, den: number) => den > 0 ? ((num / den) * 100).toFixed(0) + '%' : '-';

  console.log('LONG entries:');
  console.log(`  Price down 1h (-0.5%+):     ${pct(lDipCount, longSnaps.length)}  ← dip entry (contrarian)`);
  console.log(`  Price up 1h (+0.5%+):       ${pct(lChaseCount, longSnaps.length)}  ← chasing (trend-follow)`);
  console.log(`  RSI < 40 (oversold):        ${pct(lRsiLow, longSnaps.length)}  ← dip buy (contrarian)`);
  console.log(`  RSI > 60 (strong):          ${pct(lRsiHigh, longSnaps.length)}  ← breakout buy (trend-follow)`);
  console.log(`  BB < 0.3 (near lower):      ${pct(lBbLow, longSnaps.length)}  ← mean-reversion long (contrarian)`);
  console.log(`  BB > 0.7 (near upper):      ${pct(lBbHigh, longSnaps.length)}  ← breakout long (trend-follow)`);

  console.log('\nSHORT entries:');
  console.log(`  Price down 1h (-0.5%+):     ${pct(sDipCount, shortSnaps.length)}  ← trend-follow (down)`);
  console.log(`  Price up 1h (+0.5%+):       ${pct(sChaseCount, shortSnaps.length)}  ← contrarian short into bounce`);
  console.log(`  RSI < 40:                   ${pct(sRsiLow, shortSnaps.length)}  ← trend-follow (momentum down)`);
  console.log(`  RSI > 60:                   ${pct(sRsiHigh, shortSnaps.length)}  ← contrarian short into strength`);
  console.log(`  BB < 0.3:                   ${pct(sBbLow, shortSnaps.length)}  ← trend-follow (down)`);
  console.log(`  BB > 0.7:                   ${pct(sBbHigh, shortSnaps.length)}  ← contrarian short near top`);

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
