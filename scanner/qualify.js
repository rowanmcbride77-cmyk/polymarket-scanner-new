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
 * A partial checkpoint is reusable for a larger audit universe when it was
 * created for that same full candidate limit. Requiring results.length to
 * equal candidateCount here defeats batching: the first 1K of a 20K audit
 * must be accepted so the next run can continue with the remaining 19K.
 */
export function isReusableCheckpoint(checkpoint, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1) return false;
  const results = checkpoint?.results;
  const wallets = Array.isArray(results)
    ? results.map((row) => String(row?.wallet ?? "").toLowerCase())
    : [];
  const savedAuditLimit = Number(checkpoint?.auditLimit ?? checkpoint?.candidateCount);
  return checkpoint?.schemaVersion === 3 &&
    Number.isInteger(savedAuditLimit) &&
    savedAuditLimit >= candidateCount &&
    checkpoint?.candidateCount === savedAuditLimit &&
    Array.isArray(results) &&
    results.length <= candidateCount &&
    results.length === checkpoint?.nextOffset &&
    wallets.every((wallet) => /^0x[a-f0-9]{40}$/.test(wallet)) &&
    new Set(wallets).size === wallets.length &&
    Number.isInteger(checkpoint?.nowSeconds);
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

export function createPacedFetch({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  intervalMs = Number(process.env.SCANNER_API_INTERVAL_MS ?? 55),
  now = () => Date.now(),
  retryAfterSafetyMs = 250,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new RangeError("intervalMs must be non-negative");
  if (typeof now !== "function" || !Number.isFinite(retryAfterSafetyMs) || retryAfterSafetyMs < 0) {
    throw new TypeError("Invalid paced-fetch clock or retry safety margin");
  }

  // The Data API returns 429/503 plus Retry-After when a heavy query cannot
  // be served. Pause the whole endpoint lane, not just the one request being
  // retried; otherwise the other in-flight workers continue to overload it.
  const nextStartAtByRoute = new Map();
  const blockedUntilByRoute = new Map();
  const retryAfterMs = (response) => {
    const header = response.headers?.get?.("retry-after");
    if (header !== null && header !== undefined) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now());
    }
    return Math.max(1000, intervalMs * 10);
  };

  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(input.url ?? input);
    const route = `${url.origin}${url.pathname}`;

    while (true) {
      const current = now();
      const startAt = Math.max(
        current,
        nextStartAtByRoute.get(route) ?? 0,
        blockedUntilByRoute.get(route) ?? 0,
      );
      nextStartAtByRoute.set(route, startAt + intervalMs);
      if (startAt > current) await sleep(startAt - current);

      // A 429 may have arrived while this request was sleeping. Re-check the
      // shared block before issuing another request.
      const afterSleep = now();
      const blockedUntil = blockedUntilByRoute.get(route) ?? 0;
      if (afterSleep < blockedUntil) continue;

      const response = await fetchImpl(input, init);
      if (response.status === 429 || response.status === 503) {
        const until = now() + retryAfterMs(response) + retryAfterSafetyMs;
        blockedUntilByRoute.set(route, Math.max(blockedUntilByRoute.get(route) ?? 0, until));
        nextStartAtByRoute.set(route, Math.max(nextStartAtByRoute.get(route) ?? 0, until));
      }
      return response;
    }
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
        earlyExitsCounted: summary.earlyExitsCounted ?? 0,
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
  // Start with a fast 2K candidate screen by default; raise SCANNER_AUDIT_LIMIT
  // to the full discovery count only when a full-universe run is intended.
  const auditLimit = Number(process.env.SCANNER_AUDIT_LIMIT ?? Math.min(2000, discovery.candidates.length));
  if (!Number.isInteger(auditLimit) || auditLimit < 1 || auditLimit > discovery.candidates.length) {
    throw new Error(`SCANNER_AUDIT_LIMIT must be between 1 and ${discovery.candidates.length}`);
  }
  const auditCandidates = discovery.candidates.slice(0, auditLimit);
  const diagnosticLimit = Number(process.env.SCANNER_DIAGNOSTIC_LIMIT ?? 0);
  if (!Number.isInteger(diagnosticLimit) || diagnosticLimit < 0) throw new Error("SCANNER_DIAGNOSTIC_LIMIT must be a non-negative integer");
  const candidates = (diagnosticLimit > 0 ? auditCandidates.slice(0, diagnosticLimit) : auditCandidates);
  const pacedFetch = createPacedFetch();
  const client = createDataApiClient({ fetchImpl: pacedFetch });
  process.stdout.write(`Auditing ${candidates.length} candidate wallets${diagnosticLimit > 0 ? ` (diagnostic sample of ${discovery.candidates.length})` : ""}; 60-day closed-market window; concurrency ${concurrency}.\n`);
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
  const checkpointPath = "data/qualification-progress-60d.json";
  const persistCheckpoints = process.env.SCANNER_PERSIST_CHECKPOINTS === "1" && diagnosticLimit === 0;
  const currentPositionMaxPages = Number(process.env.SCANNER_POSITION_MAX_PAGES ?? 10);
  if (!Number.isInteger(currentPositionMaxPages) || currentPositionMaxPages < 1) {
    throw new Error("SCANNER_POSITION_MAX_PAGES must be a positive integer");
  }
  const candidateByWallet = new Map(candidates.map((candidate) => [candidate.wallet.toLowerCase(), candidate]));
  let checkpoint = null;
  let retryIncompleteIndexes = [];
  if (persistCheckpoints) {
    try {
      const saved = JSON.parse(await readFile(resolve(checkpointPath), "utf8"));
      if (isReusableCheckpoint(saved, candidates.length)) {
        checkpoint = saved;
        // Do not block the 20K scan by replaying failed wallets before new work.\n        // Incomplete audits remain safely excluded from ranking; retries are opt-in\n        // after the full discovery set has received a terminal audit result.\n        retryIncompleteIndexes = process.env.SCANNER_RETRY_INCOMPLETE === "1"\n          ? incompleteCheckpointIndexesForExpandedHistory(saved, currentPositionMaxPages)\n          : [];
        effectiveNowSeconds = saved.nowSeconds;
        process.stdout.write(`Resuming settlement qualification with ${saved.results.length} saved wallet audits; current discovery has ${candidates.length} candidates.\\n`);
      }
    } catch {}
  }

  // Reuse audited wallets by address, not by their old leaderboard position.
  // The discovery snapshot can refresh/reorder while a 20K audit is checkpointing.
  const resultsByWallet = new Map();
  for (const row of checkpoint?.results ?? []) {
    const wallet = String(row?.wallet ?? "").toLowerCase();
    if (candidateByWallet.has(wallet)) resultsByWallet.set(wallet, row);
  }
  const combined = {
    results: [],
    complete: false,
    allAuditsComplete: true,
    completed: 0,
    failed: 0,
    errorCounts: {},
    errorSamples: [],
    sharedTokenFacts: 0, sharedResolutionFacts: 0,
    uniqueTokens: 0, uniqueMarkets: 0,
  };
  const refreshCombined = () => {
    combined.results = candidates
      .map((candidate) => resultsByWallet.get(candidate.wallet.toLowerCase()))
      .filter(Boolean);
    combined.completed = resultsByWallet.size;
    combined.failed = combined.results.filter((row) => row?.complete !== true).length;
    combined.complete = combined.completed === candidates.length;
    combined.allAuditsComplete = combined.failed === 0;
    combined.errorCounts = {};
    combined.errorSamples = [];
    for (const row of combined.results.filter((item) => item?.complete !== true)) {
      const key = `${row.auditStage ?? "unknown"}: ${row.error ?? "incomplete audit"}`;
      combined.errorCounts[key] = (combined.errorCounts[key] ?? 0) + 1;
      if (combined.errorSamples.length < 12) {
        combined.errorSamples.push({
          wallet: row.wallet,
          stage: row.auditStage ?? "unknown",
          message: row.error ?? "incomplete audit",
        });
      }
    }
  };
  refreshCombined();

  const retryIncompleteWallets = retryIncompleteIndexes
    .map((index) => String(checkpoint?.results?.[index]?.wallet ?? "").toLowerCase())
    .filter((wallet) => candidateByWallet.has(wallet) &&
      resultsByWallet.get(wallet)?.complete !== true);
  if (retryIncompleteWallets.length) {
    process.stdout.write(`Retrying ${retryIncompleteWallets.length} previously incomplete wallet audits with expanded ${currentPositionMaxPages}-page history coverage.\\n`);
    for (let retryOffset = 0; retryOffset < retryIncompleteWallets.length; retryOffset += chunkSize) {
      const wallets = retryIncompleteWallets.slice(retryOffset, retryOffset + chunkSize);
      const retryCandidates = wallets.map((wallet) => candidateByWallet.get(wallet));
      const part = await auditCandidatesBatch(retryCandidates, {
        client, concurrency, nowSeconds: effectiveNowSeconds, lookbackDays: 60,
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
      for (const row of part.results) resultsByWallet.set(row.wallet.toLowerCase(), row);
      refreshCombined();
      if (global.gc) global.gc();
      if (persistCheckpoints) {
        const saved = {
          schemaVersion: 3,
          discoveryGeneratedAt: discovery.generatedAt,
          candidateCount: candidates.length,
          auditLimit,
          nowSeconds: effectiveNowSeconds,
          positionMaxPages: retryOffset + chunkSize >= retryIncompleteWallets.length
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
          state: "in_progress", discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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

  const pendingCandidates = candidates.filter((candidate) =>
    !resultsByWallet.has(candidate.wallet.toLowerCase()));
  const runCandidates = pendingCandidates.slice(0, runWalletLimit);
  await writeJsonAtomic("site/data/qualification-status.json", {
    schemaVersion: 1, generatedAt: new Date(effectiveNowSeconds * 1000).toISOString(),
    completedAt: null, validation: { passed: false, complete: false },
    state: "in_progress", discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
    auditedWallets: combined.completed, fullyAuditedWallets: combined.completed - combined.failed,
    failedWalletAudits: combined.failed, qualifiedWallets: 0,
    message: `Auditing ${runCandidates.length} additional wallets; ${combined.completed}/${candidates.length} current candidates already have saved audit results.`,
  });
  for (let offset = 0; offset < runCandidates.length; offset += chunkSize) {
    const chunk = runCandidates.slice(offset, offset + chunkSize);
    const part = await auditCandidatesBatch(chunk, {
      client, concurrency, nowSeconds: effectiveNowSeconds, lookbackDays: 60,
      minimumResolvedMarkets: 10, minimumWinRate: 0.9,
      sharedTokenFacts: tokenFactsCache,
      sharedResolutions: resolutionsCache,
      onProgress: (progress) => {
        if (Number.isInteger(progress.pageNumber)) {
          process.stdout.write(`Chunk ${Math.floor(offset / chunkSize) + 1}: ${progress.stage} page ${progress.pageNumber}, ${progress.totalRows} rows for ${progress.wallet}\\n`);
          return;
        }
        const { stage = "position_snapshots", completed, total, failed = 0, commonErrors = [], errorSamples = [] } = progress;
        process.stdout.write(`Chunk ${Math.floor(offset / chunkSize) + 1}: ${stage} ${completed}/${total}; overall wallet audits ${combined.completed}/${candidates.length}; failures: ${combined.failed + failed}\\n`);
        for (const item of commonErrors) process.stdout.write(`  Failure ${item.count}x: ${item.error}\\n`);
        for (const sample of errorSamples) process.stdout.write(`  Sample wallet ${sample.wallet}: [${sample.stage}] ${sample.message}\\n`);
      },
    });
    for (const row of part.results) resultsByWallet.set(row.wallet.toLowerCase(), row);
    refreshCombined();
    combined.sharedTokenFacts = tokenFactsCache.size;
    combined.sharedResolutionFacts = resolutionsCache.size;
    combined.uniqueTokens += part.uniqueTokens;
    combined.uniqueMarkets += part.uniqueMarkets;
    if (global.gc) global.gc();
    if (persistCheckpoints) {
      const saved = {
        schemaVersion: 3,
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
        state: "in_progress", discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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
      state: "partial", discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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
      discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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
        discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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
      state: "incomplete", discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
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
  for (const row of batch.results) {
    if (!row.qualification.qualified) {
      const reason = row.qualification.reason ?? "unknown";
      disqualificationReasons[reason] = (disqualificationReasons[reason] ?? 0) + 1;
    }
  }
  const payload = {
    schemaVersion: 1,
    generatedAt,
    auditUniverse: {
      auditedCandidateCount: candidates.length,
      discoveredCandidateCount: discovery.candidates.length,
      complete: candidates.length === discovery.candidates.length,
    },
    source: "Polymarket Data API v2 closed positions, redeemable positions, tokens and resolutions",
    qualification: {
      minimumResolvedMarkets: 10,
      minimumWinRate: 0.9,
      maximumEarlyExitRate: null,
      lookbackDays: 60,
      earlyExitsCounted: true,
      settlementIntegrityRequired: true,
    },
    auditSummary: {
      disqualifiedWallets: batch.results.length - boards.qualifiedWalletCount,
      incompleteWalletAudits: batch.failed,
      incompleteAuditErrors: batch.errorCounts,
      disqualificationReasons,
      earlyExitsIncluded: true,
    },
    validation: {
      passed: true,
      allWalletAuditsComplete: batch.allAuditsComplete,
      discoveredWallets: candidates.length,
      sourceCandidateCount: discovery.candidates.length,
      auditUniverseComplete: candidates.length === discovery.candidates.length,
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
    discoveredWallets: candidates.length,
       sourceCandidateCount: discovery.candidates.length,
       auditUniverseComplete: candidates.length === discovery.candidates.length,
    auditedWallets: batch.completed,
    fullyAuditedWallets: batch.completed - batch.failed,
    failedWalletAudits: batch.failed,
    qualifiedWallets: boards.qualifiedWalletCount,
    earlyExitsIncluded: true,
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
