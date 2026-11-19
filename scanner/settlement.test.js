import test from "node:test";
import assert from "node:assert/strict";
import { classifyPosition, summarizeSettledPositions } from "./settlement.js";

const position = (overrides = {}) => ({
  proxy_wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  condition_id: "0xcondition", token_id: "123", status: "REDEEMABLE", current_size: 5,
  ...overrides,
});
const winToken = { resolved: true, final_price: 1 };
const lossToken = { resolved: true, final_price: 0 };

test("counts held winning tokens only with winning filter and on-chain resolution", () => {
  assert.equal(classifyPosition(position(), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE", tokenFact: winToken,
  }).result, "win");
});

test("counts held losing tokens using lost filter context (row status still REDEEMABLE)", () => {
  assert.equal(classifyPosition(position(), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE_LOST", tokenFact: lossToken,
  }).result, "loss");
});

test("does not mistake a REDEEMABLE row from the lost filter for a winner", () => {
  assert.equal(classifyPosition(position(), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE_LOST", tokenFact: winToken,
  }).counted, false);
});

test("closed positions, incomplete history and unresolved tokens are excluded", () => {
  assert.equal(classifyPosition(position({ status: "CLOSED" }), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE", tokenFact: winToken,
  }).counted, false);
  assert.equal(classifyPosition(position(), {
    historyComplete: false, sourceStatusFilter: "REDEEMABLE", tokenFact: winToken,
  }).counted, false);
  assert.equal(classifyPosition(position(), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE", tokenFact: { resolved: false, final_price: null },
  }).counted, false);
});

test("fractional resolution payouts are excluded from binary win rate", () => {
  const result = classifyPosition(position(), {
    historyComplete: true, sourceStatusFilter: "REDEEMABLE", tokenFact: { resolved: true, final_price: 0.5 },
  });
  assert.equal(result.reason, "partial_payout_excluded");
});

test("summarizes unique settled positions and excludes duplicates", () => {
  const record = { position: position(), sourceStatusFilter: "REDEEMABLE", tokenFact: winToken };
  const loss = {
    position: position({ token_id: "456", outcome: "No" }),
    sourceStatusFilter: "REDEEMABLE_LOST", tokenFact: lossToken,
  };
  const result = summarizeSettledPositions([record, record, loss], { historyComplete: true });
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.winRate, 0.5);
});
