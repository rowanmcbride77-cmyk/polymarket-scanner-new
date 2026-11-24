# Acceptance criteria

## Trader qualification
- Discover up to 20,000 unique wallets. The current first-pass audit target is 2,000 candidates; the dashboard must label the sample scope. Full-universe mode remains configurable at 20,000.
- Use a trailing 60-day verified settlement sample.
- Require 90%+ win rate and 10+ resolved markets.
- Include closed positions even when the trader exited before resolution; classify the position using that market’s eventual resolved outcome.
- Report early exits separately for diagnostics, but include them in wins, losses, the denominator and win rate. Do not impose a separate early-exit-rate threshold.
- Reject incomplete audits, histories truncated by the configured 25-page per-status cap, ambiguous same-second events, missing token facts and unverifiable settlement evidence. Never infer a win or loss from missing evidence.
- Rank eligible weekly/monthly boards by the matching leaderboard P&L.

## Consensus
- Only fully qualified wallets can contribute.
- Require a BUY in the last 60 minutes and at least $10 notional per wallet.
- Confirm each exact bought outcome token remains held.
- Require at least 8 distinct wallets on exactly one shared outcome.
- Exclude mixed current holdings, split outcomes, political/government categories, non-sports/esports/crypto markets, inactive/closed markets, markets resolving beyond 24 hours, and duplicate event/market representations.

## Combo opportunities
- Scan public combo positions for the qualified-wallet universe.
- Show only currently held positions with $5–$100 verified entry cost.
- Default minimum potential gross payout multiple: 10×.
- Use current combo shares as the binary maximum gross payout; never treat it as profit.
- Show the trader's 30-day resolved combo W/L and sample size; do not impose a minimum win rate.
- Validate each published combo's entry, payout multiple, active status and trader record fields.

## Publication
- Tests and syntax checks pass.
- All selected audit-candidate results are terminal; report both the selected audit count and the full discovery-pool count. Do not describe a 2,000-candidate first pass as a full 20,000-wallet scan.
- Consensus and combo scan coverage is reported independently.
- The dashboard displays only the exact validated generation. Partial combo coverage must be visibly labeled; it must not be presented as complete.
