import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverLeaderboardCandidates } from "./leaderboard.js";

export function buildDiscoveryPayload(result, generatedAt = new Date().toISOString()) {
  if (!result || result.complete !== true || !Array.isArray(result.candidates) ||
      !Array.isArray(result.partitions) || !result.partitions.every((p) => p.complete === true)) {
    throw new Error("Candidate discovery was incomplete; refusing output");
  }
  return {
    schemaVersion: 1,
    generatedAt,
    source: "Polymarket Data API v2 /leaderboard",
    scope: {
      periods: ["month"],
      categories: ["overall"],
      sortBy: "PNL",
      pageSize: 1000,
      maxCandidates: 20000,
      maxPagesPerPartition: 20,
    },
    validation: {
      passed: true,
      allPageRequestsComplete: true,
      sourceExhausted: result.sourceExhausted === true,
      candidateCapReached: result.candidateCapReached === true,
      maxCandidates: result.maxCandidates,
      truncatedPartitions: result.partitions.filter((p) => p.truncated).length,
      candidateCount: result.candidates.length,
      partitionCount: result.partitions.length,
    },
    partitions: result.partitions,
    candidates: result.candidates,
  };
}

export async function runDiscovery({ outputPath = "data/discovery.json" } = {}) {
  const result = await discoverLeaderboardCandidates({
    categories: ["overall"], periods: ["month"],
    limit: 1000, maxCandidates: 20000, maxPagesPerPartition: 20,
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
