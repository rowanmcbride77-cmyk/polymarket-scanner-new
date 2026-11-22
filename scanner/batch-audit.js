import { fetchRedeemablePositionSnapshot, fetchClosedPositionSnapshot } from "./wallet-positions.js";
import { fetchTokenFacts } from "./tokens.js";
import { fetchMarketResolutions } from "./resolutions.js";
import { summarizeSettledEvidence } from "./settlement-evidence.js";
import { qualifyWalletAudit } from "./audit-wallet.js";

async function mapLimit(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

/**
 * Audits many wallets in three shared stages:
 * 1) fetch each wallet's position snapshots,
 * 2) resolve all unique token IDs and market IDs in cross-wallet batches,
 * 3) calculate each wallet's settlement record independently.
 *
 * This avoids repeating the same token/resolution requests for every wallet.
 */
export async function auditCandidatesBatch(candidates, {
  client,
  concurrency = 16,
  nowSeconds = Math.floor(Date.now() / 1000),
  lookbackDays = 30,
  minimumResolvedMarkets = 10,
  minimumWinRate = 0.9,
  onProgress,
  sharedTokenFacts = new Map(),
  sharedResolutions = new Map(),
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (!client || typeof client.collectPages !== "function" || typeof client.getJson !== "function") {
    throw new TypeError("A Polymarket Data API client is required");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("concurrency must be 1..32");
  }
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new TypeError("Invalid audit time window");
  }
  const windowStartSeconds = nowSeconds - lookbackDays * 86400;
  let completed = 0;
  const failures = new Map();
  const samples = [];

  const snapshots = await mapLimit(candidates, concurrency, async (candidate) => {
    try {
      const [redeemable, closed] = await Promise.all([
        fetchRedeemablePositionSnapshot(client, candidate.wallet, { includeTokenFacts: false,
          onPage: (progress) => onProgress?.({ ...progress, stage: "redeemable_positions", wallet: candidate.wallet }),
        }),
        fetchClosedPositionSnapshot(client, candidate.wallet, {
          startSeconds: windowStartSeconds,
          endSeconds: nowSeconds,
          maxPages: 100,
          onPage: (progress) => onProgress?.({ ...progress, stage: "closed_positions", wallet: candidate.wallet }),
        }),
      ]);
      if (!redeemable.complete || !closed.complete) {
        const error = new Error("Wallet position snapshots are incomplete");
        error.auditStage = "position_snapshot_validation";
        throw error;
      }
      return { candidate, redeemable, closed, error: null };
    } catch (error) {
      const stage = error?.auditStage ?? "position_snapshots";
      const message = error?.message ?? String(error);
      const key = `${stage}: ${message}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
      if (samples.length < 12) samples.push({ wallet: candidate.wallet, stage, message });
      return { candidate, error: { stage, message } };
    } finally {
      completed += 1;
      if (onProgress && (completed % 5 === 0 || completed === candidates.length)) {
        await onProgress({
          stage: "position_snapshots",
          completed,
          total: candidates.length,
          failed: [...failures.values()].reduce((sum, count) => sum + count, 0),
          commonErrors: [...failures.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)
            .map(([error,count])=>({error,count})),
          errorSamples: samples.slice(0,5),
        });
      }
    }
  });

  const usable = snapshots.filter((item) => !item.error);
  const tokenIds = new Set();
  const conditionIds = new Set();
  for (const item of usable) {
    for (const record of item.redeemable.records) {
      tokenIds.add(String(record.position.token_id));
      conditionIds.add(String(record.position.condition_id).toLowerCase());
    }
    for (const record of item.closed.records) {
      tokenIds.add(String(record.position.token_id));
      conditionIds.add(String(record.position.condition_id).toLowerCase());
    }
  }

  const missingTokenIds = [...tokenIds].filter((id) => !sharedTokenFacts.has(id));
  const missingConditionIds = [...conditionIds].filter((id) => !sharedResolutions.has(id));
  try {
    const [newTokenFacts, newResolutions] = await Promise.all([
      fetchTokenFacts(client, missingTokenIds, {
        concurrency: 8,
        onProgress: (progress) => onProgress?.({ ...progress, failed: [...failures.values()].reduce((sum, count) => sum + count, 0) }),
      }),
      fetchMarketResolutions(client, missingConditionIds, {
        concurrency: 8,
        onProgress: (progress) => onProgress?.({ ...progress, failed: [...failures.values()].reduce((sum, count) => sum + count, 0) }),
      }),
    ]);
    for (const [id, fact] of newTokenFacts) sharedTokenFacts.set(id, fact);
    for (const [id, fact] of newResolutions) sharedResolutions.set(id, fact);
  } catch (error) {
    const stage = error?.auditStage ?? "shared_settlement_facts";
    const message = error?.message ?? String(error);
    const key = `${stage}: ${message}`;
    failures.set(key, (failures.get(key) ?? 0) + usable.length);
    if (samples.length < 12) samples.push({ wallet: "BATCH", stage, message });
    sharedTokenFacts.clear();
    sharedResolutions.clear();
    for (const item of usable) item.error = { stage, message };
  }

  const results = snapshots.map((item) => {
    if (item.error) {
      return {
        wallet: item.candidate.wallet,
        username: item.candidate.username,
        complete: false,
        qualification: { qualified: false, reason: "audit_error" },
        auditStage: item.error.stage,
        error: item.error.message,
      };
    }
    const summary = summarizeSettledEvidence({
      closedPositions: item.closed.records,
      currentPositions: item.redeemable.records,
      tokenFacts: sharedTokenFacts,
      resolutions: sharedResolutions,
      closedPositionsComplete: item.closed.complete,
      positionsComplete: item.redeemable.complete,
      windowStartSeconds,
    });
    const audit = {
      wallet: item.candidate.wallet,
      complete: true,
      coverage: "30_DAY_CLOSED_POSITIONS_PLUS_REDEEMABLE_WINS_AND_LOSSES",
      closedPositions: item.closed.records.length,
      closedPositionPages: item.closed.pages,
      positionPartitions: item.redeemable.partitions,
      tokenFacts: sharedTokenFacts.size,
      resolutionFacts: sharedResolutions.size,
      summary,
    };
    return {
      wallet: item.candidate.wallet,
      username: item.candidate.username,
      complete: true,
      qualification: qualifyWalletAudit(audit, { minimumResolvedMarkets, minimumWinRate }),
      summary,
      coverage: audit.coverage,
      recentBuys: [],
      currentPositions: [],
      comboRows: [],
    };
  });

  const failed = results.filter((row) => row.complete !== true).length;
  return {
    results,
    complete: results.length === candidates.length,
    allAuditsComplete: failed === 0,
    completed: results.length,
    failed,
    errorCounts: Object.fromEntries(failures),
    errorSamples: samples,
    sharedTokenFacts: sharedTokenFacts.size,
    sharedResolutionFacts: sharedResolutions.size,
    uniqueTokens: tokenIds.size,
    uniqueMarkets: conditionIds.size,
    tokenFactsCache: sharedTokenFacts,
    resolutionsCache: sharedResolutions,
  };
}
