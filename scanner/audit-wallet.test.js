import test from "node:test";
import assert from "node:assert/strict";
import { qualifyWalletAudit } from "./audit-wallet.js";

test("qualification requires complete audit and 20 settled markets at 90 percent", () => {
  assert.deepEqual(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: 0.9 },
  }), { qualified: true, reason: "all_thresholds_met" });
});

test("qualification rejects incomplete, undersampled and low-win-rate wallets", () => {
  assert.equal(qualifyWalletAudit({
    complete: false, summary: { resolvedMarkets: 100, winRate: 1 },
  }).reason, "incomplete_audit");
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 19, winRate: 1 },
  }).reason, "insufficient_resolved_markets");
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: 0.89 },
  }).reason, "win_rate_below_threshold");
});

test("qualification never treats a missing win rate as zero or a pass", () => {
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: null },
  }).qualified, false);
});
