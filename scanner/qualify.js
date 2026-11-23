import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";
import { auditCandidatesBatch } from "./batch-audit.js";
import { buildQualifiedLeaderboards } from "./qualification-runner.js";

/**
 * Every saved row is a terminal wallet-audit result, even when an individual
 * audit is incomplete. Resume after the saved prefix instead of rewinding to
 * the first failed wallet and discarding all later completed work.
 */
export function checkpointResumeOffset(checkpoint) {
  return Array.isArray(checkpoint?.results) ? checkpoint.results.length : 0;
}

/**
 * A batch is publishable only after every candidate has a terminal result.
 * Individual incomplete audits are excluded by buildQualifiedLeaderboards.
 */
export function hasTerminalAuditResults(batch, candidateCount) {
  return Number.isInteger(candidateCount) && candidateCount >= 0 &&
    batch?.complete === true &&
    Array.isArray(batch.results) &&
    batch.results.length === candidateCount;
}

export function incompleteCheckpointIndexesForExpandedHistory(checkpoint, currentMaxPages = 10) {
  const previousMaxPages = Number(checkpoint?.positionMaxPages ?? 10);
  if (!Number.isInteger(currentMaxPages) || currentMaxPages < 1 ||
      currentMaxPages <= previousMaxPages || !Array.isArray(checkpoint?.results)) return [];
  return checkpoint.results
    .map((row, index) => row?.complete === true ? -1 : index)
    .filter((index) => index >= 0);
}

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

/**
 * Checkpoints only need settlement aggregates used to rank and publish traders.
 * Persisting every per-market result for every wallet inflated the committed
 * checkpoint beyond 50 MB and made each subsequent checkpoint slower.
 */
