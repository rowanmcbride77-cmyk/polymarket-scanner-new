import test from "node:test";
import assert from "node:assert/strict";
import { fetchTokenFacts, requireTokenFact } from "./tokens.js";

test("token facts are requested in batches of at most 50", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const calls = [];
  const client = { async getJson(path, params) {
    calls.push({ path, params });
    return { data: params.token_id.split(",").map(token_id => ({
      token_id, condition_id: "condition", outcome_index: 0,
      resolved: true, final_price: 1, outcome: "Yes",
    })) };
  }};
  const facts = await fetchTokenFacts(client, ids);
  assert.equal(calls.length, 2);
  assert.equal(facts.size, 51);
  assert.equal(requireTokenFact(facts, "51").final_price, 1);
});

test("missing or malformed token facts fail closed", async () => {
  const client = { async getJson() { return { data: [{ token_id: "1", resolved: true }] }; } };
  await assert.rejects(fetchTokenFacts(client, ["1"]), /malformed resolution facts/);
  assert.throws(() => requireTokenFact(new Map(), "1"), /Missing token resolution fact/);
});

test("invalid token IDs are rejected", async () => {
  await assert.rejects(fetchTokenFacts({ getJson() {} }, ["not-an-id"]), /Invalid CLOB token id/);
});


test("token fact batches run concurrently but remain bounded", async () => {
  let active = 0;
  let peak = 0;
  const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
  const client = { async getJson(path, params) {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return { data: params.token_id.split(",").map(token_id => ({
      token_id, condition_id: "condition", resolved: true, final_price: 1,
    })) };
  }};
  const facts = await fetchTokenFacts(client, ids, { concurrency: 4 });
  assert.equal(facts.size, 501);
  assert.ok(peak > 1 && peak <= 4);
});
