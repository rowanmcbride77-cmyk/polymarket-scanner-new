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
const closed = (tokenId, last_event_at = 1794916900) => ({
  position:{
    condition_id:condition, token_id:tokenId, status:"CLOSED",
    current_size:0, total_size:10, first_entry_at:1794000000, last_event_at, realized_pnl:1,
  },
});
const base = {
  closedPositionsComplete:true, positionsComplete:true,
  windowStartSeconds:1794000000,
  resolutions:new Map([[condition,resolution]]),
};

test("counts a closed position whose last economic event occurred after resolution", () => {
  const result = summarizeSettledEvidence({
    ...base, closedPositions:[closed("101")], currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(result.wins,1);
  assert.equal(result.resolvedMarkets,1);
  assert.equal(result.integrityPassed,true);
});

test("excludes a closed position whose last event preceded resolution", () => {
  const result = summarizeSettledEvidence({
    ...base, closedPositions:[closed("101",1794916700)], currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.exclusions.early_exit_excluded,1);
  assert.equal(result.integrityPassed,true);
});

test("counts still-held winners and losers from redeemable position snapshots", () => {
  const winners = summarizeSettledEvidence({
    ...base, closedPositions:[],
    currentPositions:[{
      position:{condition_id:condition,token_id:"101",current_size:4,first_entry_at:1794000000},
      sourceStatusFilter:"REDEEMABLE",
    }],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  const losers = summarizeSettledEvidence({
    ...base, closedPositions:[],
    currentPositions:[{
      position:{condition_id:condition,token_id:"101",current_size:4,first_entry_at:1794000000},
      sourceStatusFilter:"REDEEMABLE_LOST",
    }],
    tokenFacts:new Map([["101",token("101",0)]]),
  });
  assert.equal(winners.wins,1);
  assert.equal(losers.losses,1);
});

test("excludes early exits because no post-resolution or current position evidence exists", () => {
  const result = summarizeSettledEvidence({
    ...base, closedPositions:[], currentPositions:[], tokenFacts:new Map(),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.winRate,null);
  assert.equal(result.integrityPassed,true);
});

test("excludes a market when both outcomes were held through resolution", () => {
  const result = summarizeSettledEvidence({
    ...base,
    closedPositions:[closed("101"),closed("202")],
    currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)],["202",token("202",0)]]),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.exclusions.multiple_outcomes_held_in_same_market,1);
});

test("rejects missing resolution facts for resolved closed positions", () => {
  const result = summarizeSettledEvidence({
    ...base, resolutions:new Map(),
    closedPositions:[closed("101")], currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(result.resolvedMarkets,0);
  assert.equal(result.integrityPassed,true);
  assert.equal(result.integrityFailures.includes("missing_resolution_timestamp"),true);
});

test("requires complete source snapshots", () => {
  assert.throws(() => summarizeSettledEvidence({
    ...base, closedPositionsComplete:false, closedPositions:[], currentPositions:[], tokenFacts:new Map(),
  }), /Complete closed-position/);
});

test("excludes ambiguous same-second close and token-resolution disagreement", () => {
  const sameSecond = summarizeSettledEvidence({
    ...base, closedPositions:[closed("101",1794916800)], currentPositions:[],
    tokenFacts:new Map([["101",token("101",1)]]),
  });
  assert.equal(sameSecond.resolvedMarkets,0);
  assert.equal(sameSecond.exclusions.same_second_as_resolution_ambiguous,1);

  const mismatch = summarizeSettledEvidence({
    ...base, closedPositions:[closed("101")], currentPositions:[],
    tokenFacts:new Map([["101",{...token("101",1),resolved:false}]]),
  });
  assert.equal(mismatch.integrityPassed,true);
  assert.equal(mismatch.integrityFailures.includes("token_resolution_state_mismatch"),true);
  assert.equal(mismatch.exclusions.token_resolution_state_mismatch,1);
});


test("a bad market does not erase other independently verified markets", () => {
  const otherCondition = "0x" + "b".repeat(64);
  const otherResolution = { ...resolution, conditionId: otherCondition };
  const bad = { position: { condition_id: otherCondition, token_id: "202",
    current_size: 0, first_entry_at: 1794000000, last_event_at: 1794916900 } };
  const result = summarizeSettledEvidence({
    ...base, closedPositions: [closed("101"), bad], currentPositions: [],
    resolutions: new Map([[condition, resolution], [otherCondition, otherResolution]]),
    tokenFacts: new Map([["101", token("101", 1)]]),
  });
  assert.equal(result.resolvedMarkets, 1);
  assert.equal(result.wins, 1);
  assert.equal(result.integrityPassed, true);
  assert.equal(result.integrityFailures.includes("missing_closed_position_token_fact"), true);
});
