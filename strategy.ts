// Winner-takes-all pump.fun replay sniper, for agent-fun/replay/v2.
//
// A selective momentum sniper. Every coin is watched from its CreateEvent. In its first slots the
// bot reads the opening tape: how much real SOL the curve already holds, how many distinct wallets
// piled in besides the creator, how big the creator's own create-slot buy was, whether the creator
// has sold, and whether the tape already shows a big sell or heavy selling. It buys only launches
// that pass, takes profit fast (+15%), cuts losers fast (-12%), never holds past 10 slots, and
// leaves at once when the creator sells. One tranche per coin, never an add.
//
// If strong launches run scarce the entry bar relaxes in stages (real SOL 5 -> 2 -> 1, recent
// buyers 6 -> 4 -> 3, max age 1 -> 3 -> 6), so the 20-coin round-trip guardrail is still met on a
// fresh window. The relaxation is monotonic and driven only by coins seen vs buys made, so it is
// deterministic and needs no clock, environment or randomness.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lamports to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail's round-trip floor). */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time, per relaxation tier (lamports). */
  minRealSolTier: number[];
  /** Oldest age (slots since create) at which a first buy may still be decided, per tier. */
  maxAgeTier: number[];
  /** Distinct non-creator buyers in the recent window a coin needs, per tier. */
  minRecentBuyersTier: number[];
  /** Coins seen before the bar relaxes to the next tier, and buys below which it relaxes. */
  tierCoinsSeen: number[];
  tierBuysBelow: number[];
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuy: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Price now over the create price, at least this many bps (5000 = half the create price). */
  minRunupBps: number;
  /** The recent-flow window (slots) the buyer count is read over. */
  flowWindow: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots from the first fill. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 300_000_000,
  minBuyLamports: 10_000_000,
  minRealSolTier: [5_000_000_000, 2_000_000_000, 1_000_000_000],
  // Tuned 23 Nov: enter only in a coin's first two slots (age 0-1). The dev
  // window's edge lives in the earliest tape: age <= 1 lifts dev PnL from
  // +0.398 to +0.532 SOL and the 70%-subsample stress median from +0.223 to
  // +0.307 SOL (p10 -0.003 -> +0.097, losing copies 3/20 -> 0/20).
  maxAgeTier: [1, 3, 6],
  minRecentBuyersTier: [6, 4, 3],
  tierCoinsSeen: [60, 150],
  tierBuysBelow: [8, 15],
  maxDevBuy: 2_500_000_000,
  maxBigSellBps: 2_000,
  maxSellRatioBps: 5_000,
  minRunupBps: 5_000,
  flowWindow: 10,
  buySlippageBps: 10_000,
  tpBps: 1_200,
  slBps: 1_000,
  maxHold: 10,
  exitOnDevSell: true,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let coinsSeen = 0;
  let buysMade = 0;

  /** The relaxation tier right now: 0 while launches are plentiful, higher when they run scarce. */
  function tier(): number {
    for (let t = P.tierCoinsSeen.length - 1; t >= 0; t--) {
      if (coinsSeen >= P.tierCoinsSeen[t]! && buysMade < P.tierBuysBelow[t]!) return t + 1;
    }
    return 0;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coinsSeen += 1;
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Distinct non-creator buyers over the last flowWindow slots. */
  function recentBuyers(c: Coin, slot: number): number {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy && t.user !== c.creator) buyers.add(t.user);
    }
    return buyers.size;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: fast take-profit, fast stop-loss, max hold, creator sell.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        // True exit value: constant-product sale less curve fees and the tx fee.
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        // Real cost: filled buys (curve fees included) plus every tx fee paid.
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one tranche per coin, only in its first slots, only on a strong opening tape.
      const t = tier();
      const maxAge = P.maxAgeTier[t]!;
      const minRealSol = BigInt(P.minRealSolTier[t]!);
      const minRecentBuyers = P.minRecentBuyersTier[t]!;
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.buysSent > 0) continue;
        const age = state.slot - c.createSlot;
        if (age > maxAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter: creator already sold, or creator's own create-slot buy too big.
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.devBuy > BigInt(P.maxDevBuy)) continue;
        // The launch must already hold real SOL and show real buyers.
        const rq = curve.real_quote_reserves;
        if (rq < minRealSol) continue;
        if (recentBuyers(c, state.slot) < minRecentBuyers) continue;
        // No big sell and no heavy selling on the tape so far.
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        // Price must still be above half its create price.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BigInt(P.minRunupBps)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 2n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        buysMade += 1;
        open += 1;
      }
      return orders;
    },
  };
}
