import { createDataApiClient } from "./data-api.js";
import { fetchRedeemablePositionSnapshot, fetchClosedPositionSnapshot } from "./wallet-positions.js";
import { fetchTokenFacts } from "./tokens.js";
import { fetchMarketResolutions } from "./resolutions.js";
import { summarizeSettledEvidence } from "./settlement-evidence.js";

function atStage(stage, promise) {
  return promise.catch((error) => {
    error.auditStage = stage;
    throw error;
  });
}

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
  const [positionSnapshot, closedSnapshot] = await Promise.all([
    atStage("redeemable_positions", fetchRedeemablePositionSnapshot(client, wallet)),
    atStage("closed_positions", fetchClosedPositionSnapshot(client, wallet, {
      startSeconds: windowStartSeconds,
      endSeconds: nowSeconds,
      maxPages: 100,
    })),
  ]);
  if (!positionSnapshot.complete || !closedSnapshot.complete) {
    const error = new Error("Wallet audit position snapshots are incomplete");
    error.auditStage = "position_snapshot_validation";
    throw error;
  }

  const tokenFacts = new Map();
  for (const record of positionSnapshot.records) {
    if (record.tokenFact) tokenFacts.set(String(record.position.token_id), record.tokenFact);
  }
  const missingClosedTokenIds = closedSnapshot.records
    .map((record) => record.position.token_id)
    .filter((tokenId) => !tokenFacts.has(String(tokenId)));
  const closedTokenFacts = await atStage("closed_position_token_facts",
    fetchTokenFacts(client, missingClosedTokenIds));
  for (const [tokenId, fact] of closedTokenFacts) tokenFacts.set(tokenId, fact);

  const conditionIds = [
    ...closedSnapshot.records.map((record) => record.position.condition_id),
    ...positionSnapshot.records.map((record) => record.position.condition_id),
  ];
  const resolutions = await atStage("market_resolutions",
    fetchMarketResolutions(client, conditionIds));
  const summary = summarizeSettledEvidence({
    closedPositions: closedSnapshot.records,
    currentPositions: positionSnapshot.records,
    tokenFacts,
    resolutions,
    closedPositionsComplete: closedSnapshot.complete,
    positionsComplete: positionSnapshot.complete,
    windowStartSeconds,
  });

  const result = {
    wallet: wallet.toLowerCase(),
    complete: true,
    coverage: "30_DAY_CLOSED_POSITIONS_PLUS_REDEEMABLE_WINS_AND_LOSSES",
    closedPositions: closedSnapshot.records.length,
    closedPositionPages: closedSnapshot.pages,
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
