import test from "node:test";
import assert from "node:assert/strict";
import { validatePublishedOutput } from "./validate-output.js";

const qualified = {
  wallet:"0x" + "a".repeat(40),
  summary:{integrityPassed:true,resolvedMarkets:20,wins:19,losses:1,winRate:0.95,earlyExitCount:0,earlyExitRate:0},
};
function fixtures() {
  const trader = {
    wallet:qualified.wallet, rank:1, winRate:0.95, resolvedMarkets:20, wins:19, losses:1, leaderboardPnl:100,
  };
  const weekly = {schemaVersion:1,validation:{passed:true},count:1,traders:[trader]};
  const monthly = {schemaVersion:1,validation:{passed:true},count:1,traders:[trader]};
  const qualification = {
    schemaVersion:1,
    qualification:{minimumResolvedMarkets:10,minimumWinRate:0.9,maximumEarlyExitRate:0.2,lookbackDays:30,earlyExitsCounted:false,settlementIntegrityRequired:true},
    validation:{
      passed:true,allWalletAuditsComplete:true,discoveredWallets:1,auditedWallets:1,qualifiedWallets:1,
    },qualifiedWallets:[qualified],
  };
  const consensus = {
    schemaVersion:1,validation:{passed:true},signalCount:1,
    thresholds:{windowMinutes:60,maxResolutionHours:24,minWallets:8,minUsdPerWallet:10,requireCurrentHoldings:true,sameSideOnly:true,excludeDuplicateRepresentations:true},
    combos:{
      validation:{passed:true,complete:true,failedWallets:0},
      thresholds:{minEntryUsd:5,maxEntryUsd:100,minMultiplier:10,requireCurrentHolding:true,recordLookbackDays:30,traderWinRateRequired:false},
      opportunities:[{
        wallet:"0x"+"b".repeat(40),comboPositionId:"combo-1",status:"OPEN",
        entryCostUsd:10,potentialPayoutUsd:120,multiplier:12,legs:[],
        traderComboRecord:{wins:1,losses:2,partial:0,resolved:3,winRate:1/3},
      }],
    },
    signals:[{
      category:"sports",conditionId:"0xcondition",tokenId:"token-1",outcome:"Yes",
      minutesToResolution:60,endDate:"2026-11-19T06:00:00.000Z",
      qualifiedWalletCount:8,totalUsd:100,eventId:"event-1",marketTitle:"Team vs Team",
      wallets:Array.from({length:8},(_,i)=>({
        wallet:`0x${String(i+1).padStart(40,"0")}`,usdSize:12.5,
      })),
    }],
  };
  const status = {
    schemaVersion:1,validation:{passed:true},state:"success",
    discoveredWallets:1,auditedWallets:1,qualifiedWallets:1,
    consensusCount:1,comboCount:1,weeklyCount:1,monthlyCount:1,
  };
  return {qualification,weekly,monthly,consensus,status};
}

test("accepts a fully qualified, same-side consensus output", () => {
  assert.equal(validatePublishedOutput(fixtures()).passed,true);
});

test("rejects a leaderboard row below win-rate qualification", () => {
  const data=fixtures();
  data.weekly.traders[0].winRate=0.89;
  assert.throws(()=>validatePublishedOutput(data),/weekly qualification threshold/);
});

test("rejects consensus with fewer than eight qualified wallets", () => {
  const data=fixtures();
  data.consensus.signals[0].qualifiedWalletCount=7;
  data.consensus.signals[0].wallets=data.consensus.signals[0].wallets.slice(0,7);
  assert.throws(()=>validatePublishedOutput(data),/consensus market or threshold/);
});

test("rejects duplicate participants in one signal", () => {
  const data=fixtures();
  data.consensus.signals[0].wallets[1].wallet=data.consensus.signals[0].wallets[0].wallet;
  assert.throws(()=>validatePublishedOutput(data),/consensus participant threshold or duplicate/);
});
