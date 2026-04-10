/**
 * Sentiment panel — per-hour position state for each tracked wallet.
 *
 * Replays fills forward from the window start, snapshots per-hour.
 */

import { PrismaClient } from '@prisma/client';

export interface SentimentHourState {
  btcDirection: 'long' | 'short' | 'flat';
  // Net signed BTC size (positive = long, negative = short)
  btcSize: number;
}

export interface SentimentPanel {
  // wallet label -> per-hour state
  archangel: Map<number, SentimentHourState>;
  bitcoinMa: Map<number, SentimentHourState>;
}

const WALLETS = {
  archangel: '0x8c7bd04cf8d00d68ce8bc7d2f3f02f98d16a5ab0',
  bitcoinMa: '0xb1505ad1a4c7755e0eb236aa2f4327bfc3474768',
};

async function buildStatesForWallet(
  prisma: PrismaClient,
  wallet: string,
  windowStart: Date,
  windowEnd: Date
): Promise<Map<number, SentimentHourState>> {
  const fills = await prisma.fill.findMany({
    where: {
      traderAddress: wallet,
      timestamp: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, symbol: true, side: true, size: true },
  });

  const states = new Map<number, SentimentHourState>();
  let btcSize = 0;
  let fillIdx = 0;

  for (let h = windowStart.getTime(); h <= windowEnd.getTime(); h += 3600 * 1000) {
    while (fillIdx < fills.length && fills[fillIdx].timestamp.getTime() <= h) {
      const f = fills[fillIdx];
      if (f.symbol === 'BTC') {
        const delta = f.side === 'B' ? f.size : -f.size;
        btcSize += delta;
      }
      fillIdx++;
    }

    const btcDirection: 'long' | 'short' | 'flat' =
      btcSize > 1e-6 ? 'long' : btcSize < -1e-6 ? 'short' : 'flat';

    states.set(h, { btcDirection, btcSize });
  }

  return states;
}

export async function buildSentimentPanel(
  prisma: PrismaClient,
  windowStart: Date,
  windowEnd: Date
): Promise<SentimentPanel> {
  const archangel = await buildStatesForWallet(prisma, WALLETS.archangel, windowStart, windowEnd);
  const bitcoinMa = await buildStatesForWallet(prisma, WALLETS.bitcoinMa, windowStart, windowEnd);
  return { archangel, bitcoinMa };
}

/**
 * Get the sentiment state for a given hour (floor).
 */
export function getSentimentAt(
  panel: SentimentPanel,
  timestamp: Date
): { archangel: 'long' | 'short' | 'flat'; bitcoinMa: 'long' | 'short' | 'flat' } {
  const h = Math.floor(timestamp.getTime() / (3600 * 1000)) * (3600 * 1000);
  return {
    archangel: panel.archangel.get(h)?.btcDirection ?? 'flat',
    bitcoinMa: panel.bitcoinMa.get(h)?.btcDirection ?? 'flat',
  };
}

/**
 * Rule table — maps (ema regime, archangel, bitcoin-ma) to a target direction hypothesis.
 *
 * Derived from the Jan 1 – Mar 15 correlation analysis (1753 hours, 5546 target trades):
 *
 *   Consensus both long       →  LONG (strong)  — 98% target long rate, ~40 longs/h
 *   Bull EMA + Archangel long →  SHORT          — 7% target long rate (target contrarian in bull)
 *   Bull EMA + Archangel short→  SHORT          — 18% target long rate
 *   Bear EMA + Archangel short→  LONG           — 71% target long rate (target contrarian in bear)
 *   Neutral + Archangel long  →  LONG           — 96% target long rate
 *   Neutral + Archangel short →  SHORT (weak)   — 36% target long rate (64% short)
 *   Bull EMA + Archangel flat →  LONG (small)   — 100% but only 27 hrs (weak sample)
 *
 * Returns:
 *   'long_strong' — consensus both long (rare, near-oracle)
 *   'long'        — rule-based long lean
 *   'short'       — rule-based short lean
 *   null          — unclear or default neutral
 */
export function sentimentRuleDirection(
  emaRegime: 'bull' | 'bear' | 'neutral',
  archangel: 'long' | 'short' | 'flat',
  bitcoinMa: 'long' | 'short' | 'flat'
): 'long_strong' | 'long' | 'short' | null {
  // Highest confidence: both sentiment wallets agree long
  if (archangel === 'long' && bitcoinMa === 'long') return 'long_strong';

  // Bull EMA → SHORT bias (target is contrarian to EMA bull regime)
  if (emaRegime === 'bull') return 'short';

  // Bear EMA + Archangel short → LONG bias (target is contrarian to EMA bear regime)
  if (emaRegime === 'bear' && archangel === 'short') return 'long';

  // Neutral EMA + Archangel long → strong long signal
  if (emaRegime === 'neutral' && archangel === 'long') return 'long';

  // Neutral EMA + Archangel short → weak short lean
  if (emaRegime === 'neutral' && archangel === 'short') return 'short';

  return null;
}
