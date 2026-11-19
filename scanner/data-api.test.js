import test from "node:test";
import assert from "node:assert/strict";
import { createDataApiClient, DataApiError } from "./data-api.js";

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
  };
}

test("uses the v2 data envelope and cursor pagination without offset", async () => {
  const urls = [];
  const client = createDataApiClient({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return jsonResponse({
        data: [{ id: 1 }],
        pagination: { next_cursor: null, has_more: false },
      });
    },
  });
  const result = await client.collectPages("/v2/trades", { user: "0xabc", start: 1 });
  assert.deepEqual(result.rows, [{ id: 1 }]);
  assert.equal(result.complete, true);
  assert.equal(urls[0].pathname, "/v2/trades");
  assert.equal(urls[0].searchParams.get("user"), "0xabc");
  assert.equal(urls[0].searchParams.get("start"), "1");
  assert.equal(urls[0].searchParams.has("offset"), false);
});

test("walks every cursor page and reuses the exact query filters", async () => {
  const urls = [];
  const client = createDataApiClient({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      urls.push(parsed);
      if (!parsed.searchParams.has("cursor")) {
        return jsonResponse({ data: [{ id: "a" }], pagination: { next_cursor: "cursor-1", has_more: true } });
      }
      assert.equal(parsed.searchParams.get("user"), "0xwallet");
      return jsonResponse({ data: [{ id: "b" }], pagination: { next_cursor: null, has_more: false } });
    },
  });
  const result = await client.collectPages("/v2/activity", { user: "0xwallet", type: "TRADE" });
  assert.deepEqual(result.rows.map((row) => row.id), ["a", "b"]);
  assert.equal(result.pages, 2);
  assert.equal(urls[1].searchParams.get("cursor"), "cursor-1");
  assert.equal(urls[1].searchParams.get("type"), "TRADE");
});

test("fails closed when the API reports more data without a cursor", async () => {
  const client = createDataApiClient({
    fetchImpl: async () => jsonResponse({ data: [], pagination: { next_cursor: null, has_more: true } }),
  });
  await assert.rejects(
    client.collectPages("/v2/trades"),
    (error) => error instanceof DataApiError && /no next_cursor/.test(error.message),
  );
});

test("fails closed on a repeated cursor", async () => {
  const client = createDataApiClient({
    fetchImpl: async () => jsonResponse({ data: [], pagination: { next_cursor: "same", has_more: true } }),
  });
  await assert.rejects(
    client.collectPages("/v2/trades"),
    (error) => error instanceof DataApiError && /Repeated pagination cursor/.test(error.message),
  );
});

test("honors Retry-After for rate limits", async () => {
  let calls = 0;
  const delays = [];
  const client = createDataApiClient({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: "busy" }, 429, { "retry-after": "20" })
        : jsonResponse({ data: { ok: true } });
    },
    sleep: async (ms) => delays.push(ms),
  });
  const body = await client.getJson("/v2/user-stats", { user: "0xabc" });
  assert.equal(body.data.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [20000]);
});

test("does not interpret missing data as an empty success", async () => {
  const client = createDataApiClient({ fetchImpl: async () => jsonResponse({ rows: [] }) });
  await assert.rejects(client.getJson("/v2/trades"), /expected a data field/);
});

test("stops when API explicitly reports has_more false", async () => {
  const client = createDataApiClient({
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: 1 }],
      pagination: { has_more: false, next_cursor: "terminal-cursor" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await client.collectPages("/v2/leaderboard", {});
  assert.equal(result.complete, true);
  assert.equal(result.pages, 1);
  assert.equal(result.rows.length, 1);
});
