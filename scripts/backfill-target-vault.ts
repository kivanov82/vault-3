import { PrismaClient } from '@prisma/client';
import * as hl from '@nktkas/hyperliquid';
import dotenv from 'dotenv';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();

// For Prisma 7 with PostgreSQL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_VAULT = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

async function fetchUserFills(address: string): Promise<any[]> {
  console.log(`\n🔍 Fetching fills for ${address}...`);

  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });

  try {
    const response = await info.userFills({ user: address });

    console.log(`✅ Fetched ${response.length} total fills`);
    return response;
  } catch (error) {
    console.error('❌ Error fetching fills:', error);
    throw error;
  }
}

async function storeFills(fills: any[]): Promise<void> {
  console.log(`\n💾 Storing ${fills.length} fills in database...`);

  let stored = 0;
  let skipped = 0;

  for (const fill of fills) {
    try {
      await prisma.fill.create({
        data: {
          fillId: String(fill.oid),  // Convert to string
          timestamp: new Date(fill.time),
          traderAddress: TARGET_VAULT,
          symbol: fill.coin,
          side: fill.side,
          price: parseFloat(fill.px),
          size: parseFloat(fill.sz),
          positionSzi: fill.startPosition ? parseFloat(fill.startPosition) : 0,
          rawData: fill as any,
        },
      });
      stored++;
    } catch (error: any) {
      if (error.code === 'P2002') {
        // Unique constraint violation - fill already exists
        skipped++;
      } else {
        console.error(`Error storing fill ${fill.oid}:`, error.message);
      }
    }
  }

  console.log(`✅ Stored ${stored} new fills`);
  if (skipped > 0) {
    console.log(`ℹ️  Skipped ${skipped} duplicate fills`);
  }
}

