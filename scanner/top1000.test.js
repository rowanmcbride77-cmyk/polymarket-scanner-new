import test from "node:test";
import assert from "node:assert/strict";
import { buildTop1000AuditUniverse } from "./top1000.js";

function rows(start) {
  return Array.from({ length: 1000 }, (_, index) => ({
    wallet: "0x" + (start + index).toString(16).padStart(40, "0"),
    username: `Trader ${start + index}`,
    verified: false,
    appearances: [{
      category: "overall", timePeriod: start === 0 ? "week" : "month",
      rank: index + 1, pnl: 1000 - index, volumeShares: 10,
    }],
  }));
}

test("combines weekly and monthly leaderboard populations into exactly 1,000 unique wallets", () => {
  const weekly = rows(0);
  const monthly = rows(500);
  const candidates = buildTop1000AuditUniverse(weekly, monthly);
  assert.equal(candidates.length, 1000);
  assert.equal(new Set(candidates.map((row) => row.wallet)).size, 1000);
  assert.ok(candidates.some((row) => row.appearances.length === 2));
  assert.ok(candidates.every((row) => row.appearances.length >= 1));
});

test("refuses incomplete source leaderboards", () => {
  assert.throws(() => buildTop1000AuditUniverse(rows(0).slice(0, 999), rows(1000)), /exactly 1,000/);
});
