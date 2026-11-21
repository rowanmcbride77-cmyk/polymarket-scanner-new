import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { fetchRecentWalletActivity } from "./activity.js";
import { fetchCurrentPositionSnapshot } from "./wallet-positions.js";
import { fetchGammaMarkets } from "./gamma-markets.js";
import { buildConsensusSignals } from "./consensus.js";
import { auditCandidates } from "./qualification-runner.js";
import { validatePublishedOutput } from "./validate-output.js";
import { fetchWalletCombos, buildComboOpportunities } from "./combos.js";

function createPacedFetch({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  intervalMs = 80,
} = {}) {
  // Pace each endpoint independently. A single global queue needlessly
  // serialized positions, tokens, and resolutions requests and made a
  // 20,000-wallet audit take hours. Keep a conservative lane per API route.
  const nextStartAtByRoute = new Map();
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(input.url ?? input);
    const route = `${url.origin}${url.pathname}`;
    const now = Date.now();
    const startAt = Math.max(now, nextStartAtByRoute.get(route) ?? 0);
    nextStartAtByRoute.set(route, startAt + intervalMs);
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

function qualifiedUniverse(qualification, weekly, monthly) {
  if (Array.isArray(qualification.qualifiedWallets)) {
    return qualification.qualifiedWallets.map((row) => ({
      wallet: row.wallet, username: row.username,
      summary: row.summary ?? null,
    }));
  }
  const byWallet = new Map();
  for (const row of [...weekly.traders, ...monthly.traders]) {
    if (!row.wallet || row.winRate < 0.9 || row.resolvedMarkets < 20) continue;
    byWallet.set(row.wallet.toLowerCase(), {
      wallet: row.wallet, username: row.username,
      summary: {
        wins: row.wins, losses: row.losses,
        resolvedMarkets: row.resolvedMarkets, winRate: row.winRate,
        integrityPassed: true,
      },
    });
  }
  return [...byWallet.values()];
}

export async function runConsensus({
  nowSeconds = Math.floor(Date.now() / 1000),
  concurrency = Number(process.env.SCANNER_CONCURRENCY ?? 16),
} = {}) {
  const [qualification, weekly, monthly] = await Promise.all([
    readFile(resolve("data/qualification.json"), "utf8").then(JSON.parse),
    readFile(resolve("data/week.json"), "utf8").then(JSON.parse),
    readFile(resolve("data/month.json"), "utf8").then(JSON.parse),
  ]);
  for (const data of [qualification, weekly, monthly]) {
    if (data.schemaVersion !== 1 || data.validation?.passed !== true) {
      throw new Error("Qualified leaderboard inputs failed validation");
    }
  }
  if (!Array.isArray(weekly.traders) || !Array.isArray(monthly.traders)) {
    throw new Error("Weekly/monthly leaderboard shape is invalid");
  }

  const wallets = qualifiedUniverse(qualification, weekly, monthly);
  const walletByAddress = new Map(wallets.map((row) => [row.wallet.toLowerCase(), row]));
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  process.stdout.write(`Checking the last 60 minutes of BUY activity for ${wallets.length} qualified wallets.\n`);
  const batch = await auditCandidates(wallets, {
    concurrency,
    auditWallet: async (wallet) => {
      const recent = await fetchRecentWalletActivity(client, wallet, {
        startSeconds: nowSeconds - 60 * 60,
        endSeconds: nowSeconds,
        type: "TRADE",
        maxPages: 100,
      });
      const recentBuys = recent.rows
        .filter((row) => String(row.type).toUpperCase() === "TRADE" &&
          String(row.side).toUpperCase() === "BUY" &&
          typeof row.condition_id === "string" && typeof row.token_id === "string" &&
          Number.isFinite(row.size) && row.size > 0 &&
          Number.isFinite(row.timestamp) && row.timestamp >= nowSeconds - 3600 &&
          row.timestamp <= nowSeconds)
        .map((row) => ({
          conditionId: row.condition_id.toLowerCase(),
          tokenId: String(row.token_id),
          timestamp: row.timestamp,
          size: row.size,
          price: row.price,
          usdSize: Number.isFinite(row.usdc_size) ? row.usdc_size
            : Number.isFinite(row.price) ? row.price * row.size : null,
          outcome: typeof row.outcome === "string" ? row.outcome : null,
        }));
      const currentSnapshot = recent.complete && recentBuys.length
        ? await fetchCurrentPositionSnapshot(client, wallet)
        : { records: [], complete: recent.complete, pages: 0 };
      const source = walletByAddress.get(wallet.toLowerCase());
      return {
        complete: recent.complete && currentSnapshot.complete,
        qualification: { qualified: true, reason: "qualified_weekly_or_monthly_top100" },
        summary: source?.summary,
        recentBuys,
        currentPositions: currentSnapshot.records,
        coverage: recent.coverage,
        positionPages: currentSnapshot.pages,
      };
    },
    onProgress: ({ completed, total, failed }) => {
      process.stdout.write(`Recent activity: ${completed}/${total}; failures: ${failed}.\n`);
    },
  });
  if (!batch.allAuditsComplete) {
    await writeJsonAtomic("data/consensus-incomplete.json", {
      schemaVersion: 1,
      validation: { passed: false, complete: false, failedWallets: batch.failed },
      results: batch.results,
    });
    throw new Error(`Recent activity incomplete for ${batch.failed} wallets; no consensus published.`);
  }

  const conditionIds = [...new Set(batch.results
    .flatMap((row) => row.recentBuys ?? [])
    .map((buy) => buy.conditionId)
    .filter(Boolean))];
  const marketFacts = await fetchGammaMarkets(conditionIds, { fetchImpl: pacedFetch });
  const auditBatch = {
    complete: true,
    results: batch.results.map((row) => ({
      ...row,
      qualification: { qualified: true },
    })),
  };
  const result = buildConsensusSignals(auditBatch, marketFacts, {
    nowSeconds,
    windowMinutes: 60,
    maxResolutionHours: 24,
    minWallets: 8,
    minUsdPerWallet: 10,
  });
  process.stdout.write(`Checking active combo positions for ${wallets.length} qualified wallets.\\n`);
  const comboBatch = await auditCandidates(wallets, {
    concurrency: Math.min(concurrency, 12),
    auditWallet: async (wallet) => {
      const fetched = await fetchWalletCombos(client, wallet, { maxPages: 3, limit: 1000 });
      const trader = walletByAddress.get(wallet.toLowerCase());
      return {
        complete: fetched.complete,
        comboRows: fetched.rows.map((row) => ({
          ...row, _wallet: wallet.toLowerCase(), _username: trader?.username ?? null,
        })),
      };
    },
    onProgress: ({ completed, total, failed }) => {
      process.stdout.write(`Combo positions: ${completed}/${total}; failures: ${failed}.\\n`);
    },
  });
  const comboRows = comboBatch.results.flatMap((row) => row.comboRows ?? []);
  const comboResult = buildComboOpportunities(comboRows, {
    nowMs: nowSeconds * 1000,
    minEntryUsd: 5,
    maxEntryUsd: 100,
    minMultiplier: 10,
  });
  const generatedAt = new Date(nowSeconds * 1000).toISOString();
  const consensus = {
    schemaVersion: 1,
    generatedAt,
    validation: { passed: true, complete: true },
    walletUniverse: Array.isArray(qualification.qualifiedWallets)
      ? "all-qualified-wallets"
      : "union-of-weekly-and-monthly-top100",
    walletsChecked: wallets.length,
    qualifiedWalletsConsidered: result.qualifiedWalletsConsidered,
    marketsWithRecentQualifiedBuys: result.marketsWithRecentQualifiedBuys,
    signalCount: result.signals.length,
    thresholds: result.thresholds,
    exclusions: result.exclusions,
    signals: result.signals,
    combos: {
      validation: { passed: comboBatch.allAuditsComplete, complete: comboBatch.allAuditsComplete, failedWallets: comboBatch.failed },
      walletsChecked: wallets.length,
      walletsWithComboData: new Set(comboRows.map((row) => row._wallet)).size,
      count: comboResult.opportunities.length,
      thresholds: comboResult.thresholds,
      exclusions: comboResult.exclusions,
      opportunities: comboResult.opportunities,
    },
  };
  const completedAt = new Date().toISOString();
  const status = {
    schemaVersion: 1,
    generatedAt,
    completedAt,
    validation: { passed: true },
    state: "success",
    message: "Wallet rankings and same-side consensus passed validation.",
    discoveredWallets: qualification.validation.discoveredWallets ?? 0,
    auditedWallets: qualification.validation.auditedWallets ?? 0,
    fullyAuditedWallets: qualification.validation.fullyAuditedWallets ?? qualification.validation.auditedWallets ?? 0,
    failedWalletAudits: qualification.validation.failedWalletAudits ?? 0,
    allWalletAuditsComplete: qualification.validation.allWalletAuditsComplete ?? true,
    qualifiedWallets: qualification.validation.qualifiedWallets ?? wallets.length,
    disqualifiedWallets: qualification.auditSummary?.disqualifiedWallets ?? 0,
    earlyExitsExcluded: qualification.auditSummary?.earlyExitsExcluded,
    ambiguousSameSecondExcluded: qualification.auditSummary?.ambiguousSameSecondExcluded ?? 0,
    postResolutionAcquisitionsExcluded: qualification.auditSummary?.postResolutionAcquisitionsExcluded ?? 0,
    weeklyCount: weekly.traders.length,
    monthlyCount: monthly.traders.length,
    consensusCount: result.signals.length,
    comboCount: comboResult.opportunities.length,
    comboScanComplete: comboBatch.allAuditsComplete,
    comboScanFailures: comboBatch.failed,
  };
  const finalValidation = validatePublishedOutput({ qualification, weekly, monthly, consensus, status });
  process.stdout.write(`Final publication validation passed: ${finalValidation.weekly} weekly, ${finalValidation.monthly} monthly, ${finalValidation.signals} consensus signals.\n`);
  await writeJsonAtomic("data/consensus.json", consensus);
  await writeJsonAtomic("data/status.json", status);
  process.stdout.write(`Consensus complete: ${result.signals.length} signals from ${wallets.length} qualified wallets.\n`);
  return consensus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConsensus().catch((error) => {
    process.stderr.write(`Consensus failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
