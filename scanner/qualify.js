import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { auditCandidatesBatch } from "./batch-audit.js";
import { buildQualifiedLeaderboards } from "./qualification-runner.js";

function createPacedFetch({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  intervalMs = Number(process.env.SCANNER_API_INTERVAL_MS ?? 60),
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

export async function runQualification({
  discoveryPath = "data/discovery.json",
  outputPath = "site/data/qualification.json",
  concurrency = Number(process.env.SCANNER_CONCURRENCY ?? 16),
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const discovery = JSON.parse(await readFile(resolve(discoveryPath), "utf8"));
  if (discovery.schemaVersion !== 1 || discovery.validation?.passed !== true ||
      !Array.isArray(discovery.candidates) ||
      discovery.validation.candidateCount !== discovery.candidates.length) {
    throw new Error("Candidate discovery input failed validation");
  }

  const auditLimit = Number(process.env.SCANNER_AUDIT_LIMIT ?? 1000);
  if (!Number.isInteger(auditLimit) || auditLimit < 1) throw new Error("SCANNER_AUDIT_LIMIT must be a positive integer");
  const auditCandidates = discovery.candidates.slice(0, auditLimit);
  const diagnosticLimit = Number(process.env.SCANNER_DIAGNOSTIC_LIMIT ?? 0);
  if (!Number.isInteger(diagnosticLimit) || diagnosticLimit < 0) throw new Error("SCANNER_DIAGNOSTIC_LIMIT must be a non-negative integer");
  const candidates = (diagnosticLimit > 0 ? auditCandidates.slice(0, diagnosticLimit) : auditCandidates);
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  process.stdout.write(`Auditing ${candidates.length} candidate wallets${diagnosticLimit > 0 ? ` (diagnostic sample of ${discovery.candidates.length})` : ""}; 30-day settlement window; concurrency ${concurrency}.\n`);
  // Bound memory: raw histories from all 1,000 wallets must not coexist in
  // memory. The previous all-at-once batch exceeded the runner's 6 GB heap.
  const chunkSize = Number(process.env.SCANNER_AUDIT_CHUNK_SIZE ?? 50);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) {
    throw new Error("SCANNER_AUDIT_CHUNK_SIZE must be 1..100");
  }
  const combined = {
    results: [], complete: true, allAuditsComplete: true, completed: 0, failed: 0,
    errorCounts: {}, errorSamples: [], sharedTokenFacts: 0, sharedResolutionFacts: 0,
    uniqueTokens: 0, uniqueMarkets: 0,
  };
  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    const chunk = candidates.slice(offset, offset + chunkSize);
    const part = await auditCandidatesBatch(chunk, {
      client, concurrency, nowSeconds, lookbackDays: 30,
      minimumResolvedMarkets: 10, minimumWinRate: 0.9,
      onProgress: ({ stage = "position_snapshots", completed, total, failed, commonErrors = [], errorSamples = [] }) => {
        process.stdout.write(`Chunk ${Math.floor(offset / chunkSize) + 1}: ${stage} ${completed}/${total}; overall wallet audits ${combined.completed}/${candidates.length}; failures: ${combined.failed + failed}.\\n`);
        for (const item of commonErrors) process.stdout.write(`  Failure ${item.count}x: ${item.error}\\n`);
        for (const sample of errorSamples) process.stdout.write(`  Sample wallet ${sample.wallet}: [${sample.stage}] ${sample.message}\\n`);
      },
    });
    combined.results.push(...part.results);
    combined.completed += part.completed;
    combined.failed += part.failed;
    combined.complete = combined.complete && part.complete;
    combined.allAuditsComplete = combined.allAuditsComplete && part.allAuditsComplete;
    for (const [key, count] of Object.entries(part.errorCounts)) combined.errorCounts[key] = (combined.errorCounts[key] ?? 0) + count;
    for (const sample of part.errorSamples) if (combined.errorSamples.length < 12) combined.errorSamples.push(sample);
    combined.sharedTokenFacts += part.sharedTokenFacts;
    combined.sharedResolutionFacts += part.sharedResolutionFacts;
    combined.uniqueTokens += part.uniqueTokens;
    combined.uniqueMarkets += part.uniqueMarkets;
    if (global.gc) global.gc();
  }
  const batch = combined;

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
      allAuditsComplete: batch.allAuditsComplete,
      errorCounts: batch.errorCounts,
      errorSamples: batch.errorSamples,
      sharedTokenFacts: batch.sharedTokenFacts,
      sharedResolutionFacts: batch.sharedResolutionFacts,
      uniqueTokens: batch.uniqueTokens,
      uniqueMarkets: batch.uniqueMarkets,
      results: batch.results,
    };
    const path = await writeJsonAtomic("data/qualification-diagnostic.json", diagnostic);
    process.stdout.write(`Diagnostic sample finished: ${batch.completed}/${candidates.length}; failures ${batch.failed}. Output: ${path}\n`);
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

  const qualificationDiscovery = { ...discovery, candidates };
  const boards = buildQualifiedLeaderboards(qualificationDiscovery, batch, { topN: 100 });
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
      minimumResolvedMarkets: 10,
      minimumWinRate: 0.9,
      maximumEarlyExitRate: null,
      lookbackDays: 30,
      earlyExitsCounted: false,
      settlementIntegrityRequired: true,
    },
    auditSummary: {
      disqualifiedWallets: batch.results.length - boards.qualifiedWalletCount,
      incompleteWalletAudits: batch.failed,
      incompleteAuditErrors: batch.errorCounts,
      disqualificationReasons,
      earlyExitsExcluded,
      ambiguousSameSecondExcluded,
      postResolutionAcquisitionsExcluded,
    },
    validation: {
      passed: true,
      allWalletAuditsComplete: batch.allAuditsComplete,
      discoveredWallets: discovery.candidates.length,
      auditedWallets: batch.completed,
      fullyAuditedWallets: batch.completed - batch.failed,
      failedWalletAudits: batch.failed,
      incompleteAuditErrors: batch.errorCounts,
      qualifiedWallets: boards.qualifiedWalletCount,
    },
    qualifiedWallets: batch.results
      .filter((row) => row.complete === true && row.qualification?.qualified)
      .map((row) => ({
        wallet: row.wallet,
        username: row.username,
        summary: row.summary ? {
          wins: row.summary.wins,
          losses: row.summary.losses,
          resolvedMarkets: row.summary.resolvedMarkets,
          winRate: row.summary.winRate,
          integrityPassed: row.summary.integrityPassed,
          earlyExitCount: row.summary.exclusions?.early_exit_excluded ?? 0,
        } : null,
      })),
    weekly: boards.weekly,
    monthly: boards.monthly,
  };
  const target = await writeJsonAtomic(outputPath, payload);
  await writeJsonAtomic("site/data/qualified-week.json", {
    schemaVersion: 1, generatedAt, period: "week",
    qualification: payload.qualification,
    validation: { passed: true, complete: batch.complete, allAuditsComplete: batch.allAuditsComplete },
    count: boards.weekly.length, traders: boards.weekly,
  });
  await writeJsonAtomic("site/data/qualified-month.json", {
    schemaVersion: 1, generatedAt, period: "month",
    qualification: payload.qualification,
    validation: { passed: true, complete: batch.complete, allAuditsComplete: batch.allAuditsComplete },
    count: boards.monthly.length, traders: boards.monthly,
  });
  await writeJsonAtomic("site/data/qualification-status.json", {
    schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
    validation: { passed: true, complete: batch.complete, allAuditsComplete: batch.allAuditsComplete },
    state: "success",
    discoveredWallets: discovery.candidates.length,
    auditedWallets: batch.completed,
    fullyAuditedWallets: batch.completed - batch.failed,
    failedWalletAudits: batch.failed,
    qualifiedWallets: boards.qualifiedWalletCount,
    earlyExitsExcluded,
    weeklyCount: boards.weekly.length,
    monthlyCount: boards.monthly.length,
    qualification: payload.qualification,
  });
  process.stdout.write(`Qualification complete. ${boards.qualifiedWalletCount} wallets passed; ${batch.failed} incomplete wallet audits excluded; monthly Top ${boards.monthly.length}.\\n`);
  process.stdout.write(`Output: ${target}\n`);
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQualification().catch((error) => {
    process.stderr.write(`Qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
