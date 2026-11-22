import test from "node:test";
import assert from "node:assert/strict";
import { fetchGammaMarkets } from "./gamma-markets.js";

test("fetches Gamma markets in batches and indexes by condition ID", async () => {
  const ids = Array.from({length:101},(_,i)=>`0x${i}`);
  const calls = [];
  const result = await fetchGammaMarkets(ids, {
    fetchImpl: async (url) => {
      calls.push(new URL(url).searchParams.getAll("condition_ids"));
      return new Response(JSON.stringify(calls.at(-1).map(conditionId => ({
        conditionId, question:"Question", active:true, closed:false,
        endDate:"2026-11-19T12:00:00Z", category:"Sports",
      }))), {status:200,headers:{"content-type":"application/json"}});
    },
  });
  assert.equal(calls.length,2);
  assert.equal(result.size,101);
  assert.equal(result.get("0x1").active,true);
});

test("retries Gamma 429 using Retry-After", async () => {
  let attempts = 0;
  const delays = [];
  const result = await fetchGammaMarkets(["0x1"], {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("",{status:429,headers:{"retry-after":"0.25"}});
      return new Response(JSON.stringify([{conditionId:"0x1",active:true,closed:false}]),{status:200});
    },
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(attempts,2);
  assert.deepEqual(delays,[250]);
  assert.equal(result.size,1);
});

test("malformed Gamma rows fail closed", async () => {
  await assert.rejects(fetchGammaMarkets(["0x1"], {
    fetchImpl: async () => new Response(JSON.stringify([{question:"missing condition"}]),{status:200}),
  }), /missing conditionId/);
});
