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


test("falls back to CLOB token IDs when condition ID lookup returns no markets", async () => {
  const calls = [];
  const result = await fetchGammaMarkets(["0xcondition"], {
    tokenIds: ["123456789"],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push({ conditions: parsed.searchParams.getAll("condition_ids"), tokens: parsed.searchParams.getAll("clob_token_ids") });
      const rows = calls.at(-1).tokens.length
        ? [{ conditionId: "0xcondition", question: "NBA market", active: true, closed: false }]
        : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    },
  });
  assert.equal(result.size, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].tokens, ["123456789"]);
});

test("fails instead of reporting successful zero-metadata consensus", async () => {
  await assert.rejects(fetchGammaMarkets(["0xcondition"], {
    fetchImpl: async () => new Response("[]", { status: 200 }),
  }), /zero market metadata/);
});
