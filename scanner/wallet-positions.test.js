import test from "node:test";
import assert from "node:assert/strict";
import { fetchRedeemablePositionSnapshot, fetchClosedPositionSnapshot, auditCurrentRedeemableSnapshot } from "./wallet-positions.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const position = (token_id) => ({
  proxy_wallet: wallet, condition_id: "0xcondition", token_id,
  status: "REDEEMABLE", current_size: 3, redeemable: true,
});

test("fetches the OPEN superset once and classifies held winners and losers by token payout", async () => {
  const calls = [];
  const client = {
    async collectPages(path, params) {
      calls.push(params);
      return { rows: [position("11"), position("22")], pages: 1, complete: true };
    },
    async getJson(path, params) {
      return { data: params.token_id.split(",").map(token_id => ({
        token_id, condition_id: "0xcondition", outcome_index: 0,
        resolved: true, final_price: token_id === "11" ? 1 : 0,
      })) };
    },
  };
  const snapshot = await fetchRedeemablePositionSnapshot(client, wallet);
  assert.deepEqual(calls.map(x => x.status), ["OPEN"]);
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records[0].sourceStatusFilter, "REDEEMABLE");
  assert.equal(snapshot.records[1].sourceStatusFilter, "REDEEMABLE_LOST");
  assert.equal(snapshot.records[1].tokenFact.final_price, 0);
  assert.equal(snapshot.coverage, "CURRENT_REDEEMABLE_POSITIONS_FROM_OPEN_SUPERSET");
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

test("fetches bounded CLOSED positions by last economic event time", async () => {
  let call;
  const closed = {
    proxy_wallet: wallet, condition_id: "0xcondition", token_id: "33",
    status: "CLOSED", current_size: 0, total_size: 3,
    last_event_at: 150, realized_pnl: 1,
  };
  const client = {
    async collectPages(path, params, options) {
      call = { path, params, options };
      return { rows: [closed], pages: 1, complete: true };
    },
  };
  const snapshot = await fetchClosedPositionSnapshot(client, wallet, {
    startSeconds: 100, endSeconds: 200,
  });
  assert.equal(call.params.status, "CLOSED");
  assert.equal(call.params.start, 100);
  assert.equal(call.params.end, 200);
  assert.equal(call.params.sort_by, "TIMESTAMP");
  assert.equal("include_archived" in call.params, false);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.complete, true);
});
