import test from "node:test";
import assert from "node:assert/strict";
import { fetchRedeemablePositionSnapshot, auditCurrentRedeemableSnapshot } from "./wallet-positions.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const position = (token_id) => ({
  proxy_wallet: wallet, condition_id: "0xcondition", token_id,
  status: "REDEEMABLE", current_size: 3,
});

test("fetches both winning and losing held-position filters and joins on-chain token facts", async () => {
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push(params);
      const rows = params.status === "REDEEMABLE" ? [position("11")] : [position("22")];
      return { rows, pages: 1, complete: true };
    },
    async getJson(path, params) {
      return { data: params.token_id.split(",").map(token_id => ({
        token_id, condition_id: "0xcondition", outcome_index: 0,
        resolved: true, final_price: token_id === "11" ? 1 : 0,
      })) };
    },
  };
  const snapshot = await fetchRedeemablePositionSnapshot(client, wallet);
  assert.deepEqual(calls.map(x => x.status), ["REDEEMABLE", "REDEEMABLE_LOST"]);
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records[1].tokenFact.final_price, 0);
  assert.equal(snapshot.coverage, "CURRENT_UNREDEEMED_REDEEMABLE_POSITIONS_ONLY");
});

test("snapshot diagnostics never qualify a trader from current unredeemed positions alone", async () => {
  const client = {
    async collectPages(path, params) {
      return { rows: [], pages: 1, complete: true };
    },
    async getJson() { return { data: [] }; },
  };
  const result = await auditCurrentRedeemableSnapshot(client, wallet);
  assert.equal(result.qualificationEligible, false);
  assert.equal(result.summary.winRate, null);
});

test("invalid wallet address is rejected", async () => {
  await assert.rejects(fetchRedeemablePositionSnapshot({}, "not-a-wallet"), /valid proxy wallet/);
});
