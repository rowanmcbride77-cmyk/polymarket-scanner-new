import test from "node:test";
import assert from "node:assert/strict";
import { fetchLeaderboardPartition, discoverLeaderboardCandidates } from "./leaderboard.js";

function fakeClient(pages) {
  const calls = [];
  function key(params) { return `${params.time_period}:${params.category}`; }
  return {
    calls,
    async collectPages(path, params, options) {
      calls.push({ path, params, options, mode: "collect" });
      const value = pages[key(params)];
      if (value instanceof Error) throw value;
      const rows = Array.isArray(value) && value.length && value[0]?.rows
        ? value.flatMap(page => page.rows) : (value ?? []);
      return { rows, pages: 1, complete: true };
    },
    async getPage(path, params, cursor) {
      calls.push({ path, params, cursor, mode: "page" });
      const value = pages[key(params)] ?? [];
      const pageIndex = cursor ? Number(cursor.replace("page-", "")) : 0;
      if (Array.isArray(value) && value.length && value[0]?.rows) {
        const page = value[pageIndex] ?? { rows: [], hasMore: false, nextCursor: null };
        return {
          rows: page.rows,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor ?? null,
        };
      }
      return { rows: value, hasMore: false, nextCursor: null };
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

test("discovery defaults to the overall monthly leaderboard", async () => {
  const shared = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const unique = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const client = fakeClient({
    "month:overall": [row(shared), row(unique, 2)],
  });
  const result = await discoverLeaderboardCandidates({ client });
  assert.equal(result.complete, true);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.find(x => x.wallet === shared).appearances.length, 1);
  assert.equal(client.calls.filter(x => x.mode === "page").length, 1);
  assert.equal(client.calls[0].params.category, "overall");
  assert.equal(client.calls[0].params.time_period, "month");
  assert.ok(client.calls.every(x => !("offset" in x.params)));
});

test("discovery follows opaque cursors and caps pages per partition", async () => {
  const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const client = fakeClient({
    "week:sports": [
      { rows: [row(a)], hasMore: true, nextCursor: "page-1" },
      { rows: [row(b, 2)], hasMore: true, nextCursor: "page-2" },
      { rows: [], hasMore: false, nextCursor: null },
    ],
  });
  const result = await discoverLeaderboardCandidates({
    client, categories: ["sports"], periods: ["week"],
    maxCandidates: 100, maxPagesPerPartition: 2,
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.partitions[0].pages, 2);
  assert.equal(result.partitions[0].truncated, true);
  assert.equal(client.calls[1].cursor, "page-1");
});

test("politics and unsupported windows are rejected", async () => {
  const client = fakeClient({});
  await assert.rejects(discoverLeaderboardCandidates({
    client, categories: ["politics"],
  }), /Unsupported discovery category/);
  await assert.rejects(fetchLeaderboardPartition(client, {
    timePeriod: "all", category: "sports",
  }), /timePeriod must be week or month/);
});
