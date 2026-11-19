import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDataApiClient } from "./data-api.js";
import { fetchRecentWalletActivity } from "./activity.js";
import { fetchGammaMarkets } from "./gamma-markets.js";
import { buildConsensusSignals } from "./consensus.js";
import { auditCandidates } from "./qualification-runner.js";

function createPacedFetch({ fetchImpl = globalThis.fetch, sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) } = {}) {
  const nextStartByLane = new Map();
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const lane = url.pathname === "/v2/activity" ? "activity" : "general";
    const interval = lane === "activity" ? 50 : 30;
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

function qualifiedUniverse(qualification, weekly, monthly) {
  if (Array.isArray(qualification.qualifiedWallets) && qualification.qualifiedWallets.length) {
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
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  process.stdout.write(`Checking the last 60 minutes of BUY activity for ${wallets.length} qualified wallets.\n`);
  const batch = await auditCandidates(wallets, {
    concurrency,
    auditWallet: async (wallet) => {
      const recent = await fetchRecentWalletActivity(client, wallet, {
        startSeconds: nowSeconds - 60 * 60,
        endSeconds: nowSeconds,
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
      const source = wallets.find((item) => item.wallet.toLowerCase() === wallet.toLowerCase());
      return {
        complete: recent.complete,
        qualification: { qualified: true, reason: "qualified_weekly_or_monthly_top100" },
        summary: source?.summary,
        recentBuys,
        coverage: recent.coverage,
      };
    },
    onProgress: ({ completed, total, failed }) => {
      process.stdout.write(`Recent activity: ${completed}/${total}; failures: ${failed}.\n`);
    },
  });
  if (!batch.complete) {
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
  };
  await writeJsonAtomic("data/consensus.json", consensus);
  await writeJsonAtomic("data/status.json", {
    schemaVersion: 1,
    generatedAt,
    completedAt: generatedAt,
    validation: { passed: true },
    state: "success",
    message: "Wallet rankings and same-side consensus passed validation.",
    discoveredWallets: qualification.validation.discoveredWallets ?? 0,
    auditedWallets: qualification.validation.auditedWallets ?? 0,
    qualifiedWallets: qualification.validation.qualifiedWallets ?? wallets.length,
    weeklyCount: weekly.traders.length,
    monthlyCount: monthly.traders.length,
    consensusCount: result.signals.length,
  });
  process.stdout.write(`Consensus complete: ${result.signals.length} signals from ${wallets.length} qualified wallets.\n`);
  return consensus;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runConsensus().catch((error) => {
    process.stderr.write(`Consensus failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
