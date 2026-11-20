# Architecture

- `scanner/`: public API adapters, bounded position ingestion, settlement verification, qualification, consensus, combo opportunities and validation.
- `site/`: static dashboard only; no business logic.
- `.github/workflows/`: tests, full scans, consensus/combo generation and deployment.
- `docs/`: source contracts, assumptions, acceptance criteria and runbooks.

## Data flow

Discover up to 20,000 overall monthly leaderboard wallets → audit 30-day closed positions and current redeemable wins/losses → reconcile token final-payout facts and market resolution timestamps → exclude early exits from W/L and reject samples with >20% observed early exits → apply 90%/10-market qualification → build weekly/monthly Top 100 → fetch qualified wallets' last-hour BUY activity and current positions → require at least eight wallets buying/holding the same outcome with $10+ each → verify Gamma market state, category and resolution within 24 hours → fetch combo positions for qualified wallets → show active $5–$100 combos with 10×+ potential gross payout by default and a 30-day trader combo record → validate → publish.

## Reliability

Treat API data as untrusted input. Validate schemas. Use cursor pagination, bounded history windows, rate limits and retries. Keep calculations deterministic for a fixed input snapshot. Missing token facts, incomplete pages, payout mismatches and ambiguous same-second events are excluded or fail closed. Never silently fall back when data is missing.

For binary combos, current shares represent the maximum gross payout if all legs win, at $1 per winning share. Potential profit is payout minus entry, not payout itself. Do not use undocumented potential-payout fields. Trader combo win rate is context only and is not a qualification gate.

No fabricated traders, combo positions or consensus signals are permitted.
