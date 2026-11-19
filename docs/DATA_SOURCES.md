# Verified Polymarket data sources

Last checked: 2026-11-18.

## Official Data API v2

Base URL: `https://data-api.polymarket.com`. The official v2 reference is https://data-api.polymarket.com/v2/docs.

Verified API contract details:
- Data routes are public and require no API key.
- Responses use a `data` envelope; paginated routes also include `pagination`.
- Pagination is cursor-only. Continue with `pagination.next_cursor` until it is `null`; do not send `offset`.
- Feed endpoints include `/v2/trades` and `/v2/activity`; wallet positions are served from `/v2/positions`.
- On user-scoped `/v2/trades`, `start=1` requests full history; omitted or zero start is limited to a three-year lookback. The activity feed has the same documented start behavior.
- Re-send identical filters on each feed page.
- Retry 429 and retryable 503 responses using the `Retry-After` header.
- A missing/null numeric value is unavailable, not zero.
- Bare `size`/volume fields are shares; fields suffixed `_usdc` are USD-denominated.

## Gamma API

Base URL: `https://gamma-api.polymarket.com`. Used for market/event metadata, tags, categories, and event/market end dates. Gamma supports offset pagination with a documented maximum page size of 500 (distinct from Data API v2).

## Important modeling constraint

The API exposes wallet trades, activity, positions, and resolution lifecycle data as separate resources. A raw BUY or SELL is not itself proof of a settled win or loss. The scanner must reconcile token/condition identity, wallet position lifecycle, and authoritative resolution data before assigning a settled result. If that reconciliation cannot be proven for a wallet-market position, mark it unverified and exclude it from the win-rate denominator rather than guessing.

## Implementation status

The adapter in `scanner/data-api.js` implements the documented v2 envelope, cursor-only pagination, filter preservation, repeated-cursor protection, page-limit failure, and retry handling. It does not yet calculate P&L or declare any trader qualified.
