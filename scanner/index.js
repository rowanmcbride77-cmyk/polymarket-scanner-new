import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverLeaderboardCandidates } from "./leaderboard.js";

async function main() {
  const result = await discoverLeaderboardCandidates({
    limit: 1000,
    maxPages: 100,
  });
  if (!result.complete) throw new Error("Candidate discovery was incomplete; refusing output");

  const outputPath = resolve(process.env.SCANNER_OUTPUT ?? "data/discovery.json");
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "Polymarket Data API v2 /leaderboard",
    scope: {
      periods: ["week", "month"],
      categories: ["sports", "esports", "crypto"],
      sortBy: "PNL",
      maxRowsPerPartition: 1000,
    },
    validation: {
      passed: true,
      allPartitionsComplete: true,
      candidateCount: result.candidates.length,
      partitionCount: result.partitions.length,
    },
    partitions: result.partitions,
    candidates: result.candidates,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stdout.write(`Candidate discovery complete: ${result.candidates.length} unique wallets across ${result.partitions.length} complete partitions.\n`);
  process.stdout.write(`Output: ${outputPath}\n`);
  process.stdout.write("This is a discovery dataset only; it is not a qualified Top 100 and is not published to the dashboard.\n");
}

main().catch((error) => {
  process.stderr.write(`Discovery failed: ${error.message}\n`);
  process.exitCode = 1;
});