async function aggregateFillsIntoTrades(): Promise<void> {
  console.log(`\n🔄 Aggregating fills into logical trades...`);

  const TWAP_WINDOW_SECONDS = 300; // 5 minutes

  // Get all fills for target vault, ordered by time
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: TARGET_VAULT,
      aggregateTradeId: null,  // Only process unaggregated fills
    },
    orderBy: { timestamp: 'asc' },
  });

  if (fills.length === 0) {
    console.log('ℹ️  No fills to aggregate');
    return;
  }

  console.log(`📊 Processing ${fills.length} fills...`);

  let currentTrade: {
    symbol: string;
    side: 'long' | 'short';
    fills: any[];
    firstFillTime: number;
    lastFillTime: number;
    totalSize: number;
  } | null = null;

  let tradesCreated = 0;

  for (let i = 0; i < fills.length; i++) {
    const fill = fills[i];
    const fillTime = fill.timestamp.getTime();

    if (!currentTrade) {
      // Start new trade
      currentTrade = {
        symbol: fill.symbol,
        side: fill.side === 'B' ? 'long' : 'short',
        fills: [fill],
        firstFillTime: fillTime,
        lastFillTime: fillTime,
        totalSize: fill.size,
      };
    } else {
      // Check if this fill belongs to current trade
      const isSameSymbol = fill.symbol === currentTrade.symbol;
      const isSameDirection = (fill.side === 'B' && currentTrade.side === 'long') ||
                              (fill.side === 'A' && currentTrade.side === 'short');
      const timeDiff = (fillTime - currentTrade.lastFillTime) / 1000;
      const isWithinWindow = timeDiff < TWAP_WINDOW_SECONDS;

      if (isSameSymbol && isSameDirection && isWithinWindow) {
        // Add to current trade
        currentTrade.fills.push(fill);
        currentTrade.lastFillTime = fillTime;
        currentTrade.totalSize += fill.size;
      } else {
        // Finalize current trade and start new one
        await finalizeTrade(currentTrade);
        tradesCreated++;

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

    // Finalize last trade in batch
    if (i === fills.length - 1 && currentTrade) {
      await finalizeTrade(currentTrade);
      tradesCreated++;
    }
  }

  console.log(`✅ Created ${tradesCreated} logical trades`);
}

async function finalizeTrade(trade: any): Promise<void> {
  // Calculate metrics
  const avgPrice = trade.fills.reduce((sum: number, f: any) => sum + f.price * f.size, 0) / trade.totalSize;
  const duration = (trade.lastFillTime - trade.firstFillTime) / 1000;

  const firstFillPrice = trade.fills[0].price;
  const worstSlippage = trade.fills.reduce((worst: number, f: any) => {
    const slippage = Math.abs((f.price - firstFillPrice) / firstFillPrice) * 10000; // bps
    return Math.max(worst, slippage);
  }, 0);

  // Create Trade record
  const createdTrade = await prisma.trade.create({
    data: {
      timestamp: new Date(trade.firstFillTime),
      trader: 'target',
      traderAddress: TARGET_VAULT,
      symbol: trade.symbol,
      side: trade.side,
      entryPrice: avgPrice,
      size: trade.totalSize,
      leverage: 1, // We don't have leverage info from fills, will need to estimate
      isTwapOrder: trade.fills.length > 1,
      fillCount: trade.fills.length,
      twapDurationSeconds: Math.round(duration),
      avgEntryPrice: avgPrice,
      worstSlippage: worstSlippage,
    },
  });

  // Update fills with aggregateTradeId
  for (let i = 0; i < trade.fills.length; i++) {
    await prisma.fill.update({
      where: { id: trade.fills[i].id },
      data: {
        aggregateTradeId: createdTrade.id,
        isFirstFill: i === 0,
        isLastFill: i === trade.fills.length - 1,
      },
    });
  }
}

async function generateSummaryReport(): Promise<void> {
  console.log(`\n📊 Generating summary report...\n`);

  // Total fills
  const totalFills = await prisma.fill.count({
    where: { traderAddress: TARGET_VAULT },
  });

  // Total trades
  const totalTrades = await prisma.trade.count({
    where: { traderAddress: TARGET_VAULT },
  });

  // Trades by symbol
  const tradesBySymbol = await prisma.trade.groupBy({
    by: ['symbol'],
    where: { traderAddress: TARGET_VAULT },
    _count: { symbol: true },
    orderBy: { _count: { symbol: 'desc' } },
  });

  // TWAP vs single fills
  const twapTrades = await prisma.trade.count({
    where: {
      traderAddress: TARGET_VAULT,
      isTwapOrder: true,
    },
  });

  // Date range
  const oldestFill = await prisma.fill.findFirst({
    where: { traderAddress: TARGET_VAULT },
    orderBy: { timestamp: 'asc' },
  });

  const newestFill = await prisma.fill.findFirst({
    where: { traderAddress: TARGET_VAULT },
    orderBy: { timestamp: 'desc' },
  });

  console.log('═══════════════════════════════════════════════');
  console.log('          TARGET VAULT BACKFILL SUMMARY        ');
  console.log('═══════════════════════════════════════════════');
  console.log(`Target Vault: ${TARGET_VAULT}`);
  console.log(`Date Range: ${oldestFill?.timestamp.toISOString().split('T')[0]} to ${newestFill?.timestamp.toISOString().split('T')[0]}`);
  console.log(`\n📈 Statistics:`);
  console.log(`   Total Fills: ${totalFills}`);
  console.log(`   Logical Trades: ${totalTrades}`);
  console.log(`   TWAP Trades: ${twapTrades} (${((twapTrades / totalTrades) * 100).toFixed(1)}%)`);
  console.log(`   Single Fill Trades: ${totalTrades - twapTrades}`);
  console.log(`\n💰 Most Traded Assets:`);

  tradesBySymbol.slice(0, 10).forEach((asset, index) => {
    console.log(`   ${index + 1}. ${asset.symbol}: ${asset._count.symbol} trades`);
  });

  console.log('═══════════════════════════════════════════════\n');
}

async function main() {
  try {
    console.log('🚀 Starting historical backfill for target vault...');
    console.log(`Target: ${TARGET_VAULT}\n`);

    // Step 1: Fetch fills from Hyperliquid
    const fills = await fetchUserFills(TARGET_VAULT);

    if (fills.length === 0) {
      console.log('⚠️  No fills found for target vault');
      return;
    }

    // Step 2: Store fills in database
    await storeFills(fills);

    // Step 3: Aggregate fills into logical trades
    await aggregateFillsIntoTrades();

    // Step 4: Generate summary report
    await generateSummaryReport();

    console.log('✅ Backfill complete!\n');
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