function compactCheckpointResult(row) {
  if (!row || typeof row !== "object") return row;
  const summary = row.summary;
  return {
    wallet: row.wallet,
    username: row.username,
    complete: row.complete === true,
    qualification: row.qualification ?? { qualified: false, reason: "missing_qualification_result" },
    ...(row.auditStage ? { auditStage: row.auditStage } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(summary ? {
      summary: {
        wins: summary.wins,
        losses: summary.losses,
        resolvedMarkets: summary.resolvedMarkets,
        winRate: summary.winRate,
        exclusions: summary.exclusions ?? {},
        integrityPassed: summary.integrityPassed === true,
        integrityFailures: summary.integrityFailures ?? [],
        complete: summary.complete === true,
        windowStartSeconds: summary.windowStartSeconds,
      },
    } : {}),
  };
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

  let effectiveNowSeconds = nowSeconds;
  const auditLimit = Number(process.env.SCANNER_AUDIT_LIMIT ?? discovery.candidates.length);
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
  const chunkSize = Number(process.env.SCANNER_AUDIT_CHUNK_SIZE ?? 25);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) {
    throw new Error("SCANNER_AUDIT_CHUNK_SIZE must be 1..100");
  }
  const runWalletLimit = Number(process.env.SCANNER_RUN_WALLET_LIMIT ?? candidates.length);
  if (!Number.isInteger(runWalletLimit) || runWalletLimit < 1) throw new Error("SCANNER_RUN_WALLET_LIMIT must be positive");
  const tokenFactsCache = new Map();
  const resolutionsCache = new Map();
  const checkpointPath = "data/qualification-progress.json";
  const persistCheckpoints = process.env.SCANNER_PERSIST_CHECKPOINTS === "1" && diagnosticLimit === 0;
  const currentPositionMaxPages = Number(process.env.SCANNER_POSITION_MAX_PAGES ?? 10);
  if (!Number.isInteger(currentPositionMaxPages) || currentPositionMaxPages < 1) {
    throw new Error("SCANNER_POSITION_MAX_PAGES must be a positive integer");
  }
  let checkpoint = null;
  let retryIncompleteIndexes = [];
  if (persistCheckpoints) {
    try {
      const saved = JSON.parse(await readFile(resolve(checkpointPath), "utf8"));
      const savedPrefixMatches = Array.isArray(saved.results) &&
        saved.results.every((row, index) =>
          row?.wallet?.toLowerCase() === candidates[index]?.wallet?.toLowerCase());
      if (saved.schemaVersion === 1 &&
          saved.discoveryGeneratedAt === discovery.generatedAt &&
          saved.candidateCount <= candidates.length &&
          saved.auditLimit <= auditLimit &&
          Array.isArray(saved.results) && saved.results.length === saved.nextOffset &&
          saved.results.length <= candidates.length &&
          savedPrefixMatches &&
          Number.isInteger(saved.nowSeconds)) {
        checkpoint = saved;
        retryIncompleteIndexes = incompleteCheckpointIndexesForExpandedHistory(saved, currentPositionMaxPages);
        effectiveNowSeconds = saved.nowSeconds;
        process.stdout.write(`Resuming settlement qualification at wallet ${saved.nextOffset}/${candidates.length}; reusing ${saved.results.length} saved results.\\n`);
      }
    } catch {}
  }
  const resumeOffset = checkpointResumeOffset(checkpoint);
  const reusableResults = checkpoint?.results ?? [];
  const savedIncompleteAudits = reusableResults.filter(row => row?.complete !== true).length;
  if (savedIncompleteAudits) {
    process.stdout.write(`Reusing ${savedIncompleteAudits} terminal incomplete wallet audits; those wallets remain excluded from qualification.\\n`);
  }
  const combined = {
    results: reusableResults,
    complete: true,
    allAuditsComplete: savedIncompleteAudits === 0,
    completed: reusableResults.length,
    failed: savedIncompleteAudits,
    errorCounts: { ...(checkpoint?.errorCounts ?? {}) },
    errorSamples: [...(checkpoint?.errorSamples ?? [])],
    sharedTokenFacts: 0, sharedResolutionFacts: 0,
    uniqueTokens: 0, uniqueMarkets: 0,
  };
  if (retryIncompleteIndexes.length) {
    process.stdout.write(`Retrying ${retryIncompleteIndexes.length} previously incomplete wallet audits because position history coverage increased to ${currentPositionMaxPages} pages.\\n`);
    for (let retryOffset = 0; retryOffset < retryIncompleteIndexes.length; retryOffset += chunkSize) {
      const indexes = retryIncompleteIndexes.slice(retryOffset, retryOffset + chunkSize);
      const retryCandidates = indexes.map((index) => candidates[index]);
      const part = await auditCandidatesBatch(retryCandidates, {
        client, concurrency, nowSeconds: effectiveNowSeconds, lookbackDays: 30,
        minimumResolvedMarkets: 10, minimumWinRate: 0.9,
        sharedTokenFacts: tokenFactsCache,
        sharedResolutions: resolutionsCache,
        onProgress: (progress) => {
          if (Number.isInteger(progress.pageNumber)) {
            process.stdout.write(`Retry history: ${progress.stage} page ${progress.pageNumber}, ${progress.totalRows} rows for ${progress.wallet}\\n`);
          } else {
            process.stdout.write(`Retry history: ${progress.stage} ${progress.completed}/${progress.total}; failures: ${progress.failed ?? 0}\\n`);
          }
        },
      });
      part.results.forEach((row, index) => {
        combined.results[indexes[index]] = row;
      });
      combined.failed = combined.results.filter((row) => row?.complete !== true).length;
      combined.allAuditsComplete = combined.failed === 0;
      combined.errorCounts = {};
      combined.errorSamples = [];
      for (const row of combined.results.filter((item) => item?.complete !== true)) {
        const key = `${row.auditStage ?? "unknown"}: ${row.error ?? "incomplete audit"}`;
        combined.errorCounts[key] = (combined.errorCounts[key] ?? 0) + 1;
        if (combined.errorSamples.length < 12) {
          combined.errorSamples.push({ wallet: row.wallet, stage: row.auditStage ?? "unknown", message: row.error ?? "incomplete audit" });
        }
      }
      if (global.gc) global.gc();
      if (persistCheckpoints) {
        const saved = {
          schemaVersion: 1,
          discoveryGeneratedAt: discovery.generatedAt,
          candidateCount: candidates.length,
          auditLimit,
          nowSeconds: effectiveNowSeconds,
          positionMaxPages: retryOffset + chunkSize >= retryIncompleteIndexes.length
            ? currentPositionMaxPages
            : Number(checkpoint?.positionMaxPages ?? 10),
          nextOffset: combined.results.length,
          results: combined.results.map(compactCheckpointResult),
          failed: combined.failed,
          errorCounts: combined.errorCounts,
          errorSamples: combined.errorSamples,
          allAuditsComplete: combined.allAuditsComplete,
        };
        await writeJsonAtomic(checkpointPath, saved);
        await writeJsonAtomic("site/data/qualification-status.json", {
          schemaVersion: 1, generatedAt: new Date(effectiveNowSeconds * 1000).toISOString(),
          completedAt: null, validation: { passed: false, complete: false },
          state: "in_progress", discoveredWallets: discovery.candidates.length,
          auditedWallets: combined.completed, fullyAuditedWallets: combined.completed - combined.failed,
          failedWalletAudits: combined.failed, qualifiedWallets: 0,
          message: `Rechecked incomplete audits with expanded history: ${combined.completed}/${candidates.length}; ${combined.failed} remain incomplete.`,
        });
        execFileSync("git", ["add", checkpointPath, "site/data/qualification-status.json"], { stdio: "inherit" });
        execFileSync("git", ["commit", "-m", `Retry incomplete settlement audits at ${currentPositionMaxPages} pages`], { stdio: "inherit" });
        execFileSync("git", ["fetch", "origin", "main"], { stdio: "inherit" });
        execFileSync("git", ["rebase", "-X", "theirs", "origin/main"], { stdio: "inherit" });
        execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
      }
    }
  }
  const runEndOffset = Math.min(candidates.length, combined.completed + runWalletLimit);
  await writeJsonAtomic("site/data/qualification-status.json", {
    schemaVersion: 1, generatedAt: new Date(effectiveNowSeconds * 1000).toISOString(),
    completedAt: null, validation: { passed: false, complete: false },
    state: "in_progress", discoveredWallets: discovery.candidates.length,
    auditedWallets: combined.completed, fullyAuditedWallets: combined.completed - combined.failed,
    failedWalletAudits: combined.failed, qualifiedWallets: 0,
    message: `Auditing all ${candidates.length} discovered wallets in resumable batches.`,
  });
  for (let offset = combined.completed; offset < runEndOffset; offset += chunkSize) {
    const chunk = candidates.slice(offset, Math.min(offset + chunkSize, runEndOffset));
    const part = await auditCandidatesBatch(chunk, {
      client, concurrency, nowSeconds: effectiveNowSeconds, lookbackDays: 30,
      minimumResolvedMarkets: 10, minimumWinRate: 0.9,
      sharedTokenFacts: tokenFactsCache,
      sharedResolutions: resolutionsCache,
      onProgress: (progress) => {
        if (Number.isInteger(progress.pageNumber)) {
          process.stdout.write(`Chunk ${Math.floor(offset / chunkSize) + 1}: ${progress.stage} page ${progress.pageNumber}, ${progress.totalRows} rows for ${progress.wallet}\n`);
          return;
        }
        const { stage = "position_snapshots", completed, total, failed = 0, commonErrors = [], errorSamples = [] } = progress;
        process.stdout.write(`Chunk ${Math.floor(offset / chunkSize) + 1}: ${stage} ${completed}/${total}; overall wallet audits ${combined.completed}/${candidates.length}; failures: ${combined.failed + failed}\n`);
        for (const item of commonErrors) process.stdout.write(`  Failure ${item.count}x: ${item.error}\n`);
        for (const sample of errorSamples) process.stdout.write(`  Sample wallet ${sample.wallet}: [${sample.stage}] ${sample.message}\n`);
      },
    });
    combined.results.push(...part.results);
    combined.completed += part.completed;
    combined.failed += part.failed;
    combined.complete = combined.complete && part.complete;
    combined.allAuditsComplete = combined.allAuditsComplete && part.allAuditsComplete;
    for (const [key, count] of Object.entries(part.errorCounts)) combined.errorCounts[key] = (combined.errorCounts[key] ?? 0) + count;
    for (const sample of part.errorSamples) if (combined.errorSamples.length < 12) combined.errorSamples.push(sample);
    combined.sharedTokenFacts = tokenFactsCache.size;
    combined.sharedResolutionFacts = resolutionsCache.size;
    combined.uniqueTokens += part.uniqueTokens;
    combined.uniqueMarkets += part.uniqueMarkets;
    if (global.gc) global.gc();
    if (persistCheckpoints) {
      const saved = {
        schemaVersion: 1,
        discoveryGeneratedAt: discovery.generatedAt,
        candidateCount: candidates.length,
        auditLimit,
        nowSeconds: effectiveNowSeconds,
        positionMaxPages: currentPositionMaxPages,
        nextOffset: combined.results.length,
        results: combined.results.map(compactCheckpointResult),
        failed: combined.failed,
        errorCounts: combined.errorCounts,
        errorSamples: combined.errorSamples,
        allAuditsComplete: combined.allAuditsComplete,
      };
      await writeJsonAtomic(checkpointPath, saved);
      await writeJsonAtomic("site/data/qualification-status.json", {
        schemaVersion: 1, generatedAt: new Date(effectiveNowSeconds * 1000).toISOString(),
        completedAt: null, validation: { passed: false, complete: false },
        state: "in_progress", discoveredWallets: discovery.candidates.length,
        auditedWallets: combined.completed, fullyAuditedWallets: combined.completed - combined.failed,
        failedWalletAudits: combined.failed, qualifiedWallets: 0,
        message: "Checkpoint saved: " + combined.completed + "/" + candidates.length + " wallet audits attempted.",
      });
      execFileSync("git", ["add", checkpointPath, "site/data/qualification-status.json"], { stdio: "inherit" });
      execFileSync("git", ["commit", "-m", `Checkpoint settlement qualification ${saved.nextOffset}/${saved.candidateCount}`], { stdio: "inherit" });
      // Discovery, deployment, and settlement workflows can all advance main.
      // Rebase this checkpoint on the latest main and prefer this run's newly
      // generated checkpoint when both workflows touched the progress file.
      execFileSync("git", ["fetch", "origin", "main"], { stdio: "inherit" });
      execFileSync("git", ["rebase", "-X", "theirs", "origin/main"], { stdio: "inherit" });
      execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
    }
  }
  const batch = combined;

  const generatedAt = new Date(effectiveNowSeconds * 1000).toISOString();
  if (batch.completed < candidates.length) {
    const status = {
      schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
      validation: { passed: false, complete: false, allAuditsComplete: false },
      state: "partial", discoveredWallets: discovery.candidates.length,
      auditedWallets: batch.completed, fullyAuditedWallets: batch.completed - batch.failed,
      failedWalletAudits: batch.failed, qualifiedWallets: 0,
      message: "Saved " + batch.completed + "/" + candidates.length + " wallet audits. Next scheduled run resumes from checkpoint; no partial leaderboard is published.",
    };
    await writeJsonAtomic("site/data/qualification-status.json", status);
    if (persistCheckpoints) {
      execFileSync("git", ["add", "site/data/qualification-status.json"], { stdio: "inherit" });
      execFileSync("git", ["commit", "-m", "Update settlement audit progress " + batch.completed + "/" + candidates.length], { stdio: "inherit" });
      execFileSync("git", ["fetch", "origin", "main"], { stdio: "inherit" });
      execFileSync("git", ["rebase", "-X", "theirs", "origin/main"], { stdio: "inherit" });
      execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
    }
    process.stdout.write(status.message + "\n");
    return status;
  }
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
  if (!hasTerminalAuditResults(batch, candidates.length)) {
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
    await writeJsonAtomic("site/data/qualification-status.json", {
      schemaVersion: 1, generatedAt, completedAt: new Date().toISOString(),
      validation: { passed: false, complete: false, allAuditsComplete: false },
      state: "incomplete", discoveredWallets: discovery.candidates.length,
      auditedWallets: batch.completed, fullyAuditedWallets: batch.completed - batch.failed,
      failedWalletAudits: batch.failed, qualifiedWallets: 0,
      errorCounts: batch.errorCounts,
      message: `Audit progress saved. ${batch.completed}/${candidates.length} candidates have terminal audit results. No leaderboard published.`,
    });
    throw new Error(`Candidate audit batch incomplete (${batch.completed}/${candidates.length} terminal results). No Top 100 was published. Checkpoint saved. Diagnostic: ${path}`);
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
  if (persistCheckpoints) {
    try { await unlink(resolve(checkpointPath)); } catch {}
  }
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
