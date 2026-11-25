export function summarizeSettledEvidence({
  closedPositions,
  currentPositions,
  tokenFacts,
  resolutions,
  closedPositionsComplete = false,
  positionsComplete = false,
  windowStartSeconds,
}) {
  if (!closedPositionsComplete || !positionsComplete) {
    throw new Error("Complete closed-position and redeemable-position snapshots are required");
  }
  if (!Array.isArray(closedPositions) || !Array.isArray(currentPositions) ||
      !(tokenFacts instanceof Map) || !(resolutions instanceof Map) ||
      !Number.isInteger(windowStartSeconds)) {
    throw new TypeError("Invalid settlement evidence inputs");
  }

  const heldAtResolution = new Map();
  const exclusions = {};
  const invalidMarkets = new Set();
  const exclude = (reason, conditionId = null) => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    if (conditionId) invalidMarkets.add(String(conditionId).toLowerCase());
  };
  function getToken(conditionId, tokenId) {
    const rows = heldAtResolution.get(conditionId) ?? new Map();
    const record = rows.get(tokenId) ?? {
      tokenId, closedEvidence: false, currentSize: 0, sourceStatusFilters: new Set(),
    };
    rows.set(tokenId, record);
    heldAtResolution.set(conditionId, rows);
    return record;
  }

  for (const record of closedPositions) {
    const position = record?.position ?? record;
    const conditionId = String(position?.condition_id ?? "").toLowerCase();
    const tokenId = String(position?.token_id ?? "");
    const lastEventAt = position?.last_event_at;
    const firstEntryAt = position?.first_entry_at;
    if (!conditionId || !tokenId || !Number.isInteger(lastEventAt) || lastEventAt <= 0 ||
        !Number.isInteger(firstEntryAt) || firstEntryAt < 0) {
      exclude("malformed_closed_position", conditionId);
      continue;
    }
    const resolution = resolutions.get(conditionId);
    if (resolution && Number.isInteger(resolution.resolvedAtSeconds) &&
        resolution.resolvedAtSeconds < windowStartSeconds) continue;
    if (resolution && Number.isInteger(resolution.resolvedAtSeconds) &&
        lastEventAt === resolution.resolvedAtSeconds) {
      exclude("same_second_as_resolution_ambiguous", conditionId);
      continue;
    }
    const token = tokenFacts.get(tokenId);
    if (!token) {
      exclude("missing_closed_position_token_fact", conditionId);
      continue;
    }
    if (token.conditionId && String(token.conditionId).toLowerCase() !== conditionId) {
      exclude("token_condition_mismatch", conditionId);
      continue;
    }
    if (token.resolved !== true) {
      if (resolution?.status === "resolved") exclude("token_resolution_state_mismatch", conditionId);
      continue;
    }
    if (!resolution || !Number.isInteger(resolution.resolvedAtSeconds)) {
      exclude("missing_resolution_timestamp", conditionId);
      continue;
    }
    if (resolution.resolvedAtSeconds < windowStartSeconds) continue;
    if (firstEntryAt === 0) {
      exclude("missing_first_entry_timestamp", conditionId);
      continue;
    }
    if (firstEntryAt >= resolution.resolvedAtSeconds) {
      exclude(firstEntryAt === resolution.resolvedAtSeconds
        ? "same_second_entry_resolution_ambiguous" : "post_resolution_acquisition_excluded", conditionId);
      continue;
    }
    if (lastEventAt < resolution.resolvedAtSeconds) {
      // A position sold before market resolution is not a settlement result.
      // Exclude this market from wins, losses, and the resolved-market denominator.
      exclude("early_exit_before_resolution", conditionId);
      continue;
    }
    const item = getToken(conditionId, tokenId);
    item.closedEvidence = true;
  }

  for (const record of currentPositions) {
    const position = record?.position ?? record;
    const conditionId = String(position?.condition_id ?? "").toLowerCase();
    const tokenId = String(position?.token_id ?? "");
    const currentSize = position?.current_size;
    const firstEntryAt = position?.first_entry_at;
    const sourceStatusFilter = record?.sourceStatusFilter ?? position?.sourceStatusFilter;
    if (!conditionId || !tokenId || !Number.isFinite(currentSize) || currentSize <= 0 ||
        !Number.isInteger(firstEntryAt) || firstEntryAt < 0 ||
        !["REDEEMABLE", "REDEEMABLE_LOST"].includes(sourceStatusFilter)) {
      exclude("malformed_current_redeemable_position", conditionId);
      continue;
    }
    const resolution = resolutions.get(conditionId);
    if (resolution && Number.isInteger(resolution.resolvedAtSeconds) &&
        resolution.resolvedAtSeconds < windowStartSeconds) continue;
    const token = tokenFacts.get(tokenId);
    if (!token || token.resolved !== true || !Number.isFinite(token.final_price)) {
      exclude("missing_current_position_token_resolution", conditionId);
      continue;
    }
    if (token.conditionId && String(token.conditionId).toLowerCase() !== conditionId) {
      exclude("token_condition_mismatch", conditionId);
      continue;
    }
    if (!resolution || !Number.isInteger(resolution.resolvedAtSeconds)) {
      exclude("missing_resolution_timestamp", conditionId);
      continue;
    }
    if (resolution.resolvedAtSeconds < windowStartSeconds) continue;
    if (firstEntryAt === 0) {
      exclude("missing_first_entry_timestamp", conditionId);
      continue;
    }
    if (firstEntryAt >= resolution.resolvedAtSeconds) {
      exclude(firstEntryAt === resolution.resolvedAtSeconds
        ? "same_second_entry_resolution_ambiguous" : "post_resolution_acquisition_excluded");
      continue;
    }
    if ((sourceStatusFilter === "REDEEMABLE" && token.final_price !== 1) ||
        (sourceStatusFilter === "REDEEMABLE_LOST" && token.final_price !== 0)) {
      exclude("redeemable_status_payout_mismatch", conditionId);
      continue;
    }
    const item = getToken(conditionId, tokenId);
    item.currentSize += currentSize;
    item.sourceStatusFilters.add(sourceStatusFilter);
  }

  const results = [];
  for (const [conditionId, tokenRows] of heldAtResolution) {
    if (invalidMarkets.has(conditionId)) continue;
    if (tokenRows.size !== 1) {
      exclude("multiple_outcomes_held_in_same_market");
      continue;
    }
    const [tokenId, evidence] = [...tokenRows.entries()][0];
    if (evidence.closedEvidence && evidence.currentSize > 0) {
      exclude("closed_and_current_same_token");
      continue;
    }
    const token = tokenFacts.get(tokenId);
    if (!token || token.resolved !== true ||
        (token.final_price !== 0 && token.final_price !== 1)) {
      exclude("missing_or_nonbinary_token_resolution");
      continue;
    }
    const resolution = resolutions.get(conditionId);
    if (!resolution || !Number.isInteger(resolution.resolvedAtSeconds)) {
      exclude("missing_resolution_timestamp");
      continue;
    }
    results.push({
      conditionId,
      tokenId,
      result: token.final_price === 1 ? "win" : "loss",
      resolvedAt: resolution.resolvedAt,
      resolvedAtSeconds: resolution.resolvedAtSeconds,
      currentShares: evidence.currentSize,
      source: evidence.closedEvidence && evidence.currentSize > 0 ? "closed_and_current"
        : evidence.closedEvidence ? "closed_after_resolution"
        : "current_redeemable_position",
    });
  }

  const severeReasons = new Set([
    "malformed_closed_position",
    "missing_closed_position_token_fact",
    "missing_first_entry_timestamp",
    "closed_and_current_same_token",
    "token_condition_mismatch",
    "missing_resolution_timestamp",
    "token_resolution_state_mismatch",
    "malformed_current_redeemable_position",
    "missing_first_entry_timestamp",
    "missing_current_position_token_resolution",
    "redeemable_status_payout_mismatch",
    "missing_or_nonbinary_token_resolution",
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
    earlyExitsCounted: 0,
    exclusions,
    // Integrity is enforced per market above. Unrelated malformed or unverified
    // positions remain diagnostic exclusions and do not erase valid markets.
    integrityPassed: true,
    integrityFailures,
    complete: true,
    windowStartSeconds,
  };
}
