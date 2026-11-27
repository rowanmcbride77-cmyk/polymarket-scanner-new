import test from "node:test";
import assert from "node:assert/strict";
import { validateQualifiedBoard, qualifiedWalletsFromBoards } from "./consensus-run.js";

const wallet = "0x" + "a".repeat(40);
const generatedAt = "2026-11-27T21:38:44.000Z";
const row = {
  wallet, username: "Trader",
  winRate: 0.95, resolvedMarkets: 20, wins: 19, losses: 1,
  earlyExitsCounted: 0,
};
const board = (period = "week", overrides = {}) => ({
  schemaVersion: 1, period, generatedAt, count: 1,
  validation: { passed: true, complete: true },
  qualification: {
    minimumResolvedMarkets: 10, minimumWinRate: 0.9,
    lookbackDays: 60, earlyExitsCounted: false,
    settlementIntegrityRequired: true,
  },
  traders: [{ ...row }],
  ...overrides,
});

test("accepts a fresh board containing only settlement-qualified traders", () => {
  assert.equal(validateQualifiedBoard(board(), "week", generatedAt).length, 1);
});

test("rejects a stale board even when its rows look qualified", () => {
  assert.throws(
    () => validateQualifiedBoard(board("week", { generatedAt: "2026-11-26T00:00:00.000Z" }), "week", generatedAt),
    /stale or incomplete/,
  );
});

test("rejects an early-exit count instead of silently counting the trader", () => {
  const invalid = board();
  invalid.traders[0].earlyExitsCounted = 1;
  assert.throws(() => validateQualifiedBoard(invalid, "week", generatedAt), /non-qualified trader/);
});

test("rejects a trader below the 90 percent or 10 resolved-market thresholds", () => {
  const invalid = board();
  invalid.traders[0].winRate = 0.89;
  assert.throws(() => validateQualifiedBoard(invalid, "week", generatedAt), /non-qualified trader/);
});

test("merges weekly and monthly boards by unique wallet only after validation", () => {
  const week = board();
  const month = board("month");
  const wallets = qualifiedWalletsFromBoards(week, month);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].wallet, wallet);
});
