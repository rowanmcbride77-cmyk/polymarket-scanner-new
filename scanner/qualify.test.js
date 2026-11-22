import test from "node:test";
import assert from "node:assert/strict";
import { checkpointResumeOffset, hasTerminalAuditResults } from "./qualify.js";

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
