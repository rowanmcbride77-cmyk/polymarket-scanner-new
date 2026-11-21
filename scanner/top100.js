import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";

const WALLET_RE = /^0x[a-f0-9]{40}$/i;

function walletOf(row) {
  return String(row.proxy_wallet ?? row.proxyWallet ?? row.user_id ?? row.userId ?? "").toLowerCase();
}
function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchTop100(period, { client = createDataApiClient() } = {}) {
  if (!["week", "month"].includes(period)) throw new TypeError("period must be week or month");
  const rows = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 2 && rows.length < 100; pageNumber += 1) {
    const page = await client.getPage("/v2/leaderboard", {
      category: "overall", time_period: period, sort_by: "PNL", limit: 50,
    }, cursor);
    rows.push(...page.rows);
    if (rows.length >= 100 || !page.hasMore) break;
    if (!page.nextCursor) throw new Error(`Leaderboard ${period} page reports more data without a cursor`);
    cursor = page.nextCursor;
  }

  const seen = new Set();
  const leaders = rows.map((row) => {
    const wallet = walletOf(row);
    const pnl = numeric(row.pnl ?? row.profit);
    const volume = numeric(row.volume_usdc ?? row.volumeUsd ?? row.volume_usd ?? row.volume);
    return {
      wallet,
      username: row.user_name ?? row.userName ?? row.username ?? row.name ?? "Polymarket Trader",
      leaderboardRank: numeric(row.rank),
      pnl,
      volume,
      period,
    };
  }).filter((row) => {
    if (!WALLET_RE.test(row.wallet) || row.pnl === null || seen.has(row.wallet)) return false;
    seen.add(row.wallet);
    return true;
  }).sort((a, b) => b.pnl - a.pnl).slice(0, 100)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  if (leaders.length !== 100) {
    throw new Error(`Polymarket returned only ${leaders.length} valid ${period} leaderboard entries; refusing to publish a partial Top 100`);
  }
  return leaders;
}

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function runTop100() {
  const startedAt = new Date().toISOString();
  const [week, month] = await Promise.all([fetchTop100("week"), fetchTop100("month")]);
  const generatedAt = new Date().toISOString();
  for (const [period, traders] of [["week", week], ["month", month]]) {
    await writeJson(`site/data/${period}.json`, {
      schemaVersion: 1, generatedAt, period,
      source: "Polymarket public Data API v2 leaderboard",
      ranking: "PNL", count: traders.length,
      validation: { passed: true, complete: true, uniqueWallets: true },
      traders,
    });
  }
  await writeJson("site/data/status.json", {
    schemaVersion: 1, state: "success", startedAt, generatedAt,
    completedAt: generatedAt, source: "Polymarket public Data API v2 leaderboard",
    validation: { passed: true }, weeklyCount: week.length, monthlyCount: month.length,
    message: "Weekly and monthly public Top 100 leaderboards refreshed successfully.",
  });
  await writeJson("site/data/consensus.json", {
    schemaVersion: 1, generatedAt, validation: { passed: true },
    signals: [], combos: { validation: { passed: true }, opportunities: [] },
    message: "Consensus scanning is not part of this Top 100 refresh.",
  });
  console.log(`Published-ready Top 100: week=${week.length}, month=${month.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTop100().catch((error) => {
    process.stderr.write(`Top 100 refresh failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
