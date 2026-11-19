import test from "node:test";
import assert from "node:assert/strict";
import { buildConsensusSignals } from "./consensus.js";

const now = 1796000000;
const condition = "0x" + "a".repeat(64);
const market = (overrides = {}) => ({
  conditionId: condition, title:"Team vs Team", slug:"team-vs-team", eventId:"event-1",
  active:true, enableOrderBook:true, closed:false, endDate:new Date((now+12*3600)*1000).toISOString(),
  category:"Sports", tags:["NBA"],
  clobTokenIds:["yes-token","no-token"], outcomes:["Yes","No"],
  ...overrides,
});
function audit(wallet, tokenId="yes-token", usdSize=12, qualified=true) {
  return {
    wallet, complete:true,
    qualification:{qualified},
    recentBuys:[{
      conditionId:condition, tokenId, timestamp:now-120,
      usdSize, size:20, price:.6,
    }],
    currentPositions:[{conditionId:condition,tokenId,currentSize:20}],
  };
}

test("creates a signal from eight qualified wallets buying the same outcome", () => {
  const results = Array.from({length:8},(_,i)=>audit(`wallet-${i}`));
  const result = buildConsensusSignals({
    complete:true, results,
  }, new Map([[condition,market()]]), {nowSeconds:now});
  assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].qualifiedWalletCount,8);
  assert.equal(result.signals[0].outcome,"Yes");
  assert.equal(result.signals[0].totalUsd,96);
});

test("excludes a market if qualified wallets bought both outcomes", () => {
  const results = [
    ...Array.from({length:8},(_,i)=>audit(`wallet-${i}`)),
    audit("opposite-wallet","no-token",25),
  ];
  const result = buildConsensusSignals({complete:true,results},new Map([[condition,market()]]),{nowSeconds:now});
  assert.equal(result.signals.length,0);
  assert.equal(result.exclusions.mixed_outcomes_in_market,1);
});

test("only qualified wallets with at least ten dollars count", () => {
  const results = [
    ...Array.from({length:7},(_,i)=>audit(`wallet-${i}`)),
    audit("unqualified","yes-token",100,false),
    audit("small-position","yes-token",9),
  ];
  const result = buildConsensusSignals({complete:true,results},new Map([[condition,market()]]),{nowSeconds:now});
  assert.equal(result.signals.length,0);
  assert.equal(result.exclusions.insufficient_qualified_wallets,1);
});

test("requires open market, allowed category and resolution within 24 hours", () => {
  const results = Array.from({length:8},(_,i)=>audit(`wallet-${i}`));
  const tooLate = market({endDate:new Date((now+25*3600)*1000).toISOString()});
  const political = market({category:"Politics",tags:["Election"]});
  const closed = market({closed:true});
  for (const m of [tooLate,political,closed]) {
    const result = buildConsensusSignals({complete:true,results},new Map([[condition,m]]),{nowSeconds:now});
    assert.equal(result.signals.length,0);
  }
});

test("ignores stale or future-invalid buy records and rejects incomplete audit batches", () => {
  const results = Array.from({length:8},(_,i)=>audit(`wallet-${i}`));
  for (const row of results) row.recentBuys[0].timestamp = now - 61*60;
  const result = buildConsensusSignals({complete:true,results},new Map([[condition,market()]]),{nowSeconds:now});
  assert.equal(result.signals.length,0);
  assert.throws(() => buildConsensusSignals({complete:false,results},new Map()),/complete wallet audit batch/);
});

test("does not publish duplicate market representations within one event", () => {
  const secondCondition = "0x" + "c".repeat(64);
  const results = Array.from({length:8},(_,i)=>({
    wallet:`wallet-${i}`, complete:true, qualification:{qualified:true},
    recentBuys:[
      {conditionId:condition,tokenId:"yes-token",timestamp:now-120,size:20,usdSize:12},
      {conditionId:secondCondition,tokenId:"yes-token-2",timestamp:now-120,size:20,usdSize:12},
    ],
    currentPositions:[
      {conditionId:condition,tokenId:"yes-token",currentSize:20},
      {conditionId:secondCondition,tokenId:"yes-token-2",currentSize:20},
    ],
  }));
  const first = market();
  const second = market({
    conditionId:secondCondition,
    slug:"team-vs-team-duplicate",
    clobTokenIds:["yes-token-2","no-token-2"],
  });
  const result = buildConsensusSignals(
    {complete:true,results},
    new Map([[condition,first],[secondCondition,second]]),
    {nowSeconds:now},
  );
  assert.equal(result.signals.length,1);
  assert.equal(result.exclusions.duplicate_market_representation,1);
});

test("requires the recent BUY token to remain in current holdings", () => {
  const results = Array.from({length:8},(_,i)=>({
    ...audit(`wallet-${i}`), currentPositions:[],
  }));
  const result = buildConsensusSignals({complete:true,results},new Map([[condition,market()]]),{nowSeconds:now});
  assert.equal(result.signals.length,0);
  assert.equal(result.exclusions.recent_buy_not_currently_held,8);
});

test("excludes a market when a recent buyer currently holds both outcomes", () => {
  const results = Array.from({length:8},(_,i)=>audit(`wallet-${i}`));
  results[0].currentPositions.push({conditionId:condition,tokenId:"no-token",currentSize:5});
  const result = buildConsensusSignals({complete:true,results},new Map([[condition,market()]]),{nowSeconds:now});
  assert.equal(result.signals.length,0);
  assert.equal(result.exclusions.mixed_current_holdings,1);
});
