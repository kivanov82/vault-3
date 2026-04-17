/**
 * Sentiment A/B: directional vs contrarian model
 *
 * For every prediction where sentiment or contrarian_alt tags fired, compare the
 * two sentiment models' predicted direction against the realized 4h forward move
 * (reconstructed from paperPnlPct × direction).
 *
 * This does NOT replay the full scorer — it just measures how often each
 * sentiment model's direction agreed with the actual forward move, and focuses
 * on disagreement cases where switching would actually change trade direction.
 *
 * Usage: npx tsx scripts/ml/sentiment-ab.ts [days]
 */

import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type Dir = 1 | -1 | null;

const SENTIMENT_TAGS: Record<string, Dir> = {
  sentiment_long_strong: 1,
  sentiment_long: 1,
  sentiment_short_strong: -1,
  sentiment_short: -1,
};

const CONTRARIAN_TAGS: Record<string, Dir> = {
  contrarian_alt_long_strong: 1,
  contrarian_alt_long: 1,
  contrarian_alt_short: -1,
};

function extractDir(reasons: string[], table: Record<string, Dir>): Dir {
  for (const r of reasons) if (table[r]) return table[r];
  return null;
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3) + '%';
}

const HR = '─'.repeat(70);

function bar(n: number, max: number, width = 30): string {
  const len = Math.round((n / max) * width);
  return '█'.repeat(len) + '░'.repeat(width - len);
}

async function main() {
  const days = Number(process.argv[2] ?? '10');
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const until = new Date(Date.now() - 4 * 3600 * 1000);

  console.log(`\nSentiment A/B — Directional vs Contrarian`);
  console.log(`Window: ${since.toISOString()} → ${until.toISOString()} (~${days}d)\n`);

  const rows = await prisma.prediction.findMany({
    where: {
      timestamp: { gte: since, lte: until },
      paperPnlPct: { not: null },
      direction: { not: null },
    },
    select: { symbol: true, timestamp: true, direction: true, paperPnlPct: true, reasons: true },
  });

  let both = 0, onlyDirect = 0, onlyContra = 0, neither = 0;
  let agreeSide = 0, disagreeSide = 0;

  const stats = {
    direct: { n: 0, wins: 0, ret: 0 },
    contra: { n: 0, wins: 0, ret: 0 },
    disagree_direct: { n: 0, wins: 0, ret: 0 },
    disagree_contra: { n: 0, wins: 0, ret: 0 },
  };

  for (const r of rows) {
    const d = extractDir(r.reasons, SENTIMENT_TAGS);
    const c = extractDir(r.reasons, CONTRARIAN_TAGS);

    if (d && c) both++;
    else if (d) onlyDirect++;
    else if (c) onlyContra++;
    else neither++;

    if (d && c) {
      if (d === c) agreeSide++;
      else disagreeSide++;
    }

    // Raw forward move sign: paperPnlPct × direction (undoes direction bias)
    const rawMovePct = r.paperPnlPct! * r.direction!;

    if (d) {
      stats.direct.n++;
      stats.direct.ret += d * rawMovePct;
      if (d === Math.sign(rawMovePct)) stats.direct.wins++;
    }
    if (c) {
      stats.contra.n++;
      stats.contra.ret += c * rawMovePct;
      if (c === Math.sign(rawMovePct)) stats.contra.wins++;
    }
    if (d && c && d !== c) {
      stats.disagree_direct.n++;
      stats.disagree_direct.ret += d * rawMovePct;
      if (d === Math.sign(rawMovePct)) stats.disagree_direct.wins++;
      stats.disagree_contra.n++;
      stats.disagree_contra.ret += c * rawMovePct;
      if (c === Math.sign(rawMovePct)) stats.disagree_contra.wins++;
    }
  }

  console.log(HR);
  console.log('Coverage');
  console.log(HR);
  console.log(`  total validated preds:        ${rows.length}`);
  console.log(`  both fire:                    ${both}`);
  console.log(`  only direct fires:            ${onlyDirect}`);
  console.log(`  only contrarian fires:        ${onlyContra}`);
  console.log(`  neither:                      ${neither}`);
  console.log(`  both fire, SAME direction:    ${agreeSide}`);
  console.log(`  both fire, OPPOSITE dir:      ${disagreeSide}`);

  console.log('\n' + HR);
  console.log('Hit rate — 4h forward move agrees with model direction');
  console.log(HR);
  const fmt = (s: { n: number; wins: number; ret: number }) =>
    s.n
      ? `n=${String(s.n).padStart(5)}  hit=${((s.wins / s.n) * 100).toFixed(1).padStart(5)}%  avg4hRet=${fmtPct(s.ret / s.n)}`
      : 'n=0';
  console.log(`  Directional (live):  ${fmt(stats.direct)}`);
  console.log(`  Contrarian (shadow): ${fmt(stats.contra)}`);

  console.log('\n' + HR);
  console.log('Disagreement subset — only trades where models picked OPPOSITE sides');
  console.log('(this is the subset where switching models would change the trade)');
  console.log(HR);
  console.log(`  Directional pick:    ${fmt(stats.disagree_direct)}`);
  console.log(`  Contrarian pick:     ${fmt(stats.disagree_contra)}`);

  console.log('\n' + HR);
  console.log('Per-tag breakdown');
  console.log(HR);
  const perTag = new Map<string, { n: number; wins: number; ret: number }>();
  for (const r of rows) {
    const rawMovePct = r.paperPnlPct! * r.direction!;
    for (const tag of r.reasons) {
      const table: Record<string, Dir> = { ...SENTIMENT_TAGS, ...CONTRARIAN_TAGS };
      const d = table[tag];
      if (!d) continue;
      const s = perTag.get(tag) ?? { n: 0, wins: 0, ret: 0 };
      s.n++;
      s.ret += d * rawMovePct;
      if (d === Math.sign(rawMovePct)) s.wins++;
      perTag.set(tag, s);
    }
  }
  const maxN = Math.max(...[...perTag.values()].map((s) => s.n), 1);
  const order = [
    'sentiment_long_strong',
    'sentiment_long',
    'sentiment_short',
    'sentiment_short_strong',
    'contrarian_alt_long_strong',
    'contrarian_alt_long',
    'contrarian_alt_short',
  ];
  for (const tag of order) {
    const s = perTag.get(tag);
    if (!s) continue;
    const hit = ((s.wins / s.n) * 100).toFixed(1).padStart(5);
    const ret = fmtPct(s.ret / s.n);
    console.log(`  ${tag.padEnd(28)} ${bar(s.n, maxN, 20)} n=${String(s.n).padStart(5)}  hit=${hit}%  avg4hRet=${ret}`);
  }

  console.log();
  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
