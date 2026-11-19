import { createDataApiClient } from "./data-api.js";
import { fetchRecentWalletActivity } from "./activity.js";
import { fetchRedeemablePositionSnapshot } from "./wallet-positions.js";
import { fetchTokenFacts } from "./tokens.js";
import { fetchMarketResolutions } from "./resolutions.js";
import { summarizeSettledEvidence } from "./settlement-evidence.js";

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
} = {}) {
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new TypeError("Invalid audit time window");
  }
  const windowStartSeconds = nowSeconds - lookbackDays * 86400;
  const [redemptionActivity, positionSnapshot] = await Promise.all([
    fetchRecentWalletActivity(client, wallet, {
      startSeconds: windowStartSeconds,
      endSeconds: nowSeconds,
      type: "REDEEM",
      maxPages: 100,
    }),
    fetchRedeemablePositionSnapshot(client, wallet),
  ]);
  if (!redemptionActivity.complete || !positionSnapshot.complete) {
    throw new Error("Wallet audit source history is incomplete");
  }

  const tokenFacts = new Map();
  for (const record of positionSnapshot.records) {
    if (record.tokenFact) tokenFacts.set(String(record.position.token_id), record.tokenFact);
  }
  const missingRedeemedTokenIds = redemptionActivity.rows
    .map((row) => row.token_id).filter(Boolean)
    .filter((tokenId) => !tokenFacts.has(String(tokenId)));
  const redeemedTokenFacts = await fetchTokenFacts(client, missingRedeemedTokenIds);
  for (const [tokenId, fact] of redeemedTokenFacts) tokenFacts.set(tokenId, fact);

  const conditionIds = [
    ...redemptionActivity.rows.map((row) => row.condition_id).filter(Boolean),
    ...positionSnapshot.records.map((record) => record.position.condition_id).filter(Boolean),
  ];
  const resolutions = await fetchMarketResolutions(client, conditionIds);
  const summary = summarizeSettledEvidence({
    redemptions: redemptionActivity.rows,
    currentPositions: positionSnapshot.records,
    tokenFacts,
    resolutions,
    activityComplete: redemptionActivity.complete,
    positionsComplete: positionSnapshot.complete,
    windowStartSeconds,
  });

  const result = {
    wallet: wallet.toLowerCase(),
    complete: true,
    coverage: "30_DAY_REDEEM_ACTIVITY_PLUS_CURRENT_REDEEMABLE_POSITIONS",
    activityRows: redemptionActivity.rows.length,
    activityPages: redemptionActivity.pages,
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
