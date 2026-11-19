# Architecture

- `scanner/`: public API adapters, bounded position ingestion, settlement verification, qualification, consensus and validation.
- `site/`: static dashboard only; no business logic.
- `.github/workflows/`: tests, manual full scans, post-scan consensus and deployment.
- `docs/`: source contracts, assumptions, acceptance criteria and runbooks.

## Data flow

Discover up to 20,000 candidate wallets → fetch current held positions and CLOSED positions whose last economic event occurred in the trailing 30 days → fetch token final-payout facts and market resolution timestamps → count only positions still redeemable or closed after resolution → exclude positions closed before resolution → apply 90%/20-market qualification → build weekly/monthly Top 100 → fetch the qualified wallets' last-hour BUY activity → verify Gamma market state, outcome token, category and resolution window → build same-outcome consensus → validate the complete output generation → publish the static dashboard.

## Reliability

Treat API data as untrusted input. Validate schemas. Use cursor pagination, bounded history windows, rate limits and retries. Keep calculations deterministic for a fixed input snapshot. Missing token facts, resolution timestamps, incomplete pages, payout mismatches and ambiguous same-second closes fail closed or are excluded. Never silently fall back when data is missing. The site must not invent data when a file is absent or invalid.

Early exits are not counted: a CLOSED position is eligible only when its first acquisition predates and its last economic event strictly follows the verified market resolution timestamp. Still-held resolved positions are checked against their final token payout.

No fabricated traders or consensus signals are permitted.
