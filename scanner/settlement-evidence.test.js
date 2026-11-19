import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSettledEvidence } from "./settlement-evidence.js";

const condition = "0x" + "a".repeat(64);
const resolution = {
  conditionId: condition, status:"resolved",
  resolvedAt:"2026-11-17T12:00:00.000Z", resolvedAtSeconds:1794916800,
};
const token = (tokenId, final_price) => ({
  tokenId, conditionId:condition, resolved:true, final_price,
});
const base = {
  activityComplete:true, positionsComplete:true,
  windowStartSeconds:1794000000,
  resolutions:new Map([[condition,resolution]]),
};

test("counts redeemed winners from explicit redemption evidence", () => {
  const result = summarizeSettledEvidence({
    ...base,
    redemptions:[{condition_id:condition,token_id:"101",size:10,usdc_size:10}],
    currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(result.wins,1);
  assert.equal(result.resolvedMarkets,1);
  assert.equal(result.integrityPassed,true);
});

test("counts still-held winners and losers from redeemable position snapshots", () => {
  const winners = summarizeSettledEvidence({
    ...base, redemptions:[],
    currentPositions:[{
      position:{condition_id:condition,token_id:"101",current_size:4},
      sourceStatusFilter:"REDEEMABLE",
    }],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  const losers = summarizeSettledEvidence({
    ...base, redemptions:[],
    currentPositions:[{
      position:{condition_id:condition,token_id:"101",current_size:4},
      sourceStatusFilter:"REDEEMABLE_LOST",
    }],
    tokenFacts:new Map([["101",token("101",0)]]),
  });
  assert.equal(winners.wins,1);
  assert.equal(losers.losses,1);
});

test("excludes early exits because they have neither redemption nor current redeemable evidence", () => {
  const result = summarizeSettledEvidence({
    ...base, redemptions:[], currentPositions:[], tokenFacts:new Map(),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.winRate,null);
  assert.equal(result.integrityPassed,true);
});

test("excludes a market when both outcomes are represented", () => {
  const result = summarizeSettledEvidence({
    ...base,
    redemptions:[
      {condition_id:condition,token_id:"101",size:5,usdc_size:5},
      {condition_id:condition,token_id:"202",size:5,usdc_size:0},
    ],
    currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)],["202",token("202",0)]]),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.exclusions.multiple_outcomes_held_in_same_market,1);
});

test("rejects redemption payout that contradicts token final price", () => {
  const result = summarizeSettledEvidence({
    ...base,
    redemptions:[{condition_id:condition,token_id:"101",size:10,usdc_size:0}],
    currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.integrityPassed,false);
});

test("requires complete source snapshots", () => {
  assert.throws(() => summarizeSettledEvidence({
    ...base, activityComplete:false, redemptions:[], currentPositions:[], tokenFacts:new Map(),
  }), /Complete redemption activity/);
});
