import { createDataApiClient } from "./data-api.js";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

function validActivityRow(row, wallet) {
  return row && typeof row === "object" &&
    String(row.proxy_wallet ?? "").toLowerCase() === wallet.toLowerCase() &&
    Number.isInteger(row.timestamp) && row.timestamp > 0 &&
    typeof row.type === "string" && row.type.length > 0 &&
    (row.token_id === undefined || row.token_id === null || /^\d+$/.test(String(row.token_id)));
}

/**
 * Complete wallet activity is the source ledger for reconstructing inventory.
 * start=1 is essential: omitted/zero start is only a rolling three-year window.
 * Ascending order makes replay deterministic; cursor and filters are preserved.
 */
export async function fetchCompleteWalletActivity(client, wallet, {
  limit = 1000,
  maxPages = 10000,
  onPage,
} = {}) {
  if (!WALLET_RE.test(wallet ?? "")) throw new TypeError("A valid proxy wallet address is required");
  const result = await client.collectPages("/v2/activity", {
    user: wallet,
    start: 1,
    sort_direction: "ASC",
    limit,
  }, { maxPages, onPage });

  const malformed = result.rows.filter((row) => !validActivityRow(row, wallet));
  if (malformed.length) {
    const error = new Error("Wallet activity contains malformed rows; refusing incomplete ledger");
    error.malformedRows = malformed.length;
    error.complete = false;
    throw error;
  }

  const seen = new Set();
  const rows = [];
  for (const row of result.rows) {
    // Only deduplicate on an explicit unique event identifier. Transaction
    // hashes are not unique per activity row: one transaction can contain
    // multiple fills for the same token and size.
    const eventId = row.id ?? row.activity_id ?? row.event_id ?? null;
    if (eventId !== null) {
      const key = String(eventId);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return {
    wallet: wallet.toLowerCase(),
    rows,
    pages: result.pages,
    complete: result.complete,
    malformedRows: 0,
    deduplicatedRows: result.rows.length - rows.length,
    coverage: "FULL_AVAILABLE_ACTIVITY_START_1",
  };
}

export function createActivityService(client = createDataApiClient()) {
  return {
    fetchCompleteWalletActivity: (wallet, options) =>
      fetchCompleteWalletActivity(client, wallet, options),
  };
}

export async function fetchRecentWalletActivity(client, wallet, {
  startSeconds,
  endSeconds = Math.floor(Date.now() / 1000),
  limit = 1000,
  maxPages = 100,
} = {}) {
  if (!WALLET_RE.test(wallet ?? "")) throw new TypeError("A valid proxy wallet address is required");
  if (!Number.isInteger(startSeconds) || !Number.isInteger(endSeconds) || startSeconds > endSeconds) {
    throw new TypeError("A valid recent activity time window is required");
  }
  const result = await client.collectPages("/v2/activity", {
    user: wallet,
    start: startSeconds,
    end: endSeconds,
    sort_direction: "DESC",
    limit,
  }, { maxPages });
  const malformed = result.rows.filter((row) => !validActivityRow(row, wallet));
  if (malformed.length) {
    const error = new Error("Recent wallet activity contains malformed rows");
    error.malformedRows = malformed.length;
    error.complete = false;
    throw error;
  }
  return {
    wallet: wallet.toLowerCase(),
    rows: result.rows,
    pages: result.pages,
    complete: result.complete,
    coverage: "RECENT_ACTIVITY_WINDOW",
    startSeconds,
    endSeconds,
  };
}
