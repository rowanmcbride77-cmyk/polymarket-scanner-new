# Polymarket Consensus & Combo Scanner

A static dashboard for settlement-verified trader performance, same-side consensus and low-cost high-multiplier combo opportunities.

## Trader qualification
- Discover up to **20,000** wallets from the overall monthly leaderboard.
- Audit the trailing **30 days** of settlement evidence.
- Require **90%+ verified settlement win rate** and at least **10 resolved markets**.
- Count only positions verifiably held through market resolution.
- Exclude early exits from wins/losses and allow no more than **20% observed early exits** among classifiable resolved/early-exit positions.
- Reject incomplete wallet audits, ambiguous same-second events and unverifiable settlement evidence.

The weekly/monthly Top 100 boards are ranked by the corresponding Polymarket leaderboard P&L, but eligibility is based on the same verified settlement criteria.

## Consensus markets
- Only qualified wallets are considered.
- Require a BUY in the last **60 minutes**, at least **$10 per wallet**, and proof the exact outcome token is still held.
- Require at least **8 distinct wallets** on the same outcome.
- Exclude markets where wallets hold both outcomes or qualified buyers split across outcomes.
- Limit to active sports, esports and crypto markets resolving within **24 hours**.
- Exclude politics/government and duplicate representations of the same event/market.

## Combo opportunities
- Fetch public combo-position records for the qualified wallet universe.
- Show currently held combos with a verified **$5–$100 entry**.
- Default to at least **10× potential gross payout**; the dashboard allows 5×, 10×, 20× and 50× filters.
- Calculate the potential payout as current combo shares × $1 per winning share. Do not use undocumented payout fields.
- Display each trader's 30-day combo wins/losses/partials and sample size as context. **No arbitrary minimum combo win-rate is required.**
- Label potential payout/profit as estimates, never realized returns.

## Pipeline
1. Discover up to 20,000 overall monthly leaderboard wallets.
2. Audit 30-day settlement evidence and build weekly/monthly Top 100.
3. Check qualified wallets' last-hour BUY activity and current holdings.
4. Verify Gamma market state, outcome token, category and 24-hour resolution window.
5. Fetch combo positions and calculate verified entry/potential payout multiples.
6. Validate output schemas and publish the dashboard only from the workflow artifact.

A zero-signal result is valid if no market meets the filters. It must not be replaced with fabricated signals.
