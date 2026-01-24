import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

dotenv.config();

// For Prisma 7 with PostgreSQL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_VAULT = '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3';

interface HyperliquidCSVFill {
  time: string;           // "17/11/2025 - 17:45:44"
  coin: string;           // "HYPE"
  dir: string;            // "Open Long", "Close Long", "Open Short", "Close Short"
  px: string;             // "37.798"
  sz: string;             // "1308.64"
  ntl: string;            // Notional value (use as fill ID)
  fee: string;            // Fee amount
  closedPnl: string;      // Closed P&L (if any)
}

/**
 * Parse Hyperliquid's date format: "17/11/2025 - 17:45:44" to JavaScript Date
 */
function parseHyperliquidDate(dateStr: string): Date {
  // Format: "DD/MM/YYYY - HH:MM:SS"
  const parts = dateStr.split(' - ');
  if (parts.length !== 2) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  const [datePart, timePart] = parts;
  const [day, month, year] = datePart.split('/').map(Number);
  const [hours, minutes, seconds] = timePart.split(':').map(Number);

  // JavaScript Date uses 0-indexed months
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/**
 * Convert Hyperliquid direction to side (B/A)
 */
function directionToSide(dir: string): string {
  if (dir.includes('Long')) {
    return 'B'; // Buy/Long
  } else if (dir.includes('Short')) {
    return 'A'; // Sell/Short
  }
  throw new Error(`Unknown direction: ${dir}`);
}

/**
 * Calculate position size based on direction
 */
function calculatePositionSzi(dir: string, size: number, closedPnl: string): number {
  const isOpening = dir.startsWith('Open');
  const isLong = dir.includes('Long');

  if (isOpening) {
    return isLong ? size : -size;
  } else {
    // Closing position
    return 0; // Position becomes 0 after close
  }
}

async function parseCSVLine(line: string): Promise<HyperliquidCSVFill | null> {
  // Handle CSV format: time,coin,dir,px,sz,ntl,fee,closedPnl
  const parts = line.split(',');

  if (parts.length < 8) {
    return null; // Invalid line
  }

  return {
    time: parts[0],
    coin: parts[1],
    dir: parts[2],
    px: parts[3],
    sz: parts[4],
    ntl: parts[5],
    fee: parts[6],
    closedPnl: parts[7],
  };
}

async function importCSV(csvPath: string): Promise<void> {
  console.log(`\n📂 Importing CSV from: ${csvPath}`);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const fills: any[] = [];
  let lineNumber = 0;
  let skippedLines = 0;

  for await (const line of rl) {
    lineNumber++;

    // Skip header row
    if (lineNumber === 1 && line.toLowerCase().includes('time')) {
      console.log(`📋 Header detected: ${line}`);
      continue;
    }

    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    try {
      const csvFill = await parseCSVLine(line);

      if (!csvFill) {
        skippedLines++;
        console.warn(`⚠️  Line ${lineNumber}: Invalid format, skipping`);
        continue;
      }

      // Parse date
      const timestamp = parseHyperliquidDate(csvFill.time);

      // Convert to Prisma format
      const size = parseFloat(csvFill.sz);
      const positionSzi = calculatePositionSzi(csvFill.dir, size, csvFill.closedPnl);

      fills.push({
        fillId: csvFill.ntl, // Use notional as unique ID
        timestamp: timestamp,
        traderAddress: TARGET_VAULT,
        symbol: csvFill.coin,
        side: directionToSide(csvFill.dir),
        price: parseFloat(csvFill.px),
        size: size,
        positionSzi: positionSzi,
        rawData: csvFill as any,
      });

      // Batch insert every 1000 records
      if (fills.length >= 1000) {
        await storeFillsBatch(fills);
        fills.length = 0; // Clear array
      }
    } catch (error: any) {
      skippedLines++;
      console.warn(`⚠️  Line ${lineNumber}: Error parsing - ${error.message}`);
    }
  }

  // Insert remaining fills
  if (fills.length > 0) {
    await storeFillsBatch(fills);
  }

  console.log(`\n✅ Import complete!`);
  console.log(`   Total lines processed: ${lineNumber}`);
  console.log(`   Skipped lines: ${skippedLines}`);
}

async function storeFillsBatch(fills: any[]): Promise<void> {
  try {
    const result = await prisma.fill.createMany({
      data: fills,
      skipDuplicates: true, // Skip existing records
    });

    console.log(`  💾 Stored ${result.count} fills (batch of ${fills.length})`);
  } catch (error: any) {
    console.error(`  ❌ Error storing batch:`, error.message);

    // Fallback: Try one-by-one if batch fails
    console.log(`  🔄 Trying individual inserts...`);
    let stored = 0;
    for (const fill of fills) {
      try {
        await prisma.fill.create({ data: fill });
        stored++;
      } catch (e: any) {
        if (e.code !== 'P2002') { // Ignore duplicate errors
          console.error(`  ⚠️  Failed to store fill ${fill.fillId}:`, e.message);
        }
      }
    }
    console.log(`  ✅ Stored ${stored} fills individually`);
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
      leverage: 1, // We don't have leverage info from CSV
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
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: npm run import-csv <path-to-csv-file>

Example:
  npm run import-csv ./export/vault-fills.csv
  npm run import-csv ~/Downloads/hyperliquid-fills.csv

CSV Format (Hyperliquid UI Export):
  time,coin,dir,px,sz,ntl,fee,closedPnl
  17/11/2025 - 17:45:44,HYPE,Open Long,37.798,1308.64,49463.97,22.26,-22.26

Where:
  - time: DD/MM/YYYY - HH:MM:SS
  - coin: Symbol (BTC, ETH, etc.)
  - dir: Direction (Open Long, Close Long, Open Short, Close Short)
  - px: Fill price
  - sz: Fill size
  - ntl: Notional value (used as unique fill ID)
  - fee: Fee paid
  - closedPnl: P&L if closing position

Where to get the CSV:
  1. Go to Hyperliquid vault page
  2. Navigate to vault: ${TARGET_VAULT}
  3. Click "Export" or "Download fills history"
  4. Save the CSV file
  5. Run this script with the CSV path
    `);
    process.exit(1);
  }

  const csvPath = path.resolve(args[0]);

  try {
    console.log('🚀 Starting CSV import for target vault...');
    console.log(`Target: ${TARGET_VAULT}\n`);

    // Step 1: Import CSV
    await importCSV(csvPath);

    // Step 2: Aggregate fills into logical trades
    await aggregateFillsIntoTrades();

    // Step 3: Generate summary report
    await generateSummaryReport();

    console.log('✅ Import complete!\n');
  } catch (error) {
    console.error('❌ Import failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
