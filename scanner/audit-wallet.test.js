import test from "node:test";
import assert from "node:assert/strict";
import { auditWallet, qualifyWalletAudit } from "./audit-wallet.js";

test("qualification requires complete audit and 20 settled markets at 90 percent", () => {
  assert.deepEqual(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: 0.9, integrityPassed: true },
  }), { qualified: true, reason: "all_thresholds_met" });
});

test("qualification rejects incomplete, undersampled and low-win-rate wallets", () => {
  assert.equal(qualifyWalletAudit({
    complete: false, summary: { resolvedMarkets: 100, winRate: 1, integrityPassed: true },
  }).reason, "incomplete_audit");
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 19, winRate: 1, integrityPassed: true },
  }).reason, "insufficient_resolved_markets");
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: 0.89, integrityPassed: true },
  }).reason, "win_rate_below_threshold");
});

test("qualification never treats a missing win rate as zero or a pass", () => {
  assert.equal(qualifyWalletAudit({
    complete: true, summary: { resolvedMarkets: 20, winRate: null, integrityPassed: true },
  }).qualified, false);
});

test("full wallet audit classifies a closed position only when its last event follows resolution", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const condition = "0x" + "a".repeat(64);
  const tokenId = "123456789";
  const closedPosition = {
    proxy_wallet: wallet, condition_id: condition, token_id: tokenId,
    status: "CLOSED", current_size: 0, total_size: 10, first_entry_at: 1794000000,
    last_event_at: 1794916900, realized_pnl: 10,
  };
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push({ path, params });
      if (path === "/v2/positions" && params.status === "CLOSED") {
        return { rows: [closedPosition], pages: 1, complete: true };
      }
      if (path === "/v2/positions") return { rows: [], pages: 1, complete: true };
      throw new Error("unexpected paginated path");
    },
    async getJson(path, params) {
      calls.push({ path, params });
      if (path === "/v2/tokens") return { data: [{
        token_id: tokenId, condition_id: condition, outcome_index: 0,
        resolved: true, final_price: 1,
      }] };
      if (path === "/v2/resolutions") return { data: [{
        condition_id: condition, status: "resolved",
        resolved_at: "2026-11-17T12:00:00.000Z",
      }] };
      throw new Error("unexpected endpoint");
    },
  };
  const result = await auditWallet(client, wallet, {
    nowSeconds: 1796000000, lookbackDays: 30,
    minimumResolvedMarkets: 1, minimumWinRate: 1,
  });
  assert.equal(result.summary.wins, 1);
  assert.equal(result.summary.resolvedMarkets, 1);
  assert.equal(result.qualification.qualified, true);
  assert.equal(result.tokenFacts, 1);
  assert.equal(result.resolutionFacts, 1);
  const closedCall = calls.find((x) => x.path === "/v2/positions" && x.params.status === "CLOSED");
  assert.equal(closedCall.params.start, 1796000000 - 30 * 86400);
  assert.equal(closedCall.params.end, 1796000000);
  assert.equal(calls.filter(x => x.path === "/v2/positions").length, 2);
});

test("wallet audit fails when either position snapshot is incomplete", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const client = {
    async collectPages(path, params) {
      if (path === "/v2/positions" && params.status === "CLOSED") {
        return { rows: [], pages: 1, complete: false };
      }
      return { rows: [], pages: 1, complete: true };
    },
    async getJson() { return { data: [] }; },
  };
  await assert.rejects(auditWallet(client, wallet), /position snapshots are incomplete/);
});

test("qualification rejects uncertain settlement accounting", () => {
  assert.equal(qualifyWalletAudit({
    complete: true,
    summary: { resolvedMarkets: 40, winRate: 1, integrityPassed: false },
  }).reason, "settlement_integrity_not_verified");
});
