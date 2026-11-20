import test from "node:test";
import assert from "node:assert/strict";
import { buildComboOpportunities } from "./combos.js";

const wallet = "0x" + "a".repeat(40);
const now = Date.parse("2026-11-20T12:00:00Z");
const active = (overrides = {}) => ({
  _wallet: wallet, combo_position_id: "combo-1", status: "OPEN",
  entry_cost_usdc: 20, current_size: 300, legs_total: 3,
  legs: [
    {leg_index:1,leg_outcome_label:"Yes",market:{question:"Team A wins",startDate:"2026-11-21T20:00:00Z"}},
    {leg_index:2,leg_outcome_label:"Over",market:{question:"Player points",startDate:"2026-11-21T21:00:00Z"}},
    {leg_index:3,leg_outcome_label:"Yes",market:{question:"Team B wins",startDate:"2026-11-21T22:00:00Z"}},
  ], ...overrides,
});

test("finds active combos at or below $100 and ranks by potential payout multiple", () => {
  const result = buildComboOpportunities([
    active(),
    active({combo_position_id:"combo-2",entry_cost_usdc:50,current_size:600}),
  ], {nowMs:now});
  assert.equal(result.opportunities.length,2);
  assert.equal(result.opportunities[0].comboPositionId,"combo-1");
  assert.equal(result.opportunities[0].multiplier,15);
  assert.equal(result.opportunities[0].potentialPayoutUsd,300);
  assert.equal(result.opportunities[0].timing.key,"upcoming");
});

test("does not impose a trader win-rate threshold", () => {
  const result = buildComboOpportunities([active()], {nowMs:now});
  assert.equal(result.thresholds.traderWinRateRequired,false);
  assert.equal(result.opportunities[0].traderComboRecord.resolved,0);
});

test("excludes combos over budget, below multiplier, and no longer held", () => {
  const result = buildComboOpportunities([
    active({combo_position_id:"too-expensive",entry_cost_usdc:101}),
    active({combo_position_id:"small-multiple",entry_cost_usdc:50,current_size:100}),
    active({combo_position_id:"closed",status:"RESOLVED_WIN"}),
  ], {nowMs:now});
  assert.equal(result.opportunities.length,0);
  assert.equal(result.exclusions.entry_outside_budget,1);
  assert.equal(result.exclusions.below_multiplier_threshold,1);
  assert.equal(result.exclusions.not_currently_held,1);
});

test("shows a trader-specific 30-day combo record when supplied", () => {
  const result = buildComboOpportunities([
    active(),
    active({combo_position_id:"won",status:"RESOLVED_WIN",resolved_at:now/1000-100,entry_cost_usdc:10,current_size:0}),
    active({combo_position_id:"lost",status:"RESOLVED_LOSS",resolved_at:now/1000-200,entry_cost_usdc:10,current_size:0}),
  ], {nowMs:now});
  assert.deepEqual(result.opportunities[0].traderComboRecord,{wallet,wins:1,losses:1,partial:0,resolved:2,winRate:0.5,lookbackDays:30});
});
