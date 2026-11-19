import test from "node:test";
import assert from "node:assert/strict";
import { fetchCompleteWalletActivity, fetchRecentWalletActivity } from "./activity.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const event = (timestamp, overrides = {}) => ({
  proxy_wallet: wallet, timestamp, type: "TRADE", token_id: "123",
  transaction_hash: `0x${timestamp}`, side: "BUY", size: 2, ...overrides,
});

test("requests full ascending activity history and returns ordered rows", async () => {
  let call;
  const client = { async collectPages(path, params, options) {
    call = { path, params, options };
    return { rows: [event(20), event(10)], pages: 2, complete: true };
  }};
  const result = await fetchCompleteWalletActivity(client, wallet);
  assert.equal(call.path, "/v2/activity");
  assert.equal(call.params.start, 1);
  assert.equal(call.params.sort_direction, "ASC");
  assert.equal(result.rows[0].timestamp, 10);
  assert.equal(result.complete, true);
});

test("preserves repeated rows without an explicit event ID", async () => {
  const row = event(10);
  const client = { async collectPages() {
    return { rows: [row, row], pages: 1, complete: true };
  }};
  const result = await fetchCompleteWalletActivity(client, wallet);
  assert.equal(result.rows.length, 2);
  assert.equal(result.deduplicatedRows, 0);
});

test("deduplicates only repeated explicit event IDs", async () => {
  const row = event(10, { id: "activity-1" });
  const client = { async collectPages() {
    return { rows: [row, row], pages: 1, complete: true };
  }};
  const result = await fetchCompleteWalletActivity(client, wallet);
  assert.equal(result.rows.length, 1);
  assert.equal(result.deduplicatedRows, 1);
});

test("malformed activity fails closed", async () => {
  const client = { async collectPages() {
    return { rows: [event(0)], pages: 1, complete: true };
  }};
  await assert.rejects(fetchCompleteWalletActivity(client, wallet), /malformed rows/);
});

test("invalid wallet is rejected", async () => {
  await assert.rejects(fetchCompleteWalletActivity({}, "bad"), /valid proxy wallet/);
});

test("fetches recent wallet activity with explicit 60-minute bounds", async () => {
  let call;
  const client = { async collectPages(path, params, options) {
    call = { path, params, options };
    return { rows: [event(100)], pages: 1, complete: true };
  }};
  const result = await fetchRecentWalletActivity(client, wallet, {
    startSeconds: 50, endSeconds: 150,
  });
  assert.equal(call.path, "/v2/activity");
  assert.equal(call.params.start, 50);
  assert.equal(call.params.end, 150);
  assert.equal(call.params.sort_direction, "DESC");
  assert.equal(result.complete, true);
});
