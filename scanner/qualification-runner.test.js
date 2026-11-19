import test from "node:test";
import assert from "node:assert/strict";
import { auditCandidates, buildQualifiedLeaderboards } from "./qualification-runner.js";

test("audits candidates with bounded concurrency and preserves every result", async () => {
  const candidates = Array.from({length:7},(_,i)=>({wallet:`wallet-${i}`,username:`u${i}`}));
  const result = await auditCandidates(candidates, {
    concurrency: 3,
    async auditWallet(wallet) {
      return {
        complete: true,
        qualification: { qualified: wallet.endsWith("0"), reason: "test" },
        summary: { wins: 20, losses: 0, resolvedMarkets: 20, winRate: 1 },
      };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.completed, 7);
  assert.equal(result.results.length, 7);
  assert.equal(result.failed, 0);
});

test("one failed wallet makes the batch incomplete", async () => {
  const result = await auditCandidates([{wallet:"ok"},{wallet:"bad"}], {
    concurrency: 2,
    async auditWallet(wallet) {
      if (wallet === "bad") throw new Error("upstream unavailable");
      return { complete:true, qualification:{qualified:true}, summary:{winRate:1,resolvedMarkets:20,wins:20,losses:0} };
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].error, "upstream unavailable");
});

test("weekly and monthly leaderboards contain only fully audited qualified wallets", () => {
  const discovery = {
    validation: { passed:true },
    candidates: [
      { wallet:"w1", username:"one", verified:true, appearances:[
        {timePeriod:"week",category:"sports",pnl:100,rank:5},
        {timePeriod:"month",category:"sports",pnl:200,rank:4},
      ]},
      { wallet:"w2", username:"two", verified:false, appearances:[
        {timePeriod:"week",category:"crypto",pnl:300,rank:2},
      ]},
    ],
  };
  const auditBatch = {
    complete:true,
    results:[
      {wallet:"w1",complete:true,qualification:{qualified:true},summary:{wins:19,losses:1,winRate:.95,resolvedMarkets:20}},
      {wallet:"w2",complete:true,qualification:{qualified:false},summary:{wins:10,losses:10,winRate:.5,resolvedMarkets:20}},
    ],
  };
  const result = buildQualifiedLeaderboards(discovery,auditBatch);
  assert.equal(result.weekly.length,1);
  assert.equal(result.weekly[0].wallet,"w1");
  assert.equal(result.monthly.length,1);
  assert.equal(result.monthly[0].rank,1);
});

test("leaderboard build refuses any incomplete audit batch", () => {
  assert.throws(() => buildQualifiedLeaderboards(
    {validation:{passed:true},candidates:[]},
    {complete:false,results:[]},
  ), /Every discovered wallet/);
});
