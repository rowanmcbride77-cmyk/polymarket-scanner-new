# Polymarket Consensus & Combo Scanner

A static dashboard for settlement-verified trader performance, same-side consensus and low-cost high-multiplier combo opportunities.

## Trader qualification
- Audits up to **20,000** unique wallets selected from the overall weekly and monthly leaderboard pages. The audit is checkpointed in batches of **1,000 wallets per workflow run**; no leaderboard is published until every candidate has a terminal audit result.
- Audit the trailing **60 days** of closed-market results.
- Require **90%+ win rate** and at least **10 closed markets**.
- Include early exits in the win/loss calculation; do not require holding through market resolution.
- Early exits are included. No early-exit or holding-period filter is applied.
- Exclude incomplete wallet audits from qualification and ranking; missing evidence is not counted as a win or loss.

The weekly/monthly Top 100 boards are ranked by the corresponding Polymarket leaderboard P&L, but eligibility is based on the same verified settlement criteria. A board can contain fewer than 100 traders if fewer pass.

## Consensus markets
- Only qualified wallets are considered.
- Require a BUY in the last **60 minutes**, at least **$10 per wallet**, and proof the exact outcome token is still held.
- Require at least **8 distinct wallets** on the same outcome.
- Exclude markets where wallets hold both outcomes or qualified buyers split across outcomes.
- Limit to active sports, esports and crypto markets resolving within **24 hours**.
- Exclude politics/government and duplicate representations of the same event/market.

## Combo opportunities
- Fetch public combo-position records for the qualified-wallet universe.
- Show currently held combos with a verified **$5–$100 entry**.
- Default to at least **10× potential gross payout**; the dashboard allows 5×, 10×, 20× and 50× filters.
- Calculate the potential payout as current combo shares × $1 per winning share. Do not use undocumented payout fields.
- Display each trader's 30-day combo wins/losses/partials and sample size as context. **No arbitrary minimum combo win-rate is required.**
- Label potential payout/profit as estimates, never realized returns.

## Pipeline
1. Discover up to 20,000 overall weekly/monthly leaderboard wallets.
2. Audit 30-day closed-market results and build weekly/monthly Top 100.
3. Check qualified wallets' last-hour BUY activity and current holdings.
4. Verify Gamma market state, outcome token, category and 24-hour resolution window.
5. Fetch combo positions and calculate verified entry/potential payout multiples.
6. Validate output schemas and publish the dashboard only after every candidate has a terminal audit result. Any individual incomplete audit is excluded from ranking and reported in the dashboard; fully audited wallets can still be published.

A zero-signal result is valid if no market meets the filters. It must not be replaced with fabricated signals. The dashboard publishes only after the full candidate batch and consensus scan finish and pass output validation. Wallets with incomplete individual audits are excluded and counted explicitly; their partial data is never used to qualify or rank them.
