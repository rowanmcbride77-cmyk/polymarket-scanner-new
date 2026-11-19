export function summarizeSettledEvidence({
  redemptions,
  currentPositions,
  tokenFacts,
  resolutions,
  activityComplete = false,
  positionsComplete = false,
  windowStartSeconds,
}) {
  if (!activityComplete || !positionsComplete) {
    throw new Error("Complete redemption activity and position snapshots are required");
  }
  if (!Array.isArray(redemptions) || !Array.isArray(currentPositions) ||
      !(tokenFacts instanceof Map) || !(resolutions instanceof Map) ||
      !Number.isInteger(windowStartSeconds)) {
    throw new TypeError("Invalid settlement evidence inputs");
  }

  const byCondition = new Map();
  const exclusions = {};
  const exclude = (reason) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  function getToken(conditionId, tokenId) {
    const rows = byCondition.get(conditionId) ?? new Map();
    const record = rows.get(tokenId) ?? { tokenId, redeemedSize: 0, redemptionPayout: 0, currentSize: 0, sourceStatusFilters: new Set() };
    rows.set(tokenId, record);
    byCondition.set(conditionId, rows);
    return record;
  }

  for (const row of redemptions) {
    const conditionId = String(row.condition_id ?? "").toLowerCase();
    const tokenId = String(row.token_id ?? "");
    if (!conditionId || !tokenId || !Number.isFinite(row.size) || row.size <= 0 ||
        !Number.isFinite(row.usdc_size) || row.usdc_size < 0) {
      exclude("malformed_redemption_event");
      continue;
    }
    const record = getToken(conditionId, tokenId);
    record.redeemedSize += row.size;
    record.redemptionPayout += row.usdc_size;
  }

  for (const record of currentPositions) {
    const position = record?.position ?? record;
    const conditionId = String(position?.condition_id ?? "").toLowerCase();
    const tokenId = String(position?.token_id ?? "");
    const currentSize = position?.current_size;
    const sourceStatusFilter = record?.sourceStatusFilter ?? position?.sourceStatusFilter;
    if (!conditionId || !tokenId || !Number.isFinite(currentSize) || currentSize <= 0 ||
        !["REDEEMABLE", "REDEEMABLE_LOST"].includes(sourceStatusFilter)) {
      exclude("malformed_current_redeemable_position");
      continue;
    }
    const item = getToken(conditionId, tokenId);
    item.currentSize += currentSize;
    item.sourceStatusFilters.add(sourceStatusFilter);
  }

  const results = [];
  for (const [conditionId, tokenRows] of byCondition) {
    if (tokenRows.size !== 1) {
      exclude("multiple_outcomes_held_in_same_market");
      continue;
    }
    const [tokenId, evidence] = [...tokenRows.entries()][0];
    const resolution = resolutions.get(conditionId);
    if (!resolution || !Number.isInteger(resolution.resolvedAtSeconds)) {
      exclude("missing_resolution_timestamp");
      continue;
    }
    if (resolution.resolvedAtSeconds < windowStartSeconds) continue;

    const token = tokenFacts.get(tokenId);
    if (!token || token.resolved !== true || !Number.isFinite(token.final_price) ||
        (token.final_price !== 0 && token.final_price !== 1)) {
      exclude("missing_or_nonbinary_token_resolution");
      continue;
    }
    if (token.conditionId && String(token.conditionId).toLowerCase() !== conditionId) {
      exclude("token_condition_mismatch");
      continue;
    }
    if (evidence.redeemedSize > 0) {
      const payoutPerShare = evidence.redemptionPayout / evidence.redeemedSize;
      if (Math.abs(payoutPerShare - token.final_price) > 0.001) {
        exclude("redemption_payout_mismatch");
        continue;
      }
    }
    if (evidence.sourceStatusFilters.has("REDEEMABLE") && token.final_price !== 1) {
      exclude("winner_position_payout_mismatch");
      continue;
    }
    if (evidence.sourceStatusFilters.has("REDEEMABLE_LOST") && token.final_price !== 0) {
      exclude("loser_position_payout_mismatch");
      continue;
    }
    results.push({
      conditionId,
      tokenId,
      result: token.final_price === 1 ? "win" : "loss",
      resolvedAt: resolution.resolvedAt,
      resolvedAtSeconds: resolution.resolvedAtSeconds,
      redeemedShares: evidence.redeemedSize,
      currentShares: evidence.currentSize,
      source: evidence.redeemedSize > 0 && evidence.currentSize > 0 ? "redeemed_and_current"
        : evidence.redeemedSize > 0 ? "verified_redeem_activity"
        : "verified_current_redeemable_position",
    });
  }

  const severeReasons = new Set([
    "malformed_redemption_event",
    "malformed_current_redeemable_position",
    "missing_resolution_timestamp",
    "missing_or_nonbinary_token_resolution",
    "token_condition_mismatch",
    "redemption_payout_mismatch",
    "winner_position_payout_mismatch",
    "loser_position_payout_mismatch",
  ]);
  const integrityFailures = Object.keys(exclusions).filter((reason) => severeReasons.has(reason));
  const wins = results.filter((row) => row.result === "win").length;
  const losses = results.length - wins;
  return {
    results,
    wins,
    losses,
    resolvedMarkets: results.length,
    winRate: results.length ? wins / results.length : null,
    exclusions,
    integrityPassed: integrityFailures.length === 0,
    integrityFailures,
    complete: true,
    windowStartSeconds,
  };
}
