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

test("ignores question-keyed resolved lifecycle rows without a condition id", async () => {
  const client = { async getJson() {
    return { data: [
      { questionId: "0xquestion", status: "resolved", resolvedAt: "2026-11-17T12:00:00Z" },
      { conditionId: "0x1", status: "resolved", resolvedAt: "2026-11-17T12:00:00Z" },
    ] };
  }};
  const result = await fetchMarketResolutions(client, ["0x1"]);
  assert.equal(result.size, 1);
  assert.equal(result.has("0x1"), true);
});

test("ignores condition rows without a usable resolution timestamp", async () => {
  const client = { async getJson() {
    return { data: [
      { conditionId: "0x1", status: "resolved", resolvedAt: null },
      { conditionId: "0x2", status: "proposed", resolvedAt: "2026-11-17T12:00:00Z" },
    ] };
  }};
  const result = await fetchMarketResolutions(client, ["0x1", "0x2"]);
  assert.equal(result.size, 0);
});

test("normalizes numeric epoch seconds and milliseconds", async () => {
  const client = { async getJson() {
    return { data: [
      { conditionId: "0x1", status: "resolved", resolvedAt: 1794916800 },
      { conditionId: "0x2", status: "resolved", resolvedAt: 1794916800000 },
    ] };
  }};
  const result = await fetchMarketResolutions(client, ["0x1", "0x2"]);
  assert.equal(result.get("0x1").resolvedAtSeconds, 1794916800);
  assert.equal(result.get("0x2").resolvedAtSeconds, 1794916800);
});

test("rejects a malformed data envelope", async () => {
  const client = { async getJson() { return { data: {} }; } };
  await assert.rejects(fetchMarketResolutions(client, ["0x1"]), /malformed data envelope/);
});
