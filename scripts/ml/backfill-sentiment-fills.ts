/**
 * Backfill historical fills for sentiment-source wallets.
 *
 * Fetches fills via HL userFillsByTime for Archangel + Bitcoin MA over the
 * Jan 1 – Mar 15, 2026 window, writes to Fill table, then aggregates into
 * logical Trade rows using the same TWAP-window logic as StartupSync.
 *
 * Usage: npx tsx scripts/ml/backfill-sentiment-fills.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import * as hl from '@nktkas/hyperliquid';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const START_MS = new Date('2026-01-01T00:00:00Z').getTime();
const END_MS = new Date('2026-03-15T00:00:00Z').getTime();

const WALLETS: Array<{ address: `0x${string}`; label: string }> = [
  { address: '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0', label: 'archangel' },
  { address: '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768', label: 'bitcoin-ma' },
];

const TWAP_WINDOW_SECONDS = 300;

async function backfillWallet(wallet: `0x${string}`, label: string): Promise<{ imported: number; duplicates: number; tradesCreated: number }> {
  console.log(`\n━━━ ${label} (${wallet}) ━━━`);

  const transport = new hl.HttpTransport({ timeout: 30000 });
  const info = new hl.InfoClient({ transport });

  let cursor = START_MS;
  let totalFetched = 0;
  let imported = 0;
  let duplicates = 0;
  let pages = 0;

  while (cursor < END_MS) {
    pages++;
    console.log(`  📡 Page ${pages} from ${new Date(cursor).toISOString()}`);

    const apiFills = await info.userFillsByTime({
      user: wallet,
      startTime: cursor,
      endTime: END_MS,
      aggregateByTime: false,
    });

    if (apiFills.length === 0) {
      console.log(`    (no fills)`);
      break;
    }

    totalFetched += apiFills.length;

    for (const fill of apiFills) {
      // Defensive: skip fills outside window
      if (fill.time < START_MS || fill.time > END_MS) continue;
      try {
        await prisma.fill.create({
          data: {
            fillId: String(fill.tid ?? fill.oid),
            timestamp: new Date(fill.time),
            traderAddress: wallet,
            symbol: fill.coin,
            side: fill.side, // 'B' or 'A'
            price: parseFloat(fill.px),
            size: parseFloat(fill.sz),
            positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
            rawData: fill as any,
          },
        });
        imported++;
      } catch (e: any) {
        if (e.code === 'P2002') duplicates++;
        else console.error(`    ❌ ${fill.tid}: ${e.message}`);
      }
    }

    console.log(`    ${apiFills.length} fills, ${imported} total imported, ${duplicates} dupes`);

    // Advance cursor beyond last fill in batch
    const maxFillTime = Math.max(...apiFills.map((f) => f.time));
    if (maxFillTime <= cursor) break; // no progress, avoid infinite loop
    cursor = maxFillTime + 1;

    // Small delay between paginated calls to be polite
    await new Promise((r) => setTimeout(r, 400));

    if (apiFills.length < 2000) {
      // Last page if fewer than max
      break;
    }
  }

  console.log(`  ✅ Fetched ${totalFetched}, imported ${imported}, duplicates ${duplicates}`);

  // Aggregate into Trade rows
  const tradesCreated = await aggregateFillsToTrades(wallet, label);
  return { imported, duplicates, tradesCreated };
}

async function aggregateFillsToTrades(wallet: `0x${string}`, label: string): Promise<number> {
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: wallet,
      aggregateTradeId: null,
      timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) },
    },
    orderBy: { timestamp: 'asc' },
  });

  if (fills.length === 0) {
    console.log(`  No unaggregated fills to process`);
    return 0;
  }

  console.log(`  🔄 Aggregating ${fills.length} fills into trades...`);

  let currentTrade: {
    symbol: string;
    side: 'long' | 'short';
    fills: typeof fills;
    firstFillTime: number;
    lastFillTime: number;
    totalSize: number;
  } | null = null;

  let tradesCreated = 0;

  const finalize = async (t: NonNullable<typeof currentTrade>) => {
    const avgPrice = t.fills.reduce((s, f) => s + f.price * f.size, 0) / t.totalSize;
    const duration = (t.lastFillTime - t.firstFillTime) / 1000;
    const firstFillPrice = t.fills[0].price;
    const worstSlippage = t.fills.reduce((worst, f) => {
      const slippage = Math.abs((f.price - firstFillPrice) / firstFillPrice) * 10000;
      return Math.max(worst, slippage);
    }, 0);

    const createdTrade = await prisma.trade.create({
      data: {
        timestamp: new Date(t.firstFillTime),
        trader: 'target', // treat as historical target for this analysis
        traderAddress: wallet,
        symbol: t.symbol,
        side: t.side,
        entryPrice: avgPrice,
        size: t.totalSize,
        leverage: 1,
        isTwapOrder: t.fills.length > 1,
        fillCount: t.fills.length,
        twapDurationSeconds: Math.round(duration),
        avgEntryPrice: avgPrice,
        worstSlippage,
      },
    });

    for (let i = 0; i < t.fills.length; i++) {
      await prisma.fill.update({
        where: { id: t.fills[i].id },
        data: {
          aggregateTradeId: createdTrade.id,
          isFirstFill: i === 0,
          isLastFill: i === t.fills.length - 1,
        },
      });
    }
    tradesCreated++;
  };

  for (let i = 0; i < fills.length; i++) {
    const fill = fills[i];
    const fillTime = fill.timestamp.getTime();

    if (!currentTrade) {
      currentTrade = {
        symbol: fill.symbol,
        side: fill.side === 'B' ? 'long' : 'short',
        fills: [fill],
        firstFillTime: fillTime,
        lastFillTime: fillTime,
        totalSize: fill.size,
      };
    } else {
      const sameSym = fill.symbol === currentTrade.symbol;
      const sameDir = (fill.side === 'B' && currentTrade.side === 'long') || (fill.side === 'A' && currentTrade.side === 'short');
      const withinWindow = (fillTime - currentTrade.lastFillTime) / 1000 < TWAP_WINDOW_SECONDS;

      if (sameSym && sameDir && withinWindow) {
        currentTrade.fills.push(fill);
        currentTrade.lastFillTime = fillTime;
        currentTrade.totalSize += fill.size;
      } else {
        await finalize(currentTrade);
        currentTrade = {
          symbol: fill.symbol,
          side: fill.side === 'B' ? 'long' : 'short',
          fills: [fill],
          firstFillTime: fillTime,
          lastFillTime: fillTime,
          totalSize: fill.size,
        };
      }
    }

    if (i === fills.length - 1 && currentTrade) {
      await finalize(currentTrade);
    }
  }

  console.log(`  ✅ Created ${tradesCreated} logical trades`);
  return tradesCreated;
}

async function main() {
  console.log(`\n🔄 Backfilling sentiment wallet fills`);
  console.log(`   Window: ${new Date(START_MS).toISOString()} → ${new Date(END_MS).toISOString()}\n`);

  for (const { address, label } of WALLETS) {
    const res = await backfillWallet(address, label);
    console.log(`\nSummary ${label}: ${res.imported} fills, ${res.tradesCreated} trades (${res.duplicates} dupes)\n`);
  }

  // Final verification
  console.log('\n━━━ Final verification ━━━');
  for (const { address, label } of WALLETS) {
    const fills = await prisma.fill.count({
      where: { traderAddress: address, timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } },
    });
    const trades = await prisma.trade.count({
      where: { traderAddress: address, timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } },
    });
    const first = await prisma.fill.findFirst({
      where: { traderAddress: address, timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } },
      orderBy: { timestamp: 'asc' },
    });
    const last = await prisma.fill.findFirst({
      where: { traderAddress: address, timestamp: { gte: new Date(START_MS), lte: new Date(END_MS) } },
      orderBy: { timestamp: 'desc' },
    });
    console.log(
      `  ${label.padEnd(12)} ${fills} fills, ${trades} trades  ` +
      `${first?.timestamp.toISOString().slice(0, 10) ?? '-'} → ${last?.timestamp.toISOString().slice(0, 10) ?? '-'}`
    );
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
