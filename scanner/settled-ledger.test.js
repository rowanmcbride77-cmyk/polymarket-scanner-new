import test from "node:test";
import assert from "node:assert/strict";
import { reconstructSettledMarketResults } from "./settled-ledger.js";

const condition = "0xcondition";
const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = (tokenId, final_price) => ({
  tokenId, conditionId: condition, resolved: true, final_price,
});
const resolution = {
  conditionId: condition, status: "resolved",
  resolvedAt: "2026-11-17T12:00:00.000Z", resolvedAtSeconds: 1794916800,
};
const base = {
  activityComplete: true, positionsComplete: true,
  tokenFacts: new Map([["101", token("101", 1)]]),
  resolutions: new Map([[condition, resolution]]),
  windowStartSeconds: 1794000000,
};

test("reconstructs a fully redeemed winning token from BUY then REDEEM", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    activity: [
      { type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:10, timestamp:1 },
      { type:"REDEEM", condition_id:condition, token_id:"101", size:10, usdc_size:10, timestamp:2 },
    ],
  });
  assert.equal(result.wins, 1);
  assert.equal(result.resolvedMarkets, 1);
  assert.equal(result.results[0].source, "verified_redeem_activity");
});

test("excludes early exits because sold inventory cannot be redeemed", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    activity: [
      { type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:10, timestamp:1 },
      { type:"TRADE", condition_id:condition, token_id:"101", side:"SELL", size:10, timestamp:2 },
    ],
    currentPositions: [],
  });
  assert.equal(result.resolvedMarkets, 0);
});

test("includes still-held resolved losing positions only with token resolution", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    tokenFacts: new Map([["101", token("101", 0)]]),
    activity: [{ type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:5, timestamp:1 }],
    currentPositions: [{ proxy_wallet:wallet, condition_id:condition, token_id:"101", current_size:5 }],
  });
  assert.equal(result.losses, 1);
});

test("fails closed when unsupported token flow is present", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    activity: [
      { type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:5, timestamp:1 },
      { type:"CONVERSION", condition_id:condition, token_id:"101", size:5, timestamp:2 },
    ],
    currentPositions: [{ condition_id:condition, token_id:"101", current_size:5 }],
  });
  assert.equal(result.resolvedMarkets, 0);
  assert.equal(result.exclusions.unsupported_or_inconsistent_activity, 1);
  assert.equal(result.integrityPassed, false);
});

test("excludes a market when both outcomes are held", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    tokenFacts: new Map([
      ["101", token("101", 1)],
      ["202", { tokenId:"202", conditionId:condition, resolved:true, final_price:0 }],
    ]),
    activity: [
      { type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:5, timestamp:1 },
      { type:"TRADE", condition_id:condition, token_id:"202", side:"BUY", size:5, timestamp:1 },
    ],
    currentPositions: [
      { condition_id:condition, token_id:"101", current_size:5 },
      { condition_id:condition, token_id:"202", current_size:5 },
    ],
  });
  assert.equal(result.resolvedMarkets, 0);
  assert.equal(result.exclusions.multiple_outcomes_held_in_same_market, 1);
});

test("does not count markets resolved outside the trailing window", () => {
  const result = reconstructSettledMarketResults({
    ...base,
    windowStartSeconds: 1795000000,
    activity: [
      { type:"TRADE", condition_id:condition, token_id:"101", side:"BUY", size:10, timestamp:1 },
      { type:"REDEEM", condition_id:condition, token_id:"101", size:10, usdc_size:10, timestamp:2 },
    ],
  });
  assert.equal(result.resolvedMarkets, 0);
});

test("incomplete histories are rejected", () => {
  assert.throws(() => reconstructSettledMarketResults({
    ...base, activityComplete:false, activity:[],
  }), /Complete activity and position snapshots/);
});
