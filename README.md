# Polymarket Consensus & Combo Scanner

A static dashboard for trader performance, same-side consensus and low-cost high-multiplier combo opportunities.

## Trader qualification
- Discovers up to **20,000** unique wallets from the overall weekly and monthly leaderboard pages. The current first pass audits the first **2,000** candidates in the validated discovery ordering and labels that scope on the dashboard; set `SCANNER_AUDIT_LIMIT=20000` for a full-universe run. The audit resumes from durable checkpoints.
- Audit the trailing **60 days** of closed-market results.
- Require **90%+ win rate** and at least **10 closed markets**.
- Count every verifiable closed market in the 60-day window, including positions exited before resolution. For an early exit, use the market’s eventual resolved outcome (YES/NO final result) to classify the trader’s position as a win or loss.
- Track early exits as a separate diagnostic count, but include their eventual market outcomes in wins, losses, the denominator and win rate.
- Exclude incomplete wallet audits and histories truncated by the **25-page per-status cap** from qualification and ranking; missing evidence is not counted as a win or loss. Incomplete audits are reported separately.

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
2. Audit the first 2,000 candidates from the 20,000-wallet discovery pool using 60-day closed-market results and build the first-pass weekly/monthly Top 100. Full-universe auditing is configurable.
3. Check qualified wallets' last-hour BUY activity and current holdings.
4. Verify Gamma market state, outcome token, category and 24-hour resolution window.
5. Fetch combo positions and calculate verified entry/potential payout multiples.
6. Validate output schemas and publish only after every selected audit candidate has a terminal result. The dashboard explicitly shows whether the audit universe is a 2,000-wallet first pass or the complete 20,000-wallet discovery pool. Any incomplete individual audit is excluded from ranking and reported.

A zero-signal result is valid if no market meets the filters. It must not be replaced with fabricated signals. The dashboard publishes only after the full candidate batch and consensus scan finish and pass output validation. Wallets with incomplete individual audits are excluded and counted explicitly; their partial data is never used to qualify or rank them.
