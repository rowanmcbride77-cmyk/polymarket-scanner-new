import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataApiClient } from "./data-api.js";

const WALLET_RE = /^0x[a-f0-9]{40}$/i;

export async function fetchTop1000(period, { client = createDataApiClient() } = {}) {
  if (!["week", "month"].includes(period)) throw new TypeError("period must be week or month");
  const rows = [];
  let cursor;
  const seenCursors = new Set();
  for (let pageNumber = 0; pageNumber < 20 && rows.length < 1000; pageNumber += 1) {
    const page = await client.getPage("/v2/leaderboard", {
      category: "overall", time_period: period, sort_by: "PNL", limit: 1000,
    }, cursor);
    rows.push(...page.rows);
    if (!page.hasMore) break;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error(`Leaderboard ${period} pagination is incomplete or repeated a cursor`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  const unique = new Map();
  for (const row of rows) {
    const wallet = String(row.user_id ?? row.proxy_wallet ?? row.proxyWallet ?? "").toLowerCase();
    const pnl = Number(row.pnl);
    if (!WALLET_RE.test(wallet) || !Number.isFinite(pnl)) continue;
    if (!unique.has(wallet)) unique.set(wallet, {
      wallet, username: row.user_name ?? row.username ?? "Polymarket Trader",
      verified: row.verified === true,
      appearances: [],
    });
    unique.get(wallet).appearances.push({
      category: "overall", timePeriod: period,
      rank: Number.isInteger(row.rank) && row.rank > 0 ? row.rank : unique.size,
      pnl, volumeShares: Number(row.volume ?? 0),
    });
  }
  const traders = [...unique.values()].sort((a, b) =>
    a.appearances[0].rank - b.appearances[0].rank).slice(0, 1000);
  if (traders.length !== 1000) {
    throw new Error(`Polymarket returned only ${traders.length} valid unique ${period} leaderboard wallets; refusing to audit fewer than 1,000`);
  }
  return traders;
}

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function runTop1000() {
  const startedAt = new Date().toISOString();
  const [weekly, monthly] = await Promise.all([fetchTop1000("week"), fetchTop1000("month")]);
  const byWallet = new Map();
  for (const trader of [...weekly, ...monthly]) {
    const current = byWallet.get(trader.wallet) ?? {
      wallet: trader.wallet, username: trader.username, verified: trader.verified, appearances: [],
    };
    current.appearances.push(...trader.appearances);
    byWallet.set(trader.wallet, current);
  }
  const candidates = [...byWallet.values()].map((row) => {
    const ranks = row.appearances.map((a) => a.rank);
    return { ...row, bestRank: Math.min(...ranks), averageRank: ranks.reduce((a,b) => a+b,0) / ranks.length };
  }).sort((a,b) => a.bestRank - b.bestRank || a.averageRank - b.averageRank)
    .slice(0, 1000).map(({ bestRank, averageRank, ...row }) => row);
  if (candidates.length !== 1000 || new Set(candidates.map((x) => x.wallet)).size !== 1000) {
    throw new Error(`Expected exactly 1,000 unique combined leaderboard wallets; got ${candidates.length}`);
  }
  const generatedAt = new Date().toISOString();
  await writeJson("data/audit-universe.json", {
    schemaVersion: 1, generatedAt, source: "Polymarket official overall PNL leaderboard v2",
    selection: "weekly and monthly Top 1,000 combined, deduplicated, ranked by best period rank then average rank",
    validation: { passed: true, complete: true, candidateCount: 1000, weeklySourceCount: weekly.length, monthlySourceCount: monthly.length, uniqueWallets: true },
    candidates,
  });
  await writeJson("site/data/audit-universe-status.json", {
    state: "success", generatedAt, startedAt, candidateCount: 1000,
    weeklySourceCount: weekly.length, monthlySourceCount: monthly.length,
    uniqueWallets: 1000, validation: { passed: true, complete: true },
  });
  process.stdout.write(`Prepared exactly 1,000 unique Polymarket leaderboard wallets from weekly/monthly sources.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTop1000().catch((error) => {
    process.stderr.write(`Top 1,000 refresh failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
