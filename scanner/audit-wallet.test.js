import test from "node:test";
import assert from "node:assert/strict";
import { auditWallet, qualifyWalletAudit } from "./audit-wallet.js";

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

test("full wallet audit joins activity, redemption, token payout and resolution date", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const condition = "0x" + "a".repeat(64);
  const tokenId = "123456789";
  const activity = [
    {
      proxy_wallet: wallet, timestamp: 1794000000, type: "TRADE",
      condition_id: condition, token_id: tokenId, side: "BUY", size: 10,
      transaction_hash: "0xtrade",
    },
    {
      proxy_wallet: wallet, timestamp: 1794916900, type: "REDEEM",
      condition_id: condition, token_id: tokenId, size: 10, usdc_size: 10,
      transaction_hash: "0xredeem",
    },
  ];
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push({ path, params });
      if (path === "/v2/activity") return { rows: activity, pages: 1, complete: true };
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
  assert.equal(calls.filter(x => x.path === "/v2/tokens").length, 1);
});

test("wallet audit fails when either source history is incomplete", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const client = {
    async collectPages(path) {
      if (path === "/v2/activity") return { rows: [], pages: 1, complete: false };
      return { rows: [], pages: 1, complete: true };
    },
    async getJson() { return { data: [] }; },
  };
  await assert.rejects(auditWallet(client, wallet), /source history is incomplete/);
});
