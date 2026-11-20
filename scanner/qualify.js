import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { createWalletAuditor } from "./audit-wallet.js";
import { auditCandidates, buildQualifiedLeaderboards } from "./qualification-runner.js";

function createPacedFetch({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  intervalMs = 80,
} = {}) {
  // Polymarket applies a per-client allowance across endpoints, not one
  // independent allowance per route. Keep every Data API request on one lane.
  let nextStartAt = 0;
  return async (input, init) => {
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    nextStartAt = startAt + intervalMs;
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

  const diagnosticLimit = Number(process.env.SCANNER_DIAGNOSTIC_LIMIT ?? 0);
  if (!Number.isInteger(diagnosticLimit) || diagnosticLimit < 0) throw new Error("SCANNER_DIAGNOSTIC_LIMIT must be a non-negative integer");
  const candidates = diagnosticLimit > 0 ? discovery.candidates.slice(0, diagnosticLimit) : discovery.candidates;
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  const auditWallet = createWalletAuditor(client);
  process.stdout.write(`Auditing ${candidates.length} candidate wallets${diagnosticLimit > 0 ? ` (diagnostic sample of ${discovery.candidates.length})` : ""}; 30-day settlement window; concurrency ${concurrency}.\\n`);
  const batch = await auditCandidates(candidates, {
    concurrency,
    auditWallet: (wallet) => auditWallet(wallet, {
      nowSeconds,
      lookbackDays: 30,
      minimumResolvedMarkets: 20,
      minimumWinRate: 0.9,
    }),
    onProgress: ({ completed, total, failed, commonErrors = [], errorSamples = [] }) => {
      process.stdout.write(`Wallet audits: ${completed}/${total}; failures: ${failed}.\n`);
      for (const item of commonErrors) {
        process.stdout.write(`  Failure ${item.count}x: ${item.error}\n`);
      }
      for (const sample of errorSamples) {
        process.stdout.write(`  Sample wallet ${sample.wallet}: [${sample.stage}] ${sample.message}\n`);
      }
    },
  });

  const generatedAt = new Date(nowSeconds * 1000).toISOString();
  if (diagnosticLimit > 0) {
    const diagnostic = {
      schemaVersion: 1,
      generatedAt,
      sampleSize: candidates.length,
      discoveredWallets: discovery.candidates.length,
      completed: batch.completed,
      failed: batch.failed,
      complete: batch.complete,
      errorCounts: batch.errorCounts,
      errorSamples: batch.errorSamples,
      results: batch.results,
    };
    const path = await writeJsonAtomic("data/qualification-diagnostic.json", diagnostic);
    process.stdout.write(`Diagnostic sample finished: ${batch.completed}/${candidates.length}; failures ${batch.failed}. Output: ${path}\\n`);
    return diagnostic;
  }
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
        errorCounts: batch.errorCounts,
        errorSamples: batch.errorSamples,
      },
      results: batch.results,
    };
    const path = await writeJsonAtomic("data/qualification-incomplete.json", incomplete);
    throw new Error(`Wallet audit incomplete (${batch.failed} failed). No Top 100 was generated. Diagnostic: ${path}`);
  }

  const boards = buildQualifiedLeaderboards(discovery, batch, { topN: 100 });
  const disqualificationReasons = {};
  let earlyExitsExcluded = 0;
  let ambiguousSameSecondExcluded = 0;
  let postResolutionAcquisitionsExcluded = 0;
  for (const row of batch.results) {
    if (!row.qualification.qualified) {
      const reason = row.qualification.reason ?? "unknown";
      disqualificationReasons[reason] = (disqualificationReasons[reason] ?? 0) + 1;
    }
    earlyExitsExcluded += row.summary?.exclusions?.early_exit_excluded ?? 0;
    ambiguousSameSecondExcluded += row.summary?.exclusions?.same_second_as_resolution_ambiguous ?? 0;
    postResolutionAcquisitionsExcluded += row.summary?.exclusions?.post_resolution_acquisition_excluded ?? 0;
  }
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: "Polymarket Data API v2 closed positions, redeemable positions, tokens and resolutions",
    qualification: {
      minimumResolvedMarkets: 20,
      minimumWinRate: 0.9,
      lookbackDays: 30,
      earlyExitsCounted: false,
      settlementIntegrityRequired: true,
    },
    auditSummary: {
      disqualifiedWallets: batch.results.length - boards.qualifiedWalletCount,
      disqualificationReasons,
      earlyExitsExcluded,
      ambiguousSameSecondExcluded,
      postResolutionAcquisitionsExcluded,
    },
    validation: {
      passed: true,
      allWalletAuditsComplete: true,
      discoveredWallets: discovery.candidates.length,
      auditedWallets: batch.completed,
      failedWalletAudits: 0,
      qualifiedWallets: boards.qualifiedWalletCount,
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
  process.stdout.write(`Qualification complete. ${boards.qualifiedWalletCount} wallets passed; weekly Top ${boards.weekly.length}; monthly Top ${boards.monthly.length}.\n`);
  process.stdout.write(`Output: ${target}\n`);
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualification().catch((error) => {
    process.stderr.write(`Qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
