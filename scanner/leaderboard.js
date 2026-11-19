import { createDataApiClient } from "./data-api.js";

const VALID_PERIODS = new Set(["week", "month"]);
const VALID_CATEGORIES = new Set(["sports", "esports", "crypto"]);
const VALID_SORTS = new Set(["PNL", "VOLUME"]);
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export class LeaderboardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaderboardError";
    Object.assign(this, details);
  }
}

function validateRow(row) {
  if (!row || typeof row !== "object") return false;
  return WALLET_RE.test(row.user_id ?? "") &&
    Number.isInteger(row.rank) && row.rank > 0 &&
    Number.isFinite(row.pnl) && Number.isFinite(row.volume);
}

/**
 * Reads a complete v2 leaderboard partition. A successful result means every
 * cursor page was fetched; it does not mean a wallet is performance-qualified.
 */
export async function fetchLeaderboardPartition(client, {
  timePeriod,
  category,
  sortBy = "PNL",
  limit = 1000,
  maxPages = 100,
} = {}) {
  if (!VALID_PERIODS.has(timePeriod)) throw new TypeError("timePeriod must be week or month");
  if (!VALID_CATEGORIES.has(category)) throw new TypeError("Unsupported discovery category");
  if (!VALID_SORTS.has(sortBy)) throw new TypeError("sortBy must be PNL or VOLUME");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1..1000");

  const result = await client.collectPages("/v2/leaderboard", {
    time_period: timePeriod,
    category,
    sort_by: sortBy,
    limit,
  }, { maxPages });

  const invalidRows = [];
  const seen = new Set();
  const rows = [];
  for (const row of result.rows) {
    if (!validateRow(row)) {
      invalidRows.push(row);
      continue;
    }
    const wallet = row.user_id.toLowerCase();
    if (seen.has(wallet)) continue;
    seen.add(wallet);
    rows.push({
      wallet,
      rank: row.rank,
      username: typeof row.user_name === "string" ? row.user_name : wallet,
      pnl: row.pnl,
      volumeShares: row.volume,
      verified: row.verified === true,
      profileImage: typeof row.profile_image === "string" ? row.profile_image : null,
      xUsername: typeof row.x_username === "string" ? row.x_username : null,
      category,
      timePeriod,
      sortBy,
    });
  }

  if (invalidRows.length) {
    throw new LeaderboardError("Leaderboard returned malformed rows; refusing partial candidate set", {
      category, timePeriod, invalidRowCount: invalidRows.length, complete: false,
    });
  }
  return { rows, pages: result.pages, complete: result.complete, category, timePeriod, sortBy };
}

/** Fetches the three target verticals for both windows, without politics/overall. */
export async function discoverLeaderboardCandidates({
  client = createDataApiClient(),
  categories = ["sports", "esports", "crypto"],
  periods = ["week", "month"],
  limit = 1000,
  maxPages = 100,
} = {}) {
  for (const category of categories) {
    if (!VALID_CATEGORIES.has(category)) throw new TypeError(`Unsupported discovery category: ${category}`);
  }
  for (const period of periods) {
    if (!VALID_PERIODS.has(period)) throw new TypeError(`Unsupported discovery period: ${period}`);
  }

  const partitions = [];
  for (const timePeriod of periods) {
    for (const category of categories) {
      partitions.push(await fetchLeaderboardPartition(client, {
        timePeriod, category, sortBy: "PNL", limit, maxPages,
      }));
    }
  }

  const candidates = new Map();
  for (const partition of partitions) {
    for (const row of partition.rows) {
      const existing = candidates.get(row.wallet) ?? {
        wallet: row.wallet, username: row.username, verified: row.verified,
        profileImage: row.profileImage, xUsername: row.xUsername,
        appearances: [],
      };
      existing.appearances.push({
        category: row.category, timePeriod: row.timePeriod,
        rank: row.rank, pnl: row.pnl, volumeShares: row.volumeShares,
      });
      candidates.set(row.wallet, existing);
    }
  }
  return {
    candidates: [...candidates.values()],
    partitions: partitions.map(({ category, timePeriod, sortBy, pages, rows }) => ({
      category, timePeriod, sortBy, pages, rowCount: rows.length, complete: true,
    })),
    complete: partitions.every((partition) => partition.complete),
  };
}
