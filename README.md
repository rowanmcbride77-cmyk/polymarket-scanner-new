# Polymarket Consensus Scanner

A fail-closed Polymarket trader scanner and consensus dashboard. It does not publish placeholder rankings or partially validated runs.

## Pipeline

1. Discover up to **20,000 unique wallets** from the Polymarket Data API v2 weekly/monthly leaderboards across sports, esports and crypto.
2. Audit each wallet's last 30 days of settled outcomes using:
   - `REDEEM` activity in the 30-day resolution window (including automatic redemptions);
   - current `REDEEMABLE` and `REDEEMABLE_LOST` positions;
   - token final-payout facts from `/v2/tokens`;
   - actual resolution timestamps from `/v2/resolutions`.
3. Exclude early exits: a trade that was sold before resolution is neither a redemption nor a current redeemable holding, so it is not counted as a win or loss.
4. Require at least **20 verified resolved markets** and at least **90% win rate**. Unverifiable settlement evidence blocks qualification.
5. Build weekly and monthly Top 100 lists only after every candidate wallet audit completes.
6. Check recent BUY activity for qualified wallets and build same-outcome consensus only when:
   - the buy occurred within the last 60 minutes;
   - each counted wallet invested at least $10;
   - at least 8 qualified wallets bought the exact same outcome token;
   - the market is active, open, order-book enabled, sports/esports/crypto, and scheduled to resolve within 24 hours;
   - any market with qualified buys on opposing outcomes is excluded.

## Safety and publication

- Cursor pagination is used throughout; no offset-based pagination.
- API retries honor `Retry-After` for 429/503 responses.
- Incomplete histories, missing token facts, missing resolution times, payout mismatches and inconsistent positions fail closed.
- Dashboard data is published only after the complete qualification and consensus workflows pass.
- Failed or incomplete runs never replace validated website data.

## Run it

In GitHub Actions, run **Live candidate discovery and qualification**. On success, the **Qualified consensus** workflow checks current BUY activity, then **Publish scanner dashboard** deploys the validated site to GitHub Pages.

## Local checks

```sh
npm test
npm run check
npm run scan
npm run qualify
npm run consensus
```

Node.js 20 or newer is required.
