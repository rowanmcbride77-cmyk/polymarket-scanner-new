import { createDataApiClient } from "./data-api.js";

const VALID_PERIODS = new Set(["week", "month"]);
const VALID_CATEGORIES = new Set(["overall", "sports", "esports", "crypto"]);
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
  categories = ["overall"],
  periods = ["month"],
  limit = 1000,
  maxCandidates = 20000,
  maxPagesPerPartition = 20,
} = {}) {
  for (const category of categories) {
    if (!VALID_CATEGORIES.has(category)) throw new TypeError(`Unsupported discovery category: ${category}`);
  }
  for (const period of periods) {
    if (!VALID_PERIODS.has(period)) throw new TypeError(`Unsupported discovery period: ${period}`);
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new RangeError("maxCandidates must be a positive integer");
  }
  if (!Number.isInteger(maxPagesPerPartition) || maxPagesPerPartition < 1) {
    throw new RangeError("maxPagesPerPartition must be a positive integer");
  }

  const states = periods.flatMap((timePeriod) => categories.map((category) => ({
    category, timePeriod, cursor: undefined, pages: 0, rowCount: 0,
    exhausted: false, seenCursors: new Set(), seenWallets: new Set(),
  })));
  const candidates = new Map();

  async function readNextPage(state) {
    const page = await client.getPage("/v2/leaderboard", {
      time_period: state.timePeriod,
      category: state.category,
      sort_by: "PNL",
      limit,
    }, state.cursor);
    state.pages += 1;
    state.rowCount += page.rows.length;

    for (const row of page.rows) {
      if (!validateRow(row)) {
        throw new LeaderboardError("Leaderboard returned malformed rows; refusing partial candidate set", {
          category: state.category, timePeriod: state.timePeriod, complete: false,
        });
      }
      const wallet = row.user_id.toLowerCase();
      if (state.seenWallets.has(wallet)) continue;
      state.seenWallets.add(wallet);
      const existing = candidates.get(wallet) ?? {
        wallet, username: typeof row.user_name === "string" ? row.user_name : wallet,
        verified: row.verified === true,
        profileImage: typeof row.profile_image === "string" ? row.profile_image : null,
        xUsername: typeof row.x_username === "string" ? row.x_username : null,
        appearances: [],
      };
      existing.appearances.push({
        category: state.category, timePeriod: state.timePeriod,
        rank: row.rank, pnl: row.pnl, volumeShares: row.volume,
      });
      candidates.set(wallet, existing);
    }

    if (!page.hasMore) {
      state.exhausted = true;
      state.cursor = undefined;
      return;
    }
    if (!page.nextCursor) {
      throw new LeaderboardError("Leaderboard reports more rows without a cursor", {
        category: state.category, timePeriod: state.timePeriod, complete: false,
      });
    }
    if (state.seenCursors.has(page.nextCursor)) {
      throw new LeaderboardError("Leaderboard repeated a cursor", {
        category: state.category, timePeriod: state.timePeriod, complete: false,
      });
    }
    state.seenCursors.add(page.nextCursor);
    state.cursor = page.nextCursor;
  }

  // Seed every vertical/window before deepening any one leaderboard.
  for (const state of states) await readNextPage(state);

  while (candidates.size < maxCandidates) {
    const active = states.filter((state) =>
      !state.exhausted && state.pages < maxPagesPerPartition);
    if (!active.length) break;
    let advanced = false;
    for (const state of active) {
      if (candidates.size >= maxCandidates) break;
      await readNextPage(state);
      advanced = true;
    }
    if (!advanced) break;
  }

  const sortedCandidates = [...candidates.values()].sort((a, b) =>
    b.appearances.length - a.appearances.length ||
    a.appearances.reduce((sum, x) => sum + x.rank, 0) -
      b.appearances.reduce((sum, x) => sum + x.rank, 0));
  const cappedCandidates = sortedCandidates.slice(0, maxCandidates);
  const partitions = states.map((state) => ({
    category: state.category,
    timePeriod: state.timePeriod,
    sortBy: "PNL",
    pages: state.pages,
    rowCount: state.rowCount,
    complete: true,
    exhausted: state.exhausted,
    truncated: !state.exhausted,
  }));
  return {
    candidates: cappedCandidates,
    partitions,
    complete: true,
    sourceExhausted: states.every((state) => state.exhausted),
    candidateCapReached: sortedCandidates.length >= maxCandidates,
    maxCandidates,
  };
}
