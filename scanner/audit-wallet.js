import { createDataApiClient } from "./data-api.js";
import { fetchCompleteWalletActivity } from "./activity.js";
import { fetchRedeemablePositionSnapshot } from "./wallet-positions.js";
import { fetchTokenFacts } from "./tokens.js";
import { fetchMarketResolutions } from "./resolutions.js";
import { reconstructSettledMarketResults } from "./settled-ledger.js";

export function qualifyWalletAudit(audit, {
  minimumResolvedMarkets = 20,
  minimumWinRate = 0.9,
} = {}) {
  if (!audit || audit.complete !== true) return { qualified: false, reason: "incomplete_audit" };
  if (audit.summary.integrityPassed !== true) {
    return { qualified: false, reason: "settlement_integrity_not_verified" };
  }
  if (audit.summary.resolvedMarkets < minimumResolvedMarkets) {
    return { qualified: false, reason: "insufficient_resolved_markets" };
  }
  if (audit.summary.winRate === null || audit.summary.winRate < minimumWinRate) {
    return { qualified: false, reason: "win_rate_below_threshold" };
  }
  return { qualified: true, reason: "all_thresholds_met" };
}

export async function auditWallet(client, wallet, {
  nowSeconds = Math.floor(Date.now() / 1000),
  lookbackDays = 30,
  minimumResolvedMarkets = 20,
  minimumWinRate = 0.9,
  onActivityPage,
} = {}) {
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new TypeError("Invalid audit time window");
  }
  const [activity, positionSnapshot] = await Promise.all([
    fetchCompleteWalletActivity(client, wallet, { onPage: onActivityPage }),
    fetchRedeemablePositionSnapshot(client, wallet),
  ]);
  if (!activity.complete || !positionSnapshot.complete) {
    throw new Error("Wallet audit source history is incomplete");
  }

  const currentPositions = positionSnapshot.records.map((record) => record.position);
  const tokenFacts = new Map();
  for (const record of positionSnapshot.records) {
    if (record.tokenFact) tokenFacts.set(String(record.position.token_id), record.tokenFact);
  }
  const redeemRows = activity.rows.filter((row) => String(row.type).toUpperCase() === "REDEEM");
  const missingRedeemedTokenIds = redeemRows
    .map((row) => row.token_id).filter(Boolean)
    .filter((tokenId) => !tokenFacts.has(String(tokenId)));
  const redeemedTokenFacts = await fetchTokenFacts(client, missingRedeemedTokenIds);
  for (const [tokenId, fact] of redeemedTokenFacts) tokenFacts.set(tokenId, fact);

  // Resolution and token lookups are limited to outcomes actually redeemed or
  // still held at resolution; ordinary traded-and-exited markets need no lookup.
  const conditionIds = [
    ...activity.rows.filter((row) => String(row.type).toUpperCase() !== "TRADE")
      .map((row) => row.condition_id).filter(Boolean),
    ...currentPositions.map((row) => row.condition_id).filter(Boolean),
  ];
  const resolutions = await fetchMarketResolutions(client, conditionIds);
  const summary = reconstructSettledMarketResults({
    activity: activity.rows,
    currentPositions,
    tokenFacts,
    resolutions,
    activityComplete: activity.complete,
    positionsComplete: positionSnapshot.complete,
    windowStartSeconds: nowSeconds - lookbackDays * 86400,
  });
  const recentBuys = activity.rows
    .filter((row) =>
      String(row.type).toUpperCase() === "TRADE" &&
      String(row.side).toUpperCase() === "BUY" &&
      Number.isInteger(row.timestamp) &&
      row.timestamp >= nowSeconds - 60 * 60 &&
      row.timestamp <= nowSeconds &&
      typeof row.condition_id === "string" &&
      typeof row.token_id === "string")
    .map((row) => ({
      conditionId: row.condition_id.toLowerCase(),
      tokenId: String(row.token_id),
      timestamp: row.timestamp,
      size: row.size,
      price: row.price,
      usdSize: Number.isFinite(row.usdc_size) ? row.usdc_size
        : Number.isFinite(row.price) && Number.isFinite(row.size) ? row.price * row.size : null,
      outcome: typeof row.outcome === "string" ? row.outcome : null,
    }));

  const result = {
    wallet: wallet.toLowerCase(),
    complete: true,
    coverage: "FULL_AVAILABLE_ACTIVITY_PLUS_CURRENT_REDEEMABLE_POSITIONS",
    recentBuys,
    activityRows: activity.rows.length,
    activityPages: activity.pages,
    positionPartitions: positionSnapshot.partitions,
    tokenFacts: tokenFacts.size,
    resolutionFacts: resolutions.size,
    summary,
  };
  return {
    ...result,
    qualification: qualifyWalletAudit(result, { minimumResolvedMarkets, minimumWinRate }),
  };
}

export function createWalletAuditor(client = createDataApiClient()) {
  return (wallet, options) => auditWallet(client, wallet, options);
}
