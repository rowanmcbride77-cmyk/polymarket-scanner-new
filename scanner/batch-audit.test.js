import test from "node:test";
import assert from "node:assert/strict";
import { auditCandidatesBatch } from "./batch-audit.js";

test("shares token and resolution lookups across wallets", async () => {
  const condition = "0x" + "a".repeat(64);
  const tokenId = "123456789";
  const wallets = [
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push({ type: "positions", params });
      if (params.status === "CLOSED") {
        return {
          rows: [{
            proxy_wallet: params.user,
            condition_id: condition,
            token_id: tokenId,
            status: "CLOSED",
            current_size: 0,
            first_entry_at: 1794000000,
            last_event_at: 1794916900,
          }],
          pages: 1,
          complete: true,
        };
      }
      return { rows: [], pages: 1, complete: true };
    },
    async getJson(path, params) {
      calls.push({ type: path, params });
      if (path === "/v2/tokens") {
        return { data: [{ token_id: tokenId, condition_id: condition,
          outcome_index: 0, resolved: true, final_price: 1 }] };
      }
      if (path === "/v2/resolutions") {
        return { data: [{ condition_id: condition, status: "resolved",
          resolved_at: "2026-11-17T12:00:00.000Z" }] };
      }
      throw new Error("Unexpected endpoint");
    },
  };

  const result = await auditCandidatesBatch(wallets.map(wallet => ({ wallet, username: "Trader" })), {
    client,
    concurrency: 2,
    nowSeconds: 1796000000,
    minimumResolvedMarkets: 1,
    minimumWinRate: 1,
  });

  assert.equal(result.complete, true);
  assert.equal(result.allAuditsComplete, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(row => row.qualification.qualified));
  assert.ok(result.results.every(row => row.summary.resolvedMarkets === 1));
  assert.equal(calls.filter(call => call.type === "/v2/tokens").length, 1);
  assert.equal(calls.filter(call => call.type === "/v2/resolutions").length, 1);
  assert.equal(calls.filter(call => call.type === "positions").length, 6);
  assert.equal(result.uniqueTokens, 1);
  assert.equal(result.uniqueMarkets, 1);
});


test("skips token and resolution lookups when a wallet cannot reach the minimum market count", async () => {
  const condition = "0x" + "c".repeat(64);
  const wallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push({ type: "positions", params });
      if (params.status === "CLOSED") {
        return { rows: [{
          proxy_wallet: params.user,
          condition_id: condition,
          token_id: "987654321",
          status: "CLOSED",
          current_size: 0,
          first_entry_at: 1794000000,
          last_event_at: 1794916900,
        }], pages: 1, complete: true };
      }
      return { rows: [], pages: 1, complete: true };
    },
    async getJson(path) {
      calls.push({ type: path });
      throw new Error("Settlement enrichment should have been skipped");
    },
  };

  const result = await auditCandidatesBatch([{ wallet, username: "Trader" }], {
    client,
    concurrency: 1,
    nowSeconds: 1796000000,
    minimumResolvedMarkets: 10,
    minimumWinRate: 0.9,
  });

  assert.equal(result.complete, true);
  assert.equal(result.allAuditsComplete, true);
  assert.equal(result.results[0].complete, true);
  assert.equal(result.results[0].qualification.reason, "insufficient_resolved_markets");
  assert.equal(result.results[0].summary.resolvedMarkets, 0);
  assert.equal(result.prefilteredWallets, 1);
  assert.equal(result.settlementLookupWallets, 0);
  assert.equal(calls.filter(call => call.type === "/v2/tokens" || call.type === "/v2/resolutions").length, 0);
});
