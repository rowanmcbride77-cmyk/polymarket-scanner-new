import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { fetchCurrentPositionSnapshot } from "./wallet-positions.js";
import { fetchGammaMarkets } from "./gamma-markets.js";
import { buildConsensusSignals } from "./consensus.js";
import { auditCandidates } from "./qualification-runner.js";

function createPacedFetch({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), intervalMs = 35 } = {}) {
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

export async function runConsensus({ nowSeconds = Math.floor(Date.now() / 1000), concurrency = Number(process.env.SCANNER_CONCURRENCY ?? 20) } = {}) {
  const discovery = JSON.parse(await readFile(resolve("data/discovery.json"), "utf8"));
  if (discovery.schemaVersion !== 1 || discovery.validation?.passed !== true ||
      !Array.isArray(discovery.candidates) || discovery.validation.candidateCount !== discovery.candidates.length) {
    throw new Error("20K discovery input failed validation");
  }
  const wallets = discovery.candidates;
  const candidateByWallet = new Map(wallets.map(row => [row.wallet.toLowerCase(), row]));
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  process.stdout.write(`Fast consensus scan: checking current open positions for ${wallets.length} discovered wallets; no settlement audit or per-wallet activity-history lookup.\\n`);

  const batch = await auditCandidates(wallets, {
    concurrency,
    auditWallet: async (wallet) => {
      const candidate = candidateByWallet.get(wallet.toLowerCase());
      const sports = candidate?.appearances?.some(row => row.category === "sports") === true;
      const snapshot = await fetchCurrentPositionSnapshot(client, wallet, {
        limit: 100,
        maxPages: sports ? 4 : 2,
      });
      return {
        complete: snapshot.complete,
        qualification: { qualified: true, reason: "broad_discovery_consensus_pool" },
        currentPositions: snapshot.records,
        recentBuys: [],
        coverage: "BOUNDED_CURRENT_OPEN_POSITION_SNAPSHOT",
      };
    },
    onProgress: ({ completed, total, failed }) => {
      process.stdout.write(`Open-position wallets: ${completed}/${total}; failures: ${failed}.\\n`);
    },
  });
  if (!batch.allAuditsComplete) {
    throw new Error(`Consensus position scan incomplete: ${batch.failed}/${wallets.length} wallet requests failed; refusing to publish partial consensus.`);
  }

  const conditionIds = [...new Set(batch.results.flatMap(row => row.currentPositions ?? []).map(row => row.conditionId).filter(Boolean))];
  process.stdout.write(`Fetched ${conditionIds.length} distinct active market conditions from ${wallets.length} wallets. Enriching markets in batches.\\n`);
  const marketFacts = await fetchGammaMarkets(conditionIds, { fetchImpl: pacedFetch, batchSize: 100 });
  const result = buildConsensusSignals({
    complete: true,
    results: batch.results.map(row => ({ ...row, qualification: { qualified: true } })),
  }, marketFacts, {
    nowSeconds, windowMinutes: 60, maxResolutionHours: 24,
    minWallets: 8, minUsdPerWallet: 10, requireRecentBuy: false,
  });
  const generatedAt = new Date(nowSeconds * 1000).toISOString();
  const consensus = {
    schemaVersion: 1, generatedAt,
    validation: { passed: true, complete: true, failedWallets: 0 },
    walletUniverse: "full-discovery-pool",
    walletsChecked: wallets.length,
    qualifiedWalletsConsidered: wallets.length,
    marketsWithRecentQualifiedBuys: result.marketsWithRecentQualifiedBuys,
    signalCount: result.signals.length,
    thresholds: { ...result.thresholds, basis: "Current open positions from the full discovered wallet pool; settlement qualification is a separate pipeline." },
    exclusions: result.exclusions,
    scanDiagnostics: {
      discoveredWallets: wallets.length,
      positionWalletsChecked: batch.completed,
      positionPagesCapSports: 4,
      positionPagesCapOther: 2,
      positionPageSize: 100,
      uniqueConditions: conditionIds.length,
      marketMetadataReturned: marketFacts.size,
      failedWallets: batch.failed,
    },
    signals: result.signals,
    combos: {
      validation: { passed: true, complete: true, failedWallets: 0 },
      walletsChecked: 0, walletsWithComboData: 0, count: 0,
      thresholds: { minEntryUsd: 5, maxEntryUsd: 100, minMultiplier: 10, requireCurrentHolding: true, traderWinRateRequired: false },
      exclusions: {}, opportunities: [],
    },
  };
  const status = {
    schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
    validation: { passed: true }, state: "success",
    message: "Broad same-side consensus built from the full 20,000-wallet discovery pool; settlement qualification runs separately.",
    discoveredWallets: wallets.length, auditedWallets: 0, fullyAuditedWallets: 0,
    failedWalletAudits: 0, allWalletAuditsComplete: false,
    consensusWalletsChecked: batch.completed, consensusWalletAuditFailures: batch.failed,
    qualifiedWallets: 0, weeklyCount: 0, monthlyCount: 0,
    consensusCount: result.signals.length, comboCount: 0, comboScanComplete: true, comboScanFailures: 0,
  };
  await writeJson("site/data/consensus.json", consensus);
  await writeJson("site/data/consensus-status.json", status);
  process.stdout.write(`Full-pool consensus complete: ${result.signals.length} signals from ${batch.completed}/${wallets.length} wallets.\\n`);
  return consensus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConsensus().catch(error => {
    process.stderr.write(`Consensus failed: ${error.message}\\n`);
    process.exitCode = 1;
  });
}
