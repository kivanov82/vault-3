/**
 * Reconcile Independent Position P&L with actual HL fill prices.
 *
 * Our DB logged exit prices using stale market prices (fetched at scan start),
 * not the actual fill prices. This script:
 * 1. Fetches all closed independent positions
 * 2. For each, queries HL API for the actual close fill near that time
 * 3. Updates the DB record with the real exit price and P&L
 *
 * Usage: npm run ml:reconcile
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as hl from '@nktkas/hyperliquid';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WALLET = process.env.WALLET as `0x${string}`;

async function main() {
  console.log('🔄 Reconciling independent position P&L with actual HL fills\n');

  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });

  // Drop old churn positions (instant open/close with ~$0 P&L from before the fix)
  // These are noise — hundreds of positions opened and closed in the same scan cycle
  const churned = await prisma.independentPosition.deleteMany({
    where: {
      status: 'closed',
      realizedPnl: { gte: -0.01, lte: 0.01 },
      closedAt: { lt: new Date('2026-04-07T00:00:00Z') }, // before the fix
    },
  });
  if (churned.count > 0) {
    console.log(`🗑️  Deleted ${churned.count} old churn positions ($0 P&L)\n`);
  }

  // Only reconcile positions since April (after multi-target deployment)
  // and positions with meaningful P&L that may be inaccurate
  const positions = await prisma.independentPosition.findMany({
    where: {
      status: 'closed',
      closedAt: { gte: new Date('2026-04-04T00:00:00Z') },
    },
    orderBy: { closedAt: 'asc' },
  });

  console.log(`Found ${positions.length} positions to reconcile (since Apr 4)\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const pos of positions) {
    if (!pos.closedAt) {
      skipped++;
      continue;
    }

    try {
      // Search for fills around the close time (±2 minutes)
      const closeTime = pos.closedAt.getTime();
      const searchStart = closeTime - 2 * 60 * 1000;

      const fills = await info.userFillsByTime({
        user: WALLET,
        startTime: searchStart,
        aggregateByTime: false,
      });

      // Find the close fill: same symbol, opposite direction, within ±2 min
      const isLong = pos.side === 'long';
      const closeFill = fills.find(f => {
        const fillTime = f.time;
        const timeDiff = Math.abs(fillTime - closeTime);
        const isClose = isLong ? f.side === 'A' : f.side === 'B'; // A=sell, B=buy
        const isSameSymbol = f.coin === pos.symbol;
        return isSameSymbol && isClose && timeDiff < 2 * 60 * 1000;
      });

      if (!closeFill) {
        console.log(`  ⚠️  ${pos.symbol} (${pos.closedAt.toISOString()}): No matching fill found`);
        skipped++;
        continue;
      }

      const actualExitPrice = parseFloat(closeFill.px);
      const oldExitPrice = pos.exitPrice || 0;

      // Recalculate P&L
      const priceDiff = actualExitPrice - pos.entryPrice;
      const realizedPnl = isLong ? priceDiff * pos.size : -priceDiff * pos.size;
      const realizedPnlPct = (priceDiff / pos.entryPrice) * 100 * (isLong ? 1 : -1);

      const oldPnl = pos.realizedPnl || 0;
      const pnlDiff = realizedPnl - oldPnl;

      if (Math.abs(pnlDiff) < 0.01) {
        // Already accurate
        skipped++;
        continue;
      }

      // Update the record
      await prisma.independentPosition.update({
        where: { id: pos.id },
        data: {
          exitPrice: actualExitPrice,
          realizedPnl,
          realizedPnlPct,
        },
      });

      const arrow = pnlDiff > 0 ? '↑' : '↓';
      console.log(`  ✅ ${pos.symbol} ${pos.side} (${pos.closedAt.toISOString().slice(0, 16)}): exit $${oldExitPrice.toFixed(4)} → $${actualExitPrice.toFixed(4)} | PnL $${oldPnl.toFixed(2)} → $${realizedPnl.toFixed(2)} (${arrow}$${Math.abs(pnlDiff).toFixed(2)})`);
      updated++;

      // Delay to avoid HL rate limits (429)
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      if (err.message?.includes('429')) {
        // Rate limited — wait longer and retry once
        await new Promise(r => setTimeout(r, 5000));
        try {
          const retryFills = await info.userFillsByTime({
            user: WALLET,
            startTime: pos.closedAt!.getTime() - 2 * 60 * 1000,
            aggregateByTime: false,
          });
          const isLong = pos.side === 'long';
          const retryFill = retryFills.find(f => {
            const timeDiff = Math.abs(f.time - pos.closedAt!.getTime());
            const isClose = isLong ? f.side === 'A' : f.side === 'B';
            return f.coin === pos.symbol && isClose && timeDiff < 2 * 60 * 1000;
          });
          if (retryFill) {
            const actualExitPrice = parseFloat(retryFill.px);
            const priceDiff = actualExitPrice - pos.entryPrice;
            const realizedPnl = isLong ? priceDiff * pos.size : -priceDiff * pos.size;
            const realizedPnlPct = (priceDiff / pos.entryPrice) * 100 * (isLong ? 1 : -1);
            const oldPnl = pos.realizedPnl || 0;
            if (Math.abs(realizedPnl - oldPnl) >= 0.01) {
              await prisma.independentPosition.update({
                where: { id: pos.id },
                data: { exitPrice: actualExitPrice, realizedPnl, realizedPnlPct },
              });
              console.log(`  ✅ ${pos.symbol} (retry): PnL $${oldPnl.toFixed(2)} → $${realizedPnl.toFixed(2)}`);
              updated++;
            }
          }
        } catch { errors++; }
      } else {
        console.log(`  ❌ ${pos.symbol}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\n✅ Reconciliation complete: ${updated} updated, ${skipped} skipped, ${errors} errors`);

  // Also reconcile copy trade P&L in the Trade table
  console.log('\n🔄 Reconciling copy trade P&L...\n');

  const copyTrades = await prisma.trade.findMany({
    where: {
      trader: 'us',
      isCopyTrade: true,
      exitPrice: { not: null },
    },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`Found ${copyTrades.length} closed copy trades to check\n`);

  let copyUpdated = 0;
  for (const trade of copyTrades) {
    if (!trade.exitPrice || !trade.holdTimeSeconds) continue;

    try {
      const closeTime = trade.timestamp.getTime() + (trade.holdTimeSeconds * 1000);
      const searchStart = closeTime - 2 * 60 * 1000;

      const fills = await info.userFillsByTime({
        user: WALLET,
        startTime: searchStart,
        aggregateByTime: false,
      });

      const isLong = trade.side === 'long';
      const closeFill = fills.find(f => {
        const timeDiff = Math.abs(f.time - closeTime);
        const isClose = isLong ? f.side === 'A' : f.side === 'B';
        return f.coin === trade.symbol && isClose && timeDiff < 2 * 60 * 1000;
      });

      if (!closeFill) continue;

      const actualExitPrice = parseFloat(closeFill.px);
      const priceDiff = actualExitPrice - trade.entryPrice;
      const pnl = isLong ? priceDiff * trade.size : -priceDiff * trade.size;
      const pnlPercent = (priceDiff / trade.entryPrice) * 100 * (isLong ? 1 : -1);

      const oldPnl = trade.pnl || 0;
      if (Math.abs(pnl - oldPnl) < 0.01) continue;

      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          exitPrice: actualExitPrice,
          pnl,
          pnlPercent,
        },
      });

      console.log(`  ✅ ${trade.symbol} ${trade.side}: PnL $${oldPnl.toFixed(2)} → $${pnl.toFixed(2)}`);
      copyUpdated++;

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      if (!err.message?.includes('429')) {
        console.log(`  ❌ ${trade.symbol}: ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Copy trades: ${copyUpdated} updated`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
