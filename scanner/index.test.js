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
  assert.throws(() => buildDiscoveryPayload({
    complete: true, candidates: [], partitions: [],
  }), /no wallets/i);
});

test("discovery refuses duplicate wallets and candidate-cap overflow", () => {
  const partitions = [{ category: "sports", timePeriod: "week", pages: 1, rowCount: 2, complete: true }];
  assert.throws(() => buildDiscoveryPayload({
    complete: true,
    maxCandidates: 2,
    candidates: [{ wallet: "0xabc" }, { wallet: "0xABC" }],
    partitions,
  }), /duplicate wallets/i);
  assert.throws(() => buildDiscoveryPayload({
    complete: true,
    maxCandidates: 1,
    candidates: [{ wallet: "0xabc" }, { wallet: "0xdef" }],
    partitions,
  }), /exceeded its 1-wallet cap/i);
});
