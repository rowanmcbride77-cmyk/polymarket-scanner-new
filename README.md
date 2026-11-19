# Polymarket Scanner

Independent rebuild of the Polymarket Top 100 trader scanner and consensus dashboard. This repository does not depend on the legacy project.

## Non-negotiable rules
- Never publish placeholder, stale, partial, or unvalidated scan results as current data.
- Every metric must be traceable to source records and documented calculation rules.
- Early exits are not settled wins or losses.
- Failed runs never overwrite the last known-good data generation.
- The dashboard must show scan freshness and validation status.

## Build sequence
1. Verify source API contracts and data semantics.
2. Build ingestion with pagination, retries, rate-limit handling, and history completeness checks.
3. Implement settlement-aware performance calculations with tests.
4. Produce independently validated weekly and monthly Top 100 datasets.
5. Add same-market, same-outcome consensus from qualified wallets.
6. Add scheduled scanning and atomic publication.
7. Complete the dashboard and end-to-end production verification.

See [acceptance criteria](docs/ACCEPTANCE_CRITERIA.md) and [architecture](docs/ARCHITECTURE.md).
