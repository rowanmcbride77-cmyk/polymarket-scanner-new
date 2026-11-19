import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { createWalletAuditor } from "./audit-wallet.js";
import { auditCandidates, buildQualifiedLeaderboards } from "./qualification-runner.js";
import { fetchGammaMarkets } from "./gamma-markets.js";
import { buildConsensusSignals } from "./consensus.js";

function createPacedFetch({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const nextStartByLane = new Map();
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const lane = url.pathname === "/v2/activity" ? "activity"
      : url.pathname === "/v2/positions" ? "positions" : "general";
    const interval = lane === "activity" || lane === "positions" ? 50 : 30;
    const now = Date.now();
    const startAt = Math.max(now, nextStartByLane.get(lane) ?? now);
    nextStartByLane.set(lane, startAt + interval);
    if (startAt > now) await sleep(startAt - now);
    return fetchImpl(input, init);
  };
}

async function writeJsonAtomic(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, target);
  return target;
}

export async function runQualification({
  discoveryPath = "data/discovery.json",
  outputPath = "data/qualification.json",
  concurrency = Number(process.env.SCANNER_CONCURRENCY ?? 16),
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const discovery = JSON.parse(await readFile(resolve(discoveryPath), "utf8"));
  if (discovery.schemaVersion !== 1 || discovery.validation?.passed !== true ||
      !Array.isArray(discovery.candidates) ||
      discovery.validation.candidateCount !== discovery.candidates.length) {
    throw new Error("Candidate discovery input failed validation");
  }

  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  const auditWallet = createWalletAuditor(client);
  process.stdout.write(`Auditing ${discovery.candidates.length} candidate wallets; 30-day settlement window; concurrency ${concurrency}.\n`);
  const batch = await auditCandidates(discovery.candidates, {
    concurrency,
    auditWallet: (wallet) => auditWallet(wallet, {
      nowSeconds,
      lookbackDays: 30,
      minimumResolvedMarkets: 20,
      minimumWinRate: 0.9,
    }),
    onProgress: ({ completed, total, failed }) => {
      process.stdout.write(`Wallet audits: ${completed}/${total}; failures: ${failed}.\n`);
    },
  });

  const generatedAt = new Date(nowSeconds * 1000).toISOString();
  if (!batch.complete) {
    const incomplete = {
      schemaVersion: 1,
      generatedAt,
      validation: {
        passed: false,
        allWalletAuditsComplete: false,
        discoveredWallets: discovery.candidates.length,
        auditedWallets: batch.completed,
        failedWalletAudits: batch.failed,
      },
      results: batch.results,
    };
    const path = await writeJsonAtomic("data/qualification-incomplete.json", incomplete);
    throw new Error(`Wallet audit incomplete (${batch.failed} failed). No Top 100 was generated. Diagnostic: ${path}`);
  }

  const boards = buildQualifiedLeaderboards(discovery, batch, { topN: 100 });
  const recentConditionIds = [...new Set(batch.results
    .filter((row) => row.qualification.qualified)
    .flatMap((row) => (row.recentBuys ?? []).map((buy) => buy.conditionId))
    .filter(Boolean))];
  const marketFacts = await fetchGammaMarkets(recentConditionIds, { fetchImpl: pacedFetch });
  const consensus = buildConsensusSignals(batch, marketFacts, {
    nowSeconds,
    windowMinutes: 60,
    maxResolutionHours: 24,
    minWallets: 8,
    minUsdPerWallet: 10,
  });
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: "Polymarket Data API v2 activity, positions, tokens and resolutions; Gamma market metadata",
    qualification: {
      minimumResolvedMarkets: 20,
      minimumWinRate: 0.9,
      lookbackDays: 30,
      earlyExitsCounted: false,
      settlementIntegrityRequired: true,
    },
    consensusThresholds: {
      buyWindowMinutes: 60,
      maxHoursToResolution: 24,
      minimumQualifiedWallets: 8,
      minimumUsdPerWallet: 10,
      mixedOutcomesExcluded: true,
    },
    validation: {
      passed: true,
      allWalletAuditsComplete: true,
      marketMetadataComplete: true,
      discoveredWallets: discovery.candidates.length,
      auditedWallets: batch.completed,
      failedWalletAudits: 0,
      qualifiedWallets: boards.qualifiedWalletCount,
      consensusSignals: consensus.signals.length,
    },
    qualifiedWallets: batch.results
      .filter((row) => row.qualification.qualified)
      .map((row) => ({
        wallet: row.wallet,
        username: row.username,
        summary: row.summary ? {
          wins: row.summary.wins,
          losses: row.summary.losses,
          resolvedMarkets: row.summary.resolvedMarkets,
          winRate: row.summary.winRate,
          integrityPassed: row.summary.integrityPassed,
        } : null,
      })),
    weekly: boards.weekly,
    monthly: boards.monthly,
  };
  const target = await writeJsonAtomic(outputPath, payload);
  await writeJsonAtomic("data/week.json", {
    schemaVersion: 1, generatedAt, validation: { passed: true },
    count: boards.weekly.length, traders: boards.weekly,
  });
  await writeJsonAtomic("data/month.json", {
    schemaVersion: 1, generatedAt, validation: { passed: true },
    count: boards.monthly.length, traders: boards.monthly,
  });
  await writeJsonAtomic("data/consensus.json", {
    schemaVersion: 1, generatedAt,
    validation: { passed: true, complete: true },
    thresholds: consensus.thresholds,
    signalCount: consensus.signals.length,
    qualifiedWalletsConsidered: consensus.qualifiedWalletsConsidered,
    marketsWithRecentQualifiedBuys: consensus.marketsWithRecentQualifiedBuys,
    exclusions: consensus.exclusions,
    signals: consensus.signals,
  });
  await writeJsonAtomic("data/status.json", {
    schemaVersion: 1, generatedAt,
    validation: { passed: true },
    state: "success",
    completedAt: generatedAt,
    message: "All wallet audits, settlement checks, leaderboards and consensus validation passed.",
    discoveredWallets: discovery.candidates.length,
    auditedWallets: batch.completed,
    qualifiedWallets: boards.qualifiedWalletCount,
    weeklyCount: boards.weekly.length,
    monthlyCount: boards.monthly.length,
    consensusCount: consensus.signals.length,
  });
  process.stdout.write(`Qualification complete. ${boards.qualifiedWalletCount} wallets passed; weekly Top ${boards.weekly.length}; monthly Top ${boards.monthly.length}; consensus signals ${consensus.signals.length}.\n`);
  process.stdout.write(`Output: ${target}\n`);
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualification().catch((error) => {
    process.stderr.write(`Qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
