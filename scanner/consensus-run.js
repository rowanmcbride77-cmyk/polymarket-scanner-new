import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { fetchCurrentPositionSnapshot } from "./wallet-positions.js";
import { fetchRecentWalletActivity } from "./activity.js";
import { fetchGammaMarkets } from "./gamma-markets.js";
import { buildConsensusSignals } from "./consensus.js";
import { auditCandidates } from "./qualification-runner.js";

function createPacedFetch({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), intervalMs = 55 } = {}) {
  const nextStartAtByRoute = new Map();
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(input.url ?? input);
    const route = url.origin + url.pathname;
    const now = Date.now();
    const startAt = Math.max(now, nextStartAtByRoute.get(route) ?? 0);
    nextStartAtByRoute.set(route, startAt + intervalMs);
    if (startAt > now) await sleep(startAt - now);
    return fetchImpl(input, init);
  };
}

async function writeJson(path, value) {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

function validQualificationRules(value) {
  return value?.minimumWinRate === 0.9 &&
    value?.minimumResolvedMarkets === 10 &&
    value?.lookbackDays === 60 &&
    value?.earlyExitsCounted === false &&
    value?.settlementIntegrityRequired === true;
}

export function validateQualifiedBoard(board, period, generatedAt) {
  const rules = validQualificationRules(board?.qualification);
  if (board?.period !== period || board?.generatedAt !== generatedAt ||
      board?.validation?.passed !== true || board?.validation?.complete !== true ||
      !rules || !Array.isArray(board?.traders) || board.count !== board.traders.length) {
    throw new Error(`The ${period} settlement-qualified board is stale or incomplete`);
  }
  for (const [index, row] of board.traders.entries()) {
    if (!/^0x[a-f0-9]{40}$/i.test(row.wallet ?? "") ||
        !Number.isFinite(row.winRate) || row.winRate < 0.9 ||
        !Number.isInteger(row.resolvedMarkets) || row.resolvedMarkets < 10 ||
        !Number.isInteger(row.wins) || !Number.isInteger(row.losses) ||
        row.wins + row.losses !== row.resolvedMarkets ||
        row.earlyExitsCounted !== 0 ||
        Math.abs(row.winRate - row.wins / row.resolvedMarkets) > 1e-9) {
      throw new Error(`The ${period} board contains a non-qualified trader at row ${index + 1}`);
    }
  }
  return board.traders;
}

export function qualifiedWalletsFromBoards(week, month) {
  const byWallet = new Map();
  for (const row of [...week.traders, ...month.traders]) {
    byWallet.set(row.wallet.toLowerCase(), {
      wallet: row.wallet.toLowerCase(),
      username: row.username ?? null,
      winRate: row.winRate,
      resolvedMarkets: row.resolvedMarkets,
    });
  }
  return [...byWallet.values()];
}

export async function runConsensus({ nowSeconds = Math.floor(Date.now() / 1000), concurrency = Number(process.env.SCANNER_CONCURRENCY ?? 16) } = {}) {
  const [status, week, month] = await Promise.all([
    readFile(resolve("site/data/qualification-status.json"), "utf8").then(JSON.parse),
    readFile(resolve("site/data/qualified-week.json"), "utf8").then(JSON.parse),
    readFile(resolve("site/data/qualified-month.json"), "utf8").then(JSON.parse),
  ]);
  if (status.schemaVersion !== 1 || status.state !== "success" ||
      status.validation?.passed !== true || status.validation?.complete !== true ||
      status.auditUniverseComplete !== true ||
      status.sourceCandidateCount !== status.discoveredWallets || status.discoveredWallets !== 1000 ||
      status.auditedWallets !== status.discoveredWallets ||
      status.earlyExitsIncluded !== false || !validQualificationRules(status.qualification) ||
      week.period !== "week" || month.period !== "month" ||
      week.validation?.passed !== true || week.validation?.complete !== true ||
      !validQualificationRules(week.qualification) ||
      month.validation?.passed !== true || month.validation?.complete !== true ||
      !validQualificationRules(month.qualification)) {
    throw new Error("Fresh validated 90% settlement-qualified trader boards are required before consensus scanning");
  }
  validateQualifiedBoard(week, "week", status.generatedAt);
  validateQualifiedBoard(month, "month", status.generatedAt);
  const wallets = qualifiedWalletsFromBoards(week, month);
  const windowMinutes = 60;
  const startSeconds = nowSeconds - windowMinutes * 60;
  process.stdout.write(`Live copy-signal scan: ${wallets.length} 90%+ qualified traders; checking current holdings and the last ${windowMinutes} minutes of buys and sells.\n`);

  const generatedAt = new Date(nowSeconds * 1000).toISOString();
  const qualificationBasis = {
    minimumWinRate: 0.9,
    minimumResolvedMarkets: 10,
    lookbackDays: 60,
    earlyExitsCounted: false,
    settlementIntegrityRequired: true,
    auditedCandidateCount: status.auditedWallets,
    discoveredCandidateCount: status.sourceCandidateCount ?? status.discoveredWallets,
    auditUniverseComplete: status.auditUniverseComplete ?? true,
  };
  if (wallets.length === 0) {
    const consensus = {
      schemaVersion: 1, generatedAt,
      validation: { passed: true, complete: true, failedWallets: 0 },
      walletUniverse: "settlement-qualified-top1000",
      walletsChecked: 0,
      qualifiedWalletsConsidered: 0,
      qualificationBasis,
      marketsWithRecentQualifiedBuys: 0,
      signalCount: 0,
      thresholds: { windowMinutes, maxResolutionHours: 24, minWallets: 8, minUsdPerWallet: 10, requireRecentBuy: true },
      exclusions: { no_settlement_qualified_wallets: 1 },
      scanDiagnostics: {
        qualifiedWallets: 0, activityWalletsChecked: 0, positionAndActivitySnapshotsComplete: true,
        activityWindowMinutes: windowMinutes, uniqueConditions: 0, marketMetadataReturned: 0, failedWallets: 0,
      },
      signals: [], exitAlerts: [], exitAlertCount: 0,
      combos: { validation: { passed: true, complete: true, failedWallets: 0 }, walletsChecked: 0, walletsWithComboData: 0, count: 0,
        thresholds: { minEntryUsd: 5, maxEntryUsd: 100, minMultiplier: 10, requireCurrentHolding: true, traderWinRateRequired: false }, exclusions: {}, opportunities: [] },
    };
    const statusOut = {
      schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
      validation: { passed: true }, state: "success",
      message: "No wallets met the settlement qualification rules in the audited candidate set; no consensus scan was needed.",
      discoveredWallets: status.discoveredWallets ?? 0,
      sourceCandidateCount: status.sourceCandidateCount ?? status.discoveredWallets ?? 0,
      auditUniverseComplete: status.auditUniverseComplete ?? true,
      auditedWallets: status.auditedWallets ?? 0,
      fullyAuditedWallets: status.fullyAuditedWallets ?? 0,
      failedWalletAudits: status.failedWalletAudits ?? 0,
      qualifiedWallets: 0,
      weeklyCount: week.traders.length, monthlyCount: month.traders.length,
      consensusWalletsChecked: 0, consensusWalletAuditFailures: 0, consensusCount: 0, exitAlertCount: 0,
    };
    await writeJson("site/data/consensus.json", consensus);
    await writeJson("site/data/consensus-status.json", statusOut);
    process.stdout.write("No settlement-qualified wallets; published a validated empty consensus snapshot.\\n");
    return consensus;
  }

  const scanWalletBatch = async ({ intervalMs, workers, label }) => {
    const pacedFetch = createPacedFetch({ intervalMs });
    const client = createDataApiClient({ fetchImpl: pacedFetch, maxRetries: 8, baseDelayMs: 1000, maxDelayMs: 30_000 });
    return auditCandidates(wallets, {
      concurrency: workers,
      auditWallet: async (wallet) => {
        const [positions, activity] = await Promise.all([
          fetchCurrentPositionSnapshot(client, wallet, { limit: 1000, maxPages: 10 }),
          fetchRecentWalletActivity(client, wallet, { startSeconds, endSeconds: nowSeconds, maxPages: 20 }),
        ]);
        const recentBuys = activity.rows.filter(row =>
          String(row.type).toUpperCase() === "TRADE" && String(row.side).toUpperCase() === "BUY")
          .map(row => ({
            conditionId: String(row.condition_id).toLowerCase(),
            tokenId: String(row.token_id),
            timestamp: row.timestamp,
            size: row.size,
            usdSize: row.usdc_size,
            price: row.price,
          }));
        const recentSells = activity.rows.filter(row =>
          String(row.type).toUpperCase() === "TRADE" && String(row.side).toUpperCase() === "SELL")
          .map(row => ({
            wallet: wallet.toLowerCase(),
            conditionId: String(row.condition_id).toLowerCase(),
            tokenId: String(row.token_id),
            timestamp: row.timestamp,
            size: row.size,
            usdSize: row.usdc_size,
            price: row.price,
          }));
        return {
          complete: positions.complete === true && activity.complete === true,
          qualification: { qualified: true, reason: "verified_90_percent_settlement_qualification" },
          currentPositions: positions.records,
          recentBuys,
          recentSells,
          coverage: { positions: positions.coverage, activity: activity.coverage, activityComplete: activity.complete, positionPages: positions.pages, positionHasMore: positions.hasMore },
        };
      },
      onProgress: ({ completed, total, failed, commonErrors }) => {
        process.stdout.write(`${label}: ${completed}/${total}; failures: ${failed}; ${JSON.stringify(commonErrors ?? [])}\n`);
      },
    });
  };

  let batch = await scanWalletBatch({ intervalMs: 65, workers: concurrency, label: "Qualified trader activity" });
  if (!batch.allAuditsComplete) {
    const failed = batch.results.filter(row => row?.complete !== true);
    process.stdout.write(`Retrying ${failed.length} incomplete qualified-trader snapshots at a slower rate.\n`);
    if (failed.length) {
      const retry = await scanWalletBatch({ intervalMs: 140, workers: 4, label: "Qualified trader retry" });
      const retryByWallet = new Map(retry.results.map(row => [row.wallet.toLowerCase(), row]));
      batch.results = batch.results.map(row => retryByWallet.get(row.wallet.toLowerCase()) ?? row);
      batch.failed = batch.results.filter(row => row?.complete !== true).length;
      batch.completed = wallets.length;
      batch.allAuditsComplete = batch.failed === 0;
    }
  }
  if (!batch.allAuditsComplete) {
    throw new Error(`Refusing partial live copy signals: ${batch.failed}/${wallets.length} qualified trader activity snapshots remain incomplete`);
  }

  const allPositions = batch.results.flatMap(row => row.currentPositions ?? []);
  const allSells = batch.results.flatMap(row => row.recentSells ?? []);
  const conditionIds = [...new Set([...allPositions.map(row => row.conditionId), ...allSells.map(row => row.conditionId)].filter(Boolean))];
  const tokenIds = [...new Set([...allPositions.map(row => row.tokenId), ...allSells.map(row => row.tokenId)].filter(Boolean))];
  process.stdout.write(`Enriching ${conditionIds.length} markets for live buy consensus and exit alerts.\n`);
  const marketFacts = await fetchGammaMarkets(conditionIds, { tokenIds, fetchImpl: createPacedFetch({ intervalMs: 90 }), batchSize: 100 });
  const result = buildConsensusSignals({ complete: true, results: batch.results }, marketFacts, {
    nowSeconds, windowMinutes, maxResolutionHours: 24,
    minWallets: 8, minUsdPerWallet: 10, requireRecentBuy: true,
  });

  const currentHoldings = new Set();
  for (const row of batch.results) for (const p of row.currentPositions ?? []) {
    currentHoldings.add(`${row.wallet.toLowerCase()}:${p.conditionId}:${p.tokenId}`);
  }
  const exits = allSells.map(sell => {
    const trader = wallets.find(w => w.wallet === sell.wallet);
    const market = marketFacts.get(sell.conditionId);
    const key = `${sell.wallet}:${sell.conditionId}:${sell.tokenId}`;
    const auditRow = batch.results.find(row => row.wallet.toLowerCase() === sell.wallet);
    const coverage = auditRow?.coverage;
    const stillHeld = currentHoldings.has(key);
    return {
      trader: trader?.username && !/^0x[a-f0-9]{40}(?:-|$)/i.test(trader.username) ? trader.username : `Trader #${wallets.findIndex(w => w.wallet === sell.wallet) + 1}`,
      conditionId: sell.conditionId,
      tokenId: sell.tokenId,
      marketTitle: market?.title ?? "Market details unavailable",
      timestamp: sell.timestamp,
      usdSize: sell.usdSize,
      size: sell.size,
      price: sell.price,
      status: stillHeld ? "sale_observed_still_holding" : coverage?.positionHasMore ? "not_in_first_10_position_pages_status_unknown" : "not_currently_held",
    };
  }).sort((a,b) => b.timestamp-a.timestamp).slice(0,200);

  const consensus = {
    schemaVersion: 1, generatedAt,
    validation: { passed: true, complete: true, failedWallets: 0 },
    walletUniverse: "settlement-qualified-top100",
    walletsChecked: wallets.length,
    qualifiedWalletsConsidered: wallets.length,
    qualificationBasis,
    marketsWithRecentQualifiedBuys: result.marketsWithRecentQualifiedBuys,
    signalCount: result.signals.length,
    thresholds: { ...result.thresholds, basis: "Only 90%+ settlement-qualified traders; each must have bought within 60 minutes and still hold the same outcome." },
    exclusions: result.exclusions,
    scanDiagnostics: {
      qualifiedWallets: wallets.length,
      activityWalletsChecked: batch.completed,
      positionAndActivitySnapshotsComplete: batch.allAuditsComplete,
      activityWindowMinutes: windowMinutes,
      uniqueConditions: conditionIds.length,
      marketMetadataReturned: marketFacts.size,
      failedWallets: batch.failed,
    },
    signals: result.signals,
    exitAlerts: exits,
    exitAlertCount: exits.length,
    combos: { validation: { passed: true, complete: true, failedWallets: 0 }, walletsChecked: 0, walletsWithComboData: 0, count: 0,
      thresholds: { minEntryUsd: 5, maxEntryUsd: 100, minMultiplier: 10, requireCurrentHolding: true, traderWinRateRequired: false }, exclusions: {}, opportunities: [] },
  };
  const statusOut = {
    schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
    validation: { passed: true }, state: "success",
    message: "Live same-side signals and observed sales from settlement-qualified traders only.",
    discoveredWallets: status.discoveredWallets ?? 0,
    sourceCandidateCount: status.sourceCandidateCount ?? status.discoveredWallets ?? 0,
    auditUniverseComplete: status.auditUniverseComplete ?? true,
    auditedWallets: status.auditedWallets ?? 0,
    fullyAuditedWallets: status.fullyAuditedWallets ?? 0,
    failedWalletAudits: status.failedWalletAudits ?? 0,
    qualifiedWallets: wallets.length,
    weeklyCount: week.traders.length, monthlyCount: month.traders.length,
    consensusWalletsChecked: batch.completed, consensusWalletAuditFailures: batch.failed,
    consensusCount: result.signals.length, exitAlertCount: exits.length,
  };
  await writeJson("site/data/consensus.json", consensus);
  await writeJson("site/data/consensus-status.json", statusOut);
  process.stdout.write(`Qualified live signals complete: ${result.signals.length} same-side markets; ${exits.length} recent sale observations; ${batch.completed}/${wallets.length} traders.\n`);
  return consensus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConsensus().catch(error => {
    process.stderr.write(`Consensus failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
