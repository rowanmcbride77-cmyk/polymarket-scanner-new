# Polymarket Consensus & Combo Scanner

A static dashboard for trader performance, same-side consensus and low-cost high-multiplier combo opportunities.

## Trader qualification
- The current proof-of-concept discovers and audits exactly **1,000 unique wallets** from Polymarket's weekly/monthly overall P&L leaderboards. The planned next expansion is a **5,000-wallet, category-balanced candidate pool**; it will not be enabled until this 1,000-wallet pipeline completes and passes validation.
- Audit the trailing **60 days** of resolved-market settlement evidence.
- Require **90%+ settlement win rate** and at least **10 resolved markets**.
- **Exclude every position exited before the market actually resolves** from wins, losses, resolved-market denominator and win rate. Early exits are recorded only as an exclusion diagnostic; the market's eventual result is not credited to the trader.
- Require complete position snapshots and resolution evidence for each counted result. Missing or conflicting evidence is excluded, never guessed. Incomplete wallet audits and histories truncated by the configured pagination cap are excluded from qualification and reported separately.
- Position history is currently capped at **25 pages per status**. If a checkpoint was created with a lower cap, the next run retries previously incomplete wallets using the expanded cap before final qualification.

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
1. Discover exactly 1,000 unique wallets from the official weekly/monthly overall leaderboard pages.
2. Audit the full 1,000-wallet candidate set with 60-day settlement evidence. Every displayed trader must pass 90%+ and 10+ resolved markets; early exits do not count.
3. Retry previously incomplete wallet histories when a larger pagination cap is configured; never turn an incomplete audit into a qualified result.
4. Check only settlement-qualified wallets for last-hour BUY activity and current holdings.
5. Verify Gamma market state, exact outcome token, allowed category and 24-hour resolution window.
6. Validate output schemas and publish only after the full candidate set has terminal audit results and all displayed traders pass qualification.

A zero-signal result is valid if no market meets the filters. It must not be replaced with fabricated signals. Consensus counts include **only** traders who independently passed the same 90% / 10 resolved-market settlement qualification. A signal's YES/NO counts represent verified current holdings and recent buys by those qualified traders only. The 5,000-wallet expansion is a later phase, not an already-running feature.
