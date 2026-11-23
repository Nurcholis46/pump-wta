# pump-wta — Winner Takes All pump.fun replay sniper

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Nurcholis46/pump-wta/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Nurcholis46/pump-wta/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A selective momentum sniper for the [Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) on make.fun. The bot trades 10 SOL of paper money on a replay of real pump.fun bonding-curve chain data — nothing is traded for real.

Referral code: `mt29fv3h` — https://make.fun/r/mt29fv3h

## How it works

`main.ts` runs the strategy in `strategy.ts` on the house `agent-fun/replay/v2` protocol (vendored shim in `vendor/makefun-bot.ts`):

- **Watch every launch from its CreateEvent.** In a coin's first slots the bot reads the opening tape: real SOL the curve already holds, distinct wallets piling in besides the creator, the creator's own create-slot buy, whether the creator has sold, and whether the tape already shows a big sell or heavy selling.
- **Buy only strong launches:** age ≤ 3 slots, real SOL ≥ 5, price still above half its create price, ≥ 6 distinct recent non-creator buyers, creator's create-slot buy under 2.5 SOL, no big sell, no heavy selling. One tranche per coin (up to 0.3 SOL, capped at 1% of real SOL reserve), never an add.
- **Exit fast:** +12% take-profit, −10% stop-loss, 10-slot max hold, or at once if the creator sells. Exits are priced on true sell proceeds (constant-product sale less curve fees and tx fee) against real cost (filled buys + tx fees).
- **Relax in stages if strong launches run scarce** (real SOL 5 → 2 → 1, recent buyers 6 → 4 → 3, max age 3 → 6 → 10), so the 20-coin round-trip guardrail is still met on a fresh window.
- **Fully deterministic:** no clock, no environment, no randomness.

## Dev-window results (frozen kit dataset, all 3 parts, 1,222 coins)

| bot | net PnL | round trips | max drawdown |
| --- | --- | --- | --- |
| **pump-wta (this entry)** | **+0.365 SOL** | 136 coins | 2.1% |
| pilot sniper (kit defaults) | −0.490 SOL | 353 coins | 5.3% |
| pilot momentum | −9.467 SOL | 46 coins | 95.7% |
| pilot reversion | −3.780 SOL | 199 coins | 47.3% |
| hold cash | 0.000 SOL | — | 0.0% |

The dev window is one small sample and the final window is fresh data recorded after entries close, so these numbers are a guide, not a forecast. The bot was also run through `grade-local --stress` before submission; see the submission report for the spread.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

Node 22+ required, no dependencies to install.
