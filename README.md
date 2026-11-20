# Polymarket 30-Day Top 100
A focused, fail-closed leaderboard of Polymarket wallets.

## Qualification
- Candidate pool: Polymarket Data API v2 **overall monthly leaderboard**.
- Measure settlement performance over the trailing 30 days.
- Require at least **90% wins** and **10 closed markets**.
- Count only positions verifiably held through market resolution.
- Exclude early exits from both wins and losses.
- Do not publish incomplete wallet audits or unverifiable settlement evidence.

Qualifying wallets are ranked by their Polymarket monthly leaderboard P&L.

## Pipeline
1. Discover up to 20,000 wallets from the overall monthly leaderboard.
2. Audit each wallet's 30-day closed positions, current redeemable wins/losses, token payout facts and resolution timestamps.
3. Exclude early exits and ambiguous or unverifiable settlements.
4. Require 90%+ win rate and 10+ verified resolved markets.
5. Publish the monthly Top 100 only after every candidate audit completes and validation passes.

No consensus signals or extra market-category filters are part of this version.
