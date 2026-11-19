const NON_POSITION_TYPES = new Set([
  "REWARD", "YIELD", "MAKER_REBATE", "TAKER_REBATE",
  "REFERRAL_REWARD", "DEPOSIT", "WITHDRAWAL", "TIP",
]);

const EPSILON = 1e-8;

function markUnsupported(map, conditionId, reason) {
  if (conditionId) {
    const key = String(conditionId).toLowerCase();
    const reasons = map.get(key) ?? new Set();
    reasons.add(reason);
    map.set(key, reasons);
  }
}

/**
 * Reconstructs binary settled-market results from complete wallet activity.
 * Any token-flow action the model cannot account for invalidates that market.
 * The resolution timestamp, not redemption time, determines the 30-day window.
 */
export function reconstructSettledMarketResults({
  activity,
  currentPositions = [],
  tokenFacts,
  resolutions,
  activityComplete = false,
  positionsComplete = false,
  windowStartSeconds,
}) {
  if (!activityComplete || !positionsComplete) {
    throw new Error("Complete activity and position snapshots are required");
  }
  if (!Array.isArray(activity) || !Array.isArray(currentPositions) ||
      !(tokenFacts instanceof Map) || !(resolutions instanceof Map) ||
      !Number.isInteger(windowStartSeconds)) {
    throw new TypeError("Invalid ledger inputs");
  }

  const balances = new Map();
  const tokenConditions = new Map();
  const unsupported = new Map();
  const redemptionTotals = new Map();

  for (const row of activity) {
    const type = String(row.type ?? "").toUpperCase();
    if (NON_POSITION_TYPES.has(type)) continue;
    if (!["TRADE", "SPLIT", "MERGE", "REDEEM"].includes(type)) {
      if (!row.condition_id) throw new Error("Unsupported activity action has no condition id; wallet audit is unsafe");
      markUnsupported(unsupported, row.condition_id, `unsupported_action:${type || "unknown"}`);
      continue;
    }

    const tokenId = row.token_id ? String(row.token_id) : "";
    const conditionId = row.condition_id ? String(row.condition_id).toLowerCase() : "";
    const size = row.size;
    if (!conditionId) {
      throw new Error("Position-changing activity lacks a condition id; wallet audit is unsafe");
    }
    if (!tokenId || !Number.isFinite(size) || size <= 0) {
      markUnsupported(unsupported, conditionId, "malformed_token_flow");
      continue;
    }

    const priorCondition = tokenConditions.get(tokenId);
    if (priorCondition && priorCondition !== conditionId) {
      markUnsupported(unsupported, conditionId, "token_condition_conflict");
      markUnsupported(unsupported, priorCondition, "token_condition_conflict");
      continue;
    }
    tokenConditions.set(tokenId, conditionId);

    const balance = balances.get(tokenId) ?? 0;
    let delta;
    if (type === "TRADE") {
      if (row.side === "BUY") delta = size;
      else if (row.side === "SELL") delta = -size;
      else {
        markUnsupported(unsupported, conditionId, "trade_missing_side");
        continue;
      }
    } else if (type === "SPLIT") delta = size;
    else if (type === "MERGE") delta = -size;
    else {
      if (balance + EPSILON < size) {
        markUnsupported(unsupported, conditionId, "redeem_exceeds_reconstructed_balance");
        continue;
      }
      const redeemed = redemptionTotals.get(tokenId) ?? { size: 0, payout: 0 };
      if (!Number.isFinite(row.usdc_size) || row.usdc_size < 0) {
        markUnsupported(unsupported, conditionId, "redeem_missing_payout");
        continue;
      }
      redeemed.size += size;
      redeemed.payout += row.usdc_size;
      redemptionTotals.set(tokenId, redeemed);
      delta = -size;
    }

    const nextBalance = balance + delta;
    if (nextBalance < -EPSILON) {
      markUnsupported(unsupported, conditionId, "negative_reconstructed_inventory");
      continue;
    }
    balances.set(tokenId, Math.max(0, nextBalance));
  }

  const currentByToken = new Map();
  for (const position of currentPositions) {
    const tokenId = String(position?.token_id ?? "");
    const conditionId = String(position?.condition_id ?? "").toLowerCase();
    if (!tokenId || !conditionId || !Number.isFinite(position.current_size) || position.current_size <= 0) {
      markUnsupported(unsupported, conditionId, "malformed_current_position");
      continue;
    }
    const existing = currentByToken.get(tokenId);
    if (existing) {
      markUnsupported(unsupported, conditionId, "duplicate_current_position");
      continue;
    }
    currentByToken.set(tokenId, { conditionId, size: position.current_size });
    tokenConditions.set(tokenId, conditionId);
  }

  const exposuresByCondition = new Map();
  const allTokenIds = new Set([...balances.keys(), ...redemptionTotals.keys(), ...currentByToken.keys()]);
  for (const tokenId of allTokenIds) {
    const conditionId = tokenConditions.get(tokenId) ?? currentByToken.get(tokenId)?.conditionId;
    if (!conditionId) continue;
    const redeemed = redemptionTotals.get(tokenId);
    const current = currentByToken.get(tokenId);
    const residual = balances.get(tokenId) ?? 0;
    if (current && Math.abs(residual - current.size) > Math.max(0.01, current.size * 0.001)) {
      markUnsupported(unsupported, conditionId, "current_balance_mismatch");
      continue;
    }
    if (!current && residual > EPSILON) {
      markUnsupported(unsupported, conditionId, "unaccounted_residual_inventory");
      continue;
    }
    const exposure = (redeemed?.size ?? 0) + (current?.size ?? 0);
    if (exposure <= EPSILON) continue;
    const rows = exposuresByCondition.get(conditionId) ?? [];
    rows.push({ tokenId, redeemed, current, exposure });
    exposuresByCondition.set(conditionId, rows);
  }

  const results = [];
  const exclusions = {};
  const exclude = (reason) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };

  for (const [conditionId, exposures] of exposuresByCondition) {
    if (exposures.length !== 1) {
      exclude("multiple_outcomes_held_in_same_market");
      continue;
    }
    const { tokenId, redeemed, current } = exposures[0];
    const token = tokenFacts.get(tokenId);
    if (!token || token.resolved !== true || !Number.isFinite(token.final_price)) {
      exclude("missing_onchain_token_resolution");
      continue;
    }
    const resolution = resolutions.get(conditionId);
    if (!resolution || !Number.isInteger(resolution.resolvedAtSeconds)) {
      exclude("missing_resolution_timestamp");
      continue;
    }
    if (resolution.resolvedAtSeconds < windowStartSeconds) continue;
    if (unsupported.has(conditionId)) {
      exclude("unsupported_or_inconsistent_activity");
      continue;
    }
    if (token.conditionId && String(token.conditionId).toLowerCase() !== conditionId) {
      exclude("token_condition_mismatch");
      continue;
    }
    if (token.final_price !== 0 && token.final_price !== 1) {
      exclude("partial_payout_excluded");
      continue;
    }
    if (redeemed) {
      const payoutPerShare = redeemed.payout / redeemed.size;
      if (Math.abs(payoutPerShare - token.final_price) > 0.001) {
        exclude("redemption_payout_mismatch");
        continue;
      }
    }
    if (current && current.size <= 0) {
      exclude("no_positive_holding_at_audit");
      continue;
    }
    results.push({
      conditionId,
      tokenId,
      result: token.final_price === 1 ? "win" : "loss",
      resolvedAt: resolution.resolvedAt,
      resolvedAtSeconds: resolution.resolvedAtSeconds,
      sharesAtAudit: current?.size ?? 0,
      redeemedShares: redeemed?.size ?? 0,
      source: redeemed ? "verified_redeem_activity" : "verified_current_redeemable_position",
    });
  }

  for (const conditionId of unsupported.keys()) {
    if (exposuresByCondition.has(conditionId)) continue;
    const resolution = resolutions.get(conditionId);
    if (resolution && resolution.resolvedAtSeconds >= windowStartSeconds) {
      exclude("unsupported_or_inconsistent_activity");
    }
  }

  const severeExclusions = new Set([
    "unsupported_or_inconsistent_activity",
    "missing_onchain_token_resolution",
    "missing_resolution_timestamp",
    "token_condition_mismatch",
    "redemption_payout_mismatch",
    "current_balance_mismatch",
    "unaccounted_residual_inventory",
    "negative_reconstructed_inventory",
    "redeem_exceeds_reconstructed_balance",
    "redeem_missing_payout",
    "malformed_token_flow",
    "token_condition_conflict",
    "malformed_current_position",
    "duplicate_current_position",
  ]);
  const integrityFailures = Object.keys(exclusions).filter((reason) => severeExclusions.has(reason));

  return {
    results,
    wins: results.filter((x) => x.result === "win").length,
    losses: results.filter((x) => x.result === "loss").length,
    resolvedMarkets: results.length,
    winRate: results.length ? results.filter((x) => x.result === "win").length / results.length : null,
    exclusions,
    integrityPassed: integrityFailures.length === 0,
    integrityFailures,
    complete: true,
    windowStartSeconds,
  };
}
