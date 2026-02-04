import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from "@prisma/client";
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Recent copy actions (not "none")
  const copyActions = await prisma.prediction.findMany({
    where: {
      copyAction: { notIn: ["none"] },
      timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    orderBy: { timestamp: "desc" }
  });

  console.log("═".repeat(70));
  console.log("RECENT COPY TRADING ACTIVITY (last 7 days)");
  console.log("═".repeat(70));
  console.log("\nTotal copy actions:", copyActions.length);

  // Group by symbol
  const bySymbol: Record<string, any[]> = {};
  for (const p of copyActions) {
    if (!bySymbol[p.symbol]) bySymbol[p.symbol] = [];
    bySymbol[p.symbol].push(p);
  }

  console.log("\nBy Symbol:");
  for (const [symbol, actions] of Object.entries(bySymbol).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${symbol}: ${actions.length} actions`);
  }

  console.log("\n" + "─".repeat(70));
  console.log("Detailed Activity:");
  console.log("─".repeat(70));
  console.log("Time              Symbol     Action     Side    Pred Dir  Score");
  console.log("─".repeat(70));

  for (const p of copyActions.slice(0, 30)) {
    console.log(
      p.timestamp.toISOString().slice(5,16).replace("T", " "),
      p.symbol.padEnd(10),
      (p.copyAction || "").padEnd(10),
      (p.copySide || "-").padEnd(7),
      (p.direction === 1 ? "LONG" : p.direction === -1 ? "SHORT" : "-").padEnd(9),
      p.prediction.toFixed(0)
    );
  }

  // Check validated predictions accuracy by symbol
  console.log("\n" + "═".repeat(70));
  console.log("PREDICTION ACCURACY BY SYMBOL (validated only)");
  console.log("═".repeat(70));

  const validated = await prisma.prediction.findMany({
    where: {
      validatedAt: { not: null },
      paperPnlPct: { not: null }
    }
  });

  const symbolStats: Record<string, { count: number, wins: number, totalPnl: number }> = {};
  for (const p of validated) {
    if (!symbolStats[p.symbol]) symbolStats[p.symbol] = { count: 0, wins: 0, totalPnl: 0 };
    symbolStats[p.symbol].count++;
    if (p.paperPnlPct && p.paperPnlPct > 0) symbolStats[p.symbol].wins++;
    symbolStats[p.symbol].totalPnl += p.paperPnlPct || 0;
  }

  const sortedByCount = Object.entries(symbolStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15);

  console.log("\nSymbol      Count   Win Rate   Avg P&L%");
  console.log("─".repeat(45));
  for (const [sym, stats] of sortedByCount) {
    const winRate = ((stats.wins / stats.count) * 100).toFixed(1);
    const avgPnl = (stats.totalPnl / stats.count).toFixed(2);
    console.log(
      sym.padEnd(10),
      String(stats.count).padStart(6),
      (winRate + "%").padStart(10),
      (avgPnl + "%").padStart(10)
    );
  }

  // Check if long or short predictions are better
  console.log("\n" + "═".repeat(70));
  console.log("LONG vs SHORT PREDICTION PERFORMANCE");
  console.log("═".repeat(70));

  const longPreds = validated.filter(p => p.direction === 1);
  const shortPreds = validated.filter(p => p.direction === -1);

  const longWins = longPreds.filter(p => p.paperPnlPct && p.paperPnlPct > 0).length;
  const shortWins = shortPreds.filter(p => p.paperPnlPct && p.paperPnlPct > 0).length;

  const longAvgPnl = longPreds.reduce((sum, p) => sum + (p.paperPnlPct || 0), 0) / longPreds.length;
  const shortAvgPnl = shortPreds.reduce((sum, p) => sum + (p.paperPnlPct || 0), 0) / shortPreds.length;

  console.log(`\nLong predictions:  ${longPreds.length} total, ${((longWins/longPreds.length)*100).toFixed(1)}% win rate, ${longAvgPnl.toFixed(2)}% avg P&L`);
  console.log(`Short predictions: ${shortPreds.length} total, ${((shortWins/shortPreds.length)*100).toFixed(1)}% win rate, ${shortAvgPnl.toFixed(2)}% avg P&L`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  await pool.end();
});
