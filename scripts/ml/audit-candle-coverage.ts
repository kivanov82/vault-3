/**
 * Audit candle coverage for all symbols the original target traded
 * in Jan 1 - Mar 15, 2026 window.
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
const EXPECTED_CANDLES = Math.ceil((END.getTime() - START.getTime()) / (60 * 60 * 1000)); // ~1752

async function main() {
  // Find symbols the target traded during the window
  const targetSymbols = await prisma.trade.groupBy({
    by: ['symbol'],
    where: {
      trader: 'target',
      timestamp: { gte: START, lte: END },
    },
    _count: true,
    orderBy: { _count: { symbol: 'desc' } },
  });

  console.log(`\nTarget traded ${targetSymbols.length} symbols in window (${START.toISOString().slice(0,10)} - ${END.toISOString().slice(0,10)})`);
  console.log(`Expected 1h candles per symbol: ${EXPECTED_CANDLES}\n`);
  console.log('Sym'.padEnd(12) + 'Trades'.padStart(8) + 'Candles'.padStart(10) + 'Coverage'.padStart(12) + 'First'.padStart(14) + 'Last'.padStart(14));
  console.log('─'.repeat(72));

  let fullCoverage: string[] = [];
  let partialCoverage: string[] = [];
  let noCoverage: string[] = [];

  for (const s of targetSymbols) {
    const count = await prisma.candle.count({
      where: {
        symbol: s.symbol,
        timeframe: '1h',
        timestamp: { gte: START, lte: END },
      },
    });
    const first = await prisma.candle.findFirst({
      where: { symbol: s.symbol, timeframe: '1h', timestamp: { gte: START, lte: END } },
      orderBy: { timestamp: 'asc' },
    });
    const last = await prisma.candle.findFirst({
      where: { symbol: s.symbol, timeframe: '1h', timestamp: { gte: START, lte: END } },
      orderBy: { timestamp: 'desc' },
    });
    const coverage = (count / EXPECTED_CANDLES) * 100;

    console.log(
      s.symbol.padEnd(12) +
      s._count.toString().padStart(8) +
      count.toString().padStart(10) +
      (coverage.toFixed(0) + '%').padStart(12) +
      (first?.timestamp.toISOString().slice(5, 10) ?? '-').padStart(14) +
      (last?.timestamp.toISOString().slice(5, 10) ?? '-').padStart(14)
    );

    if (coverage >= 95) fullCoverage.push(s.symbol);
    else if (coverage > 0) partialCoverage.push(s.symbol);
    else noCoverage.push(s.symbol);
  }

  console.log('\n' + '─'.repeat(72));
  console.log(`Full coverage (≥95%):    ${fullCoverage.length} symbols`);
  console.log(`Partial coverage:        ${partialCoverage.length} symbols`);
  console.log(`No coverage:             ${noCoverage.length} symbols`);
  if (noCoverage.length > 0) console.log(`  Missing: ${noCoverage.join(', ')}`);
  if (partialCoverage.length > 0) console.log(`  Partial: ${partialCoverage.join(', ')}`);

  // Symbols with candles but NOT traded by target (e.g. BTC, ETH context)
  const allCandleSymbols = await prisma.candle.groupBy({
    by: ['symbol'],
    where: {
      timeframe: '1h',
      timestamp: { gte: START, lte: END },
    },
    _count: true,
  });
  const tradedSet = new Set(targetSymbols.map((s) => s.symbol));
  const extraSymbols = allCandleSymbols.filter((c) => !tradedSet.has(c.symbol));
  if (extraSymbols.length > 0) {
    console.log(`\nExtra symbols with candle data (not traded by target):`);
    for (const e of extraSymbols) {
      console.log(`  ${e.symbol.padEnd(12)} ${e._count} candles`);
    }
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
