import test from "node:test";
import assert from "node:assert/strict";
import { fetchMarketResolutions } from "./resolutions.js";

test("fetches resolutions in batches of 20 and normalizes resolved rows", async () => {
  const calls = [];
  const ids = Array.from({length:21},(_,i)=>`0x${i}`);
  const client = { async getJson(path, params) {
    calls.push(params.condition.split(","));
    return { data: params.condition.split(",").map(condition_id => ({
      condition_id, status: "resolved", resolved_at: "2026-11-17T12:00:00Z",
      payouts: [1,0], was_disputed: false,
    })) };
  }};
  const result = await fetchMarketResolutions(client, ids);
  assert.equal(calls.length, 2);
  assert.equal(result.size, 21);
  assert.equal(result.get("0x0").resolvedAtSeconds, 1794916800);
});

test("does not include unresolved lifecycle rows", async () => {
  const client = { async getJson() {
    return { data: [{ condition_id:"0x1", status:"proposed", resolved_at:null }] };
  }};
  const result = await fetchMarketResolutions(client, ["0x1"]);
  assert.equal(result.size, 0);
});

test("malformed resolution rows fail closed", async () => {
  const client = { async getJson() { return { data: [{ status:"resolved" }] }; } };
  await assert.rejects(fetchMarketResolutions(client, ["0x1"]), /malformed condition/);
});
