# Acceptance criteria

## Rankings
- Separate weekly and monthly Top 100 lists.
- Show wallet, measurement window, realized P&L, resolved-market count, wins, losses, and settlement win rate.
- Count only positions verified as held through resolution. Early exits must not enter the settled win/loss denominator.
- Target qualification: at least 90% settlement win rate and at least 20 resolved markets in the trailing 30 days.
- Missing or incomplete history is never silently treated as complete or as zero.

## Market scope
Prioritize sports, esports, crypto, and player props. Exclude politics and government markets. Classification must be auditable; ambiguous markets are excluded and counted in diagnostics.

## Consensus
- Qualified wallets only.
- Exact same market/condition and exact same outcome/token.
- Verified BUY within 60 minutes; minimum $10 entry per wallet.
- Market expected to resolve within 24 hours based on verified metadata.
- Never combine YES and NO, different lines, different props, or duplicate market representations; exact duplicate event/title entries are excluded.
- Prefer at least 8–10 distinct qualified wallets; never lower the threshold silently.

## Publication
Every run records a unique ID, timestamps, source coverage, warnings, and validation results. Failed or incomplete runs cannot overwrite the last known-good generation. All published files must belong to the same validated run.

## Release gate
Tests pass; fixtures cover wins, losses, early exits, partial histories, duplicate activity, pagination boundaries, and mixed-side consensus; sampled wallets are manually reconciled to source records; a full scan completes; and the website displays the exact published generation.
