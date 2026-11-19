# Verified Polymarket data sources

Last checked: 2026-11-18.

## Official Data API v2

Base URL: `https://data-api.polymarket.com`. The official v2 reference is https://data-api.polymarket.com/v2/docs.

Verified API contract details:
- Data routes are public and require no API key.
- Responses use a `data` envelope; paginated routes also include `pagination`.
- Pagination is cursor-only. Continue with `pagination.next_cursor` until it is `null`; do not send `offset`.
- Feed endpoints include `/v2/trades` and `/v2/activity`; wallet positions are served from `/v2/positions`.
- `/v2/positions` exposes `first_entry_at`, `last_event_at`, `current_size`, `redeemable`, `status`, `condition_id`, and `token_id`. Entry/event timestamps are Unix seconds; zero first-entry time means acquisition is not recorded.
- `REDEEMABLE` filters settled-but-unredeemed winning positions; `REDEEMABLE_LOST` is a separate filter for settled-but-unredeemed losing positions. The scanner queries both explicitly so losses cannot be silently omitted. Returned rows may echo status `REDEEMABLE`, so the source filter is preserved and cross-checked against token final payout.
- A `CLOSED` positions request can be bounded by `start` and `end` on `last_event_at`. The scanner only counts a closed position when its first entry predates the verified resolution and its last event is strictly after resolution. Pre-resolution closes and same-second ambiguous events are excluded.
- `/v2/tokens` provides token resolution state and `final_price`; `/v2/resolutions` provides the condition's verified resolution timestamp.
- On user-scoped `/v2/trades`, `start=1` requests full history; omitted or zero start is limited to a three-year lookback. The activity feed has the same documented start behavior. The qualification scanner does not replay full trade history.
- Re-send identical filters on each feed page.
- Retry 429 and retryable 503 responses using the `Retry-After` header.
- A missing/null numeric value is unavailable, not zero.
- Bare `size`/volume fields are shares; fields suffixed `_usdc` are USD-denominated.

## Gamma API

Base URL: `https://gamma-api.polymarket.com`. Used for market/event metadata, tags, categories, and event/market end dates. Gamma supports offset pagination with a documented maximum page size of 500 (distinct from Data API v2). The consensus stage requests tag metadata and requires an active, non-closed, order-book-enabled market.

## Important modeling constraint

A raw BUY or SELL is not proof of a settled win or loss. The scanner reconciles wallet position lifecycle, first-entry and last-event timestamps, token final payout, and authoritative resolution data. Early exits are excluded. Ambiguous same-second events, missing timestamps, missing token facts, resolution-state disagreements, and non-binary payouts fail closed. A position that cannot be proven held through resolution is not counted.

## Implementation status

The adapter in `scanner/data-api.js` implements the documented v2 envelope, cursor-only pagination, filter preservation, repeated-cursor protection, page-limit failure, and retry handling. The qualification path queries both explicit unredeemed settlement statuses plus bounded CLOSED positions rather than downloading and retaining each wallet's full activity history. The consensus path separately checks the last hour of BUY activity for qualified wallets and confirms that each counted wallet still holds the exact outcome token; mixed current holdings are excluded.
