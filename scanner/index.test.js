import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryPayload } from "./index.js";

test("discovery payload records complete partitions and candidate counts", () => {
  const payload = buildDiscoveryPayload({
    complete: true,
    candidates: [{ wallet: "0xabc" }],
    maxCandidates: 1000,
    partitions: [{ category: "sports", timePeriod: "week", pages: 1, rowCount: 1, complete: true }],
  }, "2026-11-18T00:00:00.000Z");
  assert.equal(payload.validation.passed, true);
  assert.equal(payload.validation.candidateCount, 1);
  assert.equal(payload.scope.maxCandidates, 1000);
  assert.equal(payload.validation.maxCandidates, 1000);
  assert.equal(payload.generatedAt, "2026-11-18T00:00:00.000Z");
});

test("discovery refuses incomplete partitions and never builds a publishable Top 100", () => {
  assert.throws(() => buildDiscoveryPayload({
    complete: false, candidates: [], partitions: [],
  }), /incomplete/);
  const payload = buildDiscoveryPayload({ complete: true, candidates: [], partitions: [] });
  assert.equal(payload.validation.allPageRequestsComplete, true);
  assert.equal(payload.scope.maxCandidates, 1000);
  assert.equal("top100" in payload, false);
});
