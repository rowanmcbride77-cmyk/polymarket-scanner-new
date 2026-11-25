import test from "node:test";
import assert from "node:assert/strict";
import { checkpointResumeOffset, hasTerminalAuditResults, incompleteCheckpointIndexesForExpandedHistory, isReusableCheckpoint } from "./qualify.js";

test("checkpoint resumes after all saved results, including earlier incomplete audits", () => {
  const checkpoint = {
    results: [
      { wallet: "w1", complete: true },
      { wallet: "w2", complete: false, error: "pagination page limit" },
      { wallet: "w3", complete: true },
    ],
    nextOffset: 3,
  };
  assert.equal(checkpointResumeOffset(checkpoint), 3);
});

test("all terminal wallet results can publish while incomplete wallets remain excluded", () => {
  const batch = {
    complete: true,
    allAuditsComplete: false,
    results: [
      { wallet: "w1", complete: true },
      { wallet: "w2", complete: false, error: "pagination page limit" },
    ],
  };
  assert.equal(hasTerminalAuditResults(batch, 2), true);
});

test("a batch without a terminal result for every candidate cannot publish", () => {
  const batch = { complete: false, results: [{ wallet: "w1", complete: true }] };
  assert.equal(hasTerminalAuditResults(batch, 2), false);
});

test("expanded position history retries only previously incomplete checkpoint rows", () => {
  const checkpoint = {
    positionMaxPages: 10,
    results: [
      { wallet: "w1", complete: true },
      { wallet: "w2", complete: false },
      { wallet: "w3", complete: true },
      { wallet: "w4", complete: false },
    ],
  };
  assert.deepEqual(incompleteCheckpointIndexesForExpandedHistory(checkpoint, 30), [1, 3]);
  assert.deepEqual(incompleteCheckpointIndexesForExpandedHistory(checkpoint, 10), []);
  assert.deepEqual(incompleteCheckpointIndexesForExpandedHistory(checkpoint, 5), []);
});


test("pauses the endpoint lane after a 429 Retry-After response", async () => {
  let clock = 0;
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => ({
    status: ++calls === 1 ? 429 : 200,
    headers: { get: (name) => name.toLowerCase() === "retry-after" ? "0.5" : null },
  });
  const sleep = async (ms) => { waits.push(ms); clock += ms; };
  const { createPacedFetch } = await import("./qualify.js");
  const pacedFetch = createPacedFetch({
    fetchImpl, sleep, intervalMs: 0, now: () => clock, retryAfterSafetyMs: 100,
  });

  const url = "https://data-api.polymarket.com/v2/positions";
  assert.equal((await pacedFetch(url)).status, 429);
  assert.equal((await pacedFetch(url)).status, 200);
  assert.equal(calls, 2);
  assert.ok(clock >= 600);
  assert.deepEqual(waits, [600]);
});

test("a 429 on one endpoint does not block a different endpoint", async () => {
  let clock = 0;
  let calls = 0;
  const { createPacedFetch } = await import("./qualify.js");
  const pacedFetch = createPacedFetch({
    fetchImpl: async () => ({
      status: ++calls === 1 ? 429 : 200,
      headers: { get: (name) => name.toLowerCase() === "retry-after" ? "5" : null },
    }),
    sleep: async (ms) => { clock += ms; },
    intervalMs: 0,
    now: () => clock,
    retryAfterSafetyMs: 0,
  });

  await pacedFetch("https://data-api.polymarket.com/v2/positions");
  await pacedFetch("https://data-api.polymarket.com/v2/tokens");
  assert.equal(clock, 0);
  assert.equal(calls, 2);
});

test("legacy 20K checkpoints cannot be reused for the Top 1,000 audit", () => {
  const legacy = {
    schemaVersion: 3, candidateCount: 20000, auditLimit: 20000,
    nowSeconds: 1795545600, nextOffset: 1000,
    results: Array.from({ length: 1000 }, (_, index) => ({
      wallet: "0x" + index.toString(16).padStart(40, "0"), complete: true,
    })),
  };
  assert.equal(isReusableCheckpoint(legacy, 1000, "leaderboard-snapshot-1"), false);
});

test("Top 1,000 checkpoints resume only for the exact same source snapshot", () => {
  const snapshot = "2026-11-24T12:00:00.000Z";
  const base = {
    schemaVersion: 4, auditUniverseGeneratedAt: snapshot,
    candidateCount: 1000, auditLimit: 1000,
    nowSeconds: 1795545600, nextOffset: 1,
    results: [{ wallet: "0x" + "1".repeat(40), complete: true }],
  };
  assert.equal(isReusableCheckpoint(base, 1000, snapshot), true);
  assert.equal(isReusableCheckpoint(base, 1000, "different-snapshot"), false);
  assert.equal(isReusableCheckpoint({ ...base, nextOffset: 0 }, 1000, snapshot), false);
  assert.equal(isReusableCheckpoint({ ...base, results: [{ wallet: "bad" }] }, 1000, snapshot), false);
  assert.equal(isReusableCheckpoint({
    ...base, results: [base.results[0], base.results[0]], nextOffset: 2,
  }, 1000, snapshot), false);
  assert.equal(isReusableCheckpoint({ ...base, auditLimit: 20000 }, 1000, snapshot), false);
});
