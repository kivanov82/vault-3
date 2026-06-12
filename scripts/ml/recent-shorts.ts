import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const since = new Date(Date.now() - 14 * 86400_000);
  const shorts = await prisma.independentPosition.findMany({
    where: { side: 'short', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\nIndependent SHORTs created in last 14d: ${shorts.length}\n`);
  console.log('open(UTC)'.padEnd(17) + 'sym'.padEnd(9) + 'status'.padEnd(11) + 'hold'.padStart(8) + 'pnl%'.padStart(9) + '  exitReason   score');
  console.log('─'.repeat(78));
  const holds: number[] = [];
  for (const p of shorts) {
    const holdMin = p.closedAt ? (p.closedAt.getTime() - p.createdAt.getTime()) / 60000 : null;
    if (holdMin !== null && p.status === 'closed') holds.push(holdMin);
    const holdStr = holdMin !== null ? (holdMin < 90 ? holdMin.toFixed(0) + 'm' : (holdMin / 60).toFixed(1) + 'h') : '-';
    console.log(
      p.createdAt.toISOString().slice(5, 16).replace('T', ' ').padEnd(17) +
      p.symbol.padEnd(9) +
      p.status.padEnd(11) +
      holdStr.padStart(8) +
      (p.realizedPnlPct != null ? (p.realizedPnlPct >= 0 ? '+' : '') + p.realizedPnlPct.toFixed(2) : '-').padStart(9) +
      '  ' + (p.exitReason ?? '-').padEnd(14) + (p.predictionScore?.toFixed(0) ?? '-')
    );
  }
  if (holds.length) {
    holds.sort((a, b) => a - b);
    const med = holds[Math.floor(holds.length / 2)];
    const avg = holds.reduce((s, h) => s + h, 0) / holds.length;
    const under30 = holds.filter((h) => h < 30).length;
    console.log(`\nClosed shorts: ${holds.length} | median hold ${med.toFixed(0)}m | avg ${avg.toFixed(0)}m | under 30m: ${under30} (${(under30/holds.length*100).toFixed(0)}%)`);
    // exit reason tally for closed shorts
    const closed = shorts.filter((p) => p.status === 'closed');
    const rc = new Map<string, number>();
    for (const p of closed) rc.set(p.exitReason ?? '-', (rc.get(p.exitReason ?? '-') ?? 0) + 1);
    console.log('Exit reasons: ' + Array.from(rc.entries()).map(([r, n]) => `${r}=${n}`).join(', '));
  }
  console.log('');
  await prisma.$disconnect();
  await pool.end();
}
main().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
