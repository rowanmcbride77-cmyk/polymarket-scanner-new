import { createDataApiClient } from "./data-api.js";
import { fetchTokenFacts } from "./tokens.js";
import { summarizeSettledPositions } from "./settlement.js";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export async function fetchRedeemablePositionSnapshot(client, wallet, {
  limit = 1000,
  maxPages = 100,
} = {}) {
  if (!WALLET_RE.test(wallet ?? "")) throw new TypeError("A valid proxy wallet address is required");
  const records = [];
  const partitions = [];
  for (const sourceStatusFilter of ["REDEEMABLE", "REDEEMABLE_LOST"]) {
    const result = await client.collectPages("/v2/positions", {
      user: wallet,
      status: sourceStatusFilter,
      limit,
      filter_type: "TOKENS",
      filter_amount: 0.000001,
      include_archived: true,
      sort_by: "TIMESTAMP",
      sort_direction: "DESC",
    }, { maxPages });
    partitions.push({
      sourceStatusFilter,
      pages: result.pages,
      count: result.rows.length,
      complete: result.complete,
    });
    for (const position of result.rows) records.push({ position, sourceStatusFilter });
  }
  const tokenIds = records.map(({ position }) => position?.token_id).filter(Boolean);
  const tokenFacts = await fetchTokenFacts(client, tokenIds);
  const joined = records.map((record) => ({
    ...record,
    tokenFact: tokenFacts.get(String(record.position.token_id)) ?? null,
  }));
  return {
    wallet: wallet.toLowerCase(),
    records: joined,
    partitions,
    complete: partitions.every((partition) => partition.complete),
    coverage: "CURRENT_UNREDEEMED_REDEEMABLE_POSITIONS_ONLY",
  };
}

/**
 * This is a snapshot diagnostic, not the historical 30-day win-rate metric.
 * Redeemed positions are no longer in this current-position view; the scanner
 * must not use this result alone to qualify a trader.
 */
export async function auditCurrentRedeemableSnapshot(client, wallet, options = {}) {
  const snapshot = await fetchRedeemablePositionSnapshot(client, wallet, options);
  const summary = summarizeSettledPositions(snapshot.records, {
    historyComplete: snapshot.complete,
  });
  return { ...snapshot, summary, qualificationEligible: false };
}

export function createWalletPositionService(client = createDataApiClient()) {
  return {
    fetchRedeemablePositionSnapshot: (wallet, options) =>
      fetchRedeemablePositionSnapshot(client, wallet, options),
    auditCurrentRedeemableSnapshot: (wallet, options) =>
      auditCurrentRedeemableSnapshot(client, wallet, options),
  };
}

export async function fetchClosedPositionSnapshot(client, wallet, {
  startSeconds,
  endSeconds = Math.floor(Date.now() / 1000),
  limit = 1000,
  maxPages = 20,
} = {}) {
  if (!WALLET_RE.test(wallet ?? "")) throw new TypeError("A valid proxy wallet address is required");
  if (!Number.isInteger(startSeconds) || !Number.isInteger(endSeconds) || startSeconds > endSeconds) {
    throw new TypeError("A valid closed-position time window is required");
  }
  const result = await client.collectPages("/v2/positions", {
    user: wallet,
    status: "CLOSED",
    start: startSeconds,
    end: endSeconds,
    limit,
    sort_by: "TIMESTAMP",
    sort_direction: "DESC",
  }, { maxPages });
  const malformed = result.rows.filter((row) =>
    !row || typeof row !== "object" ||
    String(row.proxy_wallet ?? "").toLowerCase() !== wallet.toLowerCase() ||
    row.status !== "CLOSED" ||
    typeof row.condition_id !== "string" || !row.condition_id ||
    typeof row.token_id !== "string" || !/^\d+$/.test(row.token_id) ||
    !Number.isInteger(row.last_event_at) || row.last_event_at <= 0 ||
    !Number.isFinite(row.total_size) || row.total_size <= 0 ||
    !Number.isFinite(row.realized_pnl));
  if (malformed.length) {
    const error = new Error("Closed position snapshot contains malformed rows");
    error.malformedRows = malformed.length;
    error.complete = false;
    throw error;
  }
  return {
    wallet: wallet.toLowerCase(),
    records: result.rows.map((position) => ({ position })),
    pages: result.pages,
    complete: result.complete,
    coverage: "CLOSED_POSITIONS_LAST_EVENT_WINDOW",
    startSeconds,
    endSeconds,
  };
}
