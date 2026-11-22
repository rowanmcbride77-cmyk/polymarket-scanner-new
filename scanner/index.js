import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverLeaderboardCandidates } from "./leaderboard.js";

const DEFAULT_MAX_CANDIDATES = 20000;

function candidateLimitFromEnv() {
  const value = Number(process.env.SCANNER_MAX_CANDIDATES ?? DEFAULT_MAX_CANDIDATES);
  if (!Number.isInteger(value) || value < 100 || value > 20000) {
    throw new RangeError("SCANNER_MAX_CANDIDATES must be an integer from 100 to 20000");
  }
  return value;
}

export function buildDiscoveryPayload(result, generatedAt = new Date().toISOString()) {
  if (!result || result.complete !== true || !Array.isArray(result.candidates) ||
      !Array.isArray(result.partitions) || !result.partitions.every((p) => p.complete === true)) {
    throw new Error("Candidate discovery was incomplete; refusing output");
  }
  const maxCandidates = result.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const candidates = result.candidates;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("Candidate discovery has an invalid wallet cap");
  }
  if (candidates.length === 0) {
    throw new Error("Candidate discovery returned no wallets; refusing output");
  }
  if (candidates.length > maxCandidates) {
    throw new Error(`Candidate discovery exceeded its ${maxCandidates}-wallet cap (${candidates.length} rows)`);
  }
  const wallets = candidates.map((candidate) => String(candidate?.wallet ?? "").trim().toLowerCase());
  if (wallets.some((wallet) => !wallet)) {
    throw new Error("Candidate discovery contains a missing wallet");
  }
  if (new Set(wallets).size !== wallets.length) {
    throw new Error("Candidate discovery contains duplicate wallets; refusing output");
  }
  return {
    schemaVersion: 1,
    generatedAt,
    source: "Polymarket Data API v2 /leaderboard",
    scope: {
      periods: ["week", "month"],
      categories: ["sports", "esports", "crypto", "overall"],
      sortBy: "PNL",
      pageSize: 1000,
      maxCandidates,
      maxPagesPerPartition: 20,
    },
    validation: {
      passed: true,
      allPageRequestsComplete: true,
      sourceExhausted: result.sourceExhausted === true,
      candidateCapReached: result.candidateCapReached === true,
      maxCandidates,
      truncatedPartitions: result.partitions.filter((p) => p.truncated).length,
      candidateCount: result.candidates.length,
      partitionCount: result.partitions.length,
    },
    partitions: result.partitions,
    candidates,
  };
}

export async function runDiscovery({ outputPath = "data/discovery.json" } = {}) {
  const maxCandidates = candidateLimitFromEnv();
  const result = await discoverLeaderboardCandidates({
    categories: ["sports", "esports", "crypto", "overall"], periods: ["week", "month"],
    limit: 1000, maxCandidates, maxPagesPerPartition: 20,
  });
  const payload = buildDiscoveryPayload(result);
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return { path: target, payload };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDiscovery().then(({ path, payload }) => {
    process.stdout.write(`Candidate discovery complete: ${payload.candidates.length} unique wallets across ${payload.partitions.length} bounded leaderboard partitions; source exhausted: ${payload.validation.sourceExhausted}.\n`);
    process.stdout.write(`Output: ${path}\n`);
    process.stdout.write("Discovery only: this is not a qualified Top 100 and is not published to the dashboard.\n");
  }).catch((error) => {
    process.stderr.write(`Discovery failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
