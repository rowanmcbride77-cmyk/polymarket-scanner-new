import test from "node:test";
import assert from "node:assert/strict";
import { classifyPosition, summarizeSettledPositions } from "./settlement.js";

test("counts only explicit resolved win and loss statuses", () => {
  assert.deepEqual(classifyPosition({ status: "REDEEMABLE" }, { historyComplete: true }),
    { counted: true, result: "win", reason: "explicit_redeemable_status" });
  assert.deepEqual(classifyPosition({ status: "REDEEMABLE_LOST" }, { historyComplete: true }),
    { counted: true, result: "loss", reason: "explicit_redeemable_lost_status" });
});

test("excludes early exits, open positions, unknown statuses, and incomplete history", () => {
  assert.equal(classifyPosition({ status: "CLOSED" }, { historyComplete: true }).counted, false);
  assert.equal(classifyPosition({ status: "OPEN" }, { historyComplete: true }).counted, false);
  assert.equal(classifyPosition({ status: "MYSTERY" }, { historyComplete: true }).counted, false);
  assert.equal(classifyPosition({ status: "REDEEMABLE" }).counted, false);
});

test("calculates settlement win rate without treating excluded positions as losses", () => {
  const result = summarizeSettledPositions([
    { condition_id: "a", token_id: "1", status: "REDEEMABLE" },
    { condition_id: "b", token_id: "2", status: "REDEEMABLE_LOST" },
    { condition_id: "c", token_id: "3", status: "CLOSED" },
    { condition_id: "d", token_id: "4", status: "OPEN" },
  ], { historyComplete: true });
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.excluded, 2);
  assert.equal(result.resolvedMarkets, 2);
  assert.equal(result.winRate, 0.5);
});

test("deduplicates repeated position rows by condition and token", () => {
  const row = { condition_id: "same", token_id: "yes", status: "REDEEMABLE" };
  const result = summarizeSettledPositions([row, row], { historyComplete: true });
  assert.equal(result.wins, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.exclusions.duplicate_position, 1);
});

test("does not invent a win rate when no positions qualify", () => {
  const result = summarizeSettledPositions([{ status: "CLOSED" }], { historyComplete: true });
  assert.equal(result.winRate, null);
});
