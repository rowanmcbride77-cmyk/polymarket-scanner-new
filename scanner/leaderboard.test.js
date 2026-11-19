import test from "node:test";
import assert from "node:assert/strict";
import { fetchLeaderboardPartition, discoverLeaderboardCandidates } from "./leaderboard.js";

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    async collectPages(path, params, options) {
      calls.push({ path, params, options });
      const key = `${params.time_period}:${params.category}`;
      const value = pages[key];
      if (value instanceof Error) throw value;
      return { rows: value ?? [], pages: 1, complete: true };
    },
  };
}

const row = (wallet, rank = 1) => ({
  user_id: wallet, rank, user_name: "trader", pnl: 125.5,
  volume: 900, verified: true, profile_image: null, x_username: null,
});

test("leaderboard partition validates v2 schema and normalizes wallet", async () => {
  const client = fakeClient({ "week:sports": [row("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")] });
  const result = await fetchLeaderboardPartition(client, {
    timePeriod: "week", category: "sports", limit: 1000,
  });
  assert.equal(result.rows[0].wallet, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(result.rows[0].volumeShares, 900);
  assert.equal(result.complete, true);
  assert.equal(client.calls[0].params.sort_by, "PNL");
});

test("malformed rows fail closed rather than publishing a partial partition", async () => {
  const client = fakeClient({ "month:crypto": [row("not-a-wallet")] });
  await assert.rejects(
    fetchLeaderboardPartition(client, { timePeriod: "month", category: "crypto" }),
    /malformed rows/,
  );
});

test("discovery combines sports, esports and crypto across week and month", async () => {
  const shared = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const unique = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const client = fakeClient({
    "week:sports": [row(shared)],
    "week:esports": [row(unique)],
    "week:crypto": [],
    "month:sports": [row(shared, 2)],
    "month:esports": [],
    "month:crypto": [],
  });
  const result = await discoverLeaderboardCandidates({ client });
  assert.equal(result.complete, true);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.find(x => x.wallet === shared).appearances.length, 2);
  assert.equal(client.calls.length, 6);
  assert.ok(client.calls.every(x => !("offset" in x.params)));
});

test("politics and unsupported windows are rejected", async () => {
  const client = fakeClient({});
  await assert.rejects(fetchLeaderboardPartition(client, {
    timePeriod: "week", category: "politics",
  }), /Unsupported discovery category/);
  await assert.rejects(fetchLeaderboardPartition(client, {
    timePeriod: "all", category: "sports",
  }), /timePeriod must be week or month/);
});
