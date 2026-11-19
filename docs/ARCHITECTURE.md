# Architecture

- `scanner/`: source adapters, ingestion, normalization, settlement, rankings, consensus, validation.
- `site/`: static dashboard only; no business logic.
- `.github/workflows/`: tests, scheduled scans, deployment.
- `docs/`: source contracts, assumptions, acceptance criteria, runbooks.

## Data flow
Discover candidate wallets → fetch complete paginated histories → normalize while retaining source IDs → reconcile market resolution → calculate settled performance → apply qualification and category rules → rank weekly/monthly → build exact-side consensus → validate a complete output generation → publish atomically.

## Reliability
Treat API data as untrusted input. Validate schemas. Handle pagination, rate limits, retries, and partial history explicitly. Keep calculations deterministic for a fixed input snapshot. Never silently fall back when data is missing. The site must not invent data when a file is absent or invalid.

The first milestone is a tested ingestion and settlement model. No fabricated traders or consensus signals are permitted.
