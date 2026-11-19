/**
 * Settlement accounting is deliberately evidence-gated.
 *
 * The Data API's REDEEMABLE_LOST is a query filter; returned position rows
 * still echo status=REDEEMABLE. Therefore the caller must preserve which
 * filter produced each row. We also require the on-chain token resolution
 * record and an unredeemed positive holding. CLOSED positions are exits.
 */

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export function classifyPosition(position, {
  historyComplete = false,
  sourceStatusFilter,
  tokenFact,
} = {}) {
  if (!historyComplete) return { counted: false, reason: "incomplete_history" };
  if (!position || typeof position !== "object") return { counted: false, reason: "invalid_position" };
  if (!WALLET_RE.test(position.proxy_wallet ?? "")) return { counted: false, reason: "invalid_wallet" };
  if (!position.condition_id || !position.token_id) return { counted: false, reason: "missing_market_identity" };
  if (position.status !== "REDEEMABLE") return { counted: false, reason: "not_held_redeemable_position" };
  if (!Number.isFinite(position.current_size) || position.current_size <= 0) {
    return { counted: false, reason: "no_positive_held_size" };
  }
  if (!tokenFact || tokenFact.resolved !== true || !Number.isFinite(tokenFact.final_price)) {
    return { counted: false, reason: "missing_onchain_resolution" };
  }

  if (sourceStatusFilter === "REDEEMABLE" && tokenFact.final_price === 1) {
    return { counted: true, result: "win", reason: "held_winning_token_at_resolution" };
  }
  if (sourceStatusFilter === "REDEEMABLE_LOST" && tokenFact.final_price === 0) {
    return { counted: true, result: "loss", reason: "held_losing_token_at_resolution" };
  }
  if (tokenFact.final_price > 0 && tokenFact.final_price < 1) {
    return { counted: false, reason: "partial_payout_excluded" };
  }
  return { counted: false, reason: "resolution_filter_mismatch" };
}

export function summarizeSettledPositions(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const summary = {
    wins: 0, losses: 0, excluded: 0, resolvedMarkets: 0, winRate: null,
    complete: options.historyComplete === true, exclusions: {},
  };
  const seen = new Set();
  for (const record of records) {
    const position = record?.position;
    const identity = position?.condition_id && position?.token_id
      ? `${position.condition_id}:${position.token_id}` : null;
    if (identity && seen.has(identity)) {
      summary.excluded += 1;
      summary.exclusions.duplicate_position = (summary.exclusions.duplicate_position ?? 0) + 1;
      continue;
    }
    if (identity) seen.add(identity);
    const result = classifyPosition(position, {
      ...options,
      sourceStatusFilter: record?.sourceStatusFilter,
      tokenFact: record?.tokenFact,
    });
    if (!result.counted) {
      summary.excluded += 1;
      summary.exclusions[result.reason] = (summary.exclusions[result.reason] ?? 0) + 1;
    } else if (result.result === "win") summary.wins += 1;
    else summary.losses += 1;
  }
  summary.resolvedMarkets = summary.wins + summary.losses;
  summary.winRate = summary.resolvedMarkets ? summary.wins / summary.resolvedMarkets : null;
  return summary;
}
