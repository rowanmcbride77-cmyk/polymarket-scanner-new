import { createDataApiClient } from "./data-api.js";

const TOKEN_ID_RE = /^\d+$/;

async function mapLimit(items, concurrency, worker, onProgress) {
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
      completed += 1;
      if (onProgress) await onProgress({ stage: "shared_token_facts", completed, total: items.length });
    }
  }));
}

export async function fetchTokenFacts(client, tokenIds, {
  batchSize = 50,
  concurrency = 8,
  onProgress,
} = {}) {
  if (!Array.isArray(tokenIds)) throw new TypeError("tokenIds must be an array");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new RangeError("batchSize must be 1..50");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("token lookup concurrency must be 1..16");
  }
  const unique = [...new Set(tokenIds.map(String))];
  if (unique.some((id) => !TOKEN_ID_RE.test(id))) throw new TypeError("Invalid CLOB token id");
  const batches = [];
  for (let i = 0; i < unique.length; i += batchSize) batches.push(unique.slice(i, i + batchSize));
  const facts = new Map();
  await mapLimit(batches, concurrency, async (batch) => {
    const body = await client.getJson("/v2/tokens", { token_id: batch.join(",") });
    if (body.data !== null && !Array.isArray(body.data)) throw new Error("Token lookup returned a malformed data envelope");
    for (const token of (body.data ?? [])) {
      if (!token || typeof token.token_id !== "string" ||
          typeof token.resolved !== "boolean" ||
          (token.final_price !== null && !Number.isFinite(token.final_price))) {
        throw new Error("Token lookup returned malformed resolution facts");
      }
      facts.set(token.token_id, {
        tokenId: token.token_id,
        conditionId: token.condition_id,
        outcomeIndex: token.outcome_index,
        outcome: token.outcome ?? null,
        resolved: token.resolved,
        final_price: token.final_price,
        title: token.title ?? null,
        category: token.category ?? null,
      });
    }
  }, onProgress);
  return facts;
}

export function requireTokenFact(facts, tokenId) {
  const fact = facts.get(String(tokenId));
  if (!fact) throw new Error("Missing token resolution fact for token " + tokenId);
  return fact;
}
