/**
 * Conservative settlement accounting for Polymarket Data API v2 positions.
 *
 * Only explicit resolution states are counted. CLOSED positions are excluded
 * because that status can represent an early exit; OPEN is not a settled result.
 * Callers must establish complete source coverage before passing rows here.
 */

const SETTLED_WIN = "REDEEMABLE";
const SETTLED_LOSS = "REDEEMABLE_LOST";

export function classifyPosition(position, { historyComplete = false } = {}) {
  if (!historyComplete) return { counted: false, reason: "incomplete_history" };
  if (!position || typeof position !== "object") {
    return { counted: false, reason: "invalid_position" };
  }

  const status = String(position.status ?? "").toUpperCase();
  if (status === SETTLED_WIN) {
    return { counted: true, result: "win", reason: "explicit_redeemable_status" };
  }
  if (status === SETTLED_LOSS) {
    return { counted: true, result: "loss", reason: "explicit_redeemable_lost_status" };
  }
  if (status === "CLOSED") {
    return { counted: false, reason: "closed_status_ambiguous_or_early_exit" };
  }
  if (status === "OPEN") {
    return { counted: false, reason: "not_settled_or_not_redeemed" };
  }
  return { counted: false, reason: "unknown_status" };
}

export function summarizeSettledPositions(positions, options = {}) {
  if (!Array.isArray(positions)) throw new TypeError("positions must be an array");
  const summary = {
    wins: 0,
    losses: 0,
    excluded: 0,
    resolvedMarkets: 0,
    winRate: null,
    complete: options.historyComplete === true,
    exclusions: {},
  };

  const seen = new Set();
  for (const position of positions) {
    const conditionId = position?.condition_id;
    const tokenId = position?.token_id;
    const identity = conditionId && tokenId ? `${conditionId}:${tokenId}` : null;
    if (identity && seen.has(identity)) {
      summary.excluded += 1;
      summary.exclusions.duplicate_position = (summary.exclusions.duplicate_position ?? 0) + 1;
      continue;
    }
    if (identity) seen.add(identity);

    const result = classifyPosition(position, options);
    if (!result.counted) {
      summary.excluded += 1;
      summary.exclusions[result.reason] = (summary.exclusions[result.reason] ?? 0) + 1;
      continue;
    }
    if (result.result === "win") summary.wins += 1;
    else summary.losses += 1;
  }

  summary.resolvedMarkets = summary.wins + summary.losses;
  summary.winRate = summary.resolvedMarkets
    ? summary.wins / summary.resolvedMarkets
    : null;
  return summary;
}
