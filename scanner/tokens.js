import { createDataApiClient } from "./data-api.js";

const TOKEN_ID_RE = /^\d+$/;

export async function fetchTokenFacts(client, tokenIds, { batchSize = 50 } = {}) {
  if (!Array.isArray(tokenIds)) throw new TypeError("tokenIds must be an array");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new RangeError("batchSize must be 1..50");
  }
  const unique = [...new Set(tokenIds.map(String))];
  if (unique.some((id) => !TOKEN_ID_RE.test(id))) throw new TypeError("Invalid CLOB token id");
  const facts = new Map();
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const body = await client.getJson("/v2/tokens", { token_id: batch.join(",") });
    if (!Array.isArray(body.data)) throw new Error("Token lookup returned a malformed data envelope");
    for (const token of body.data) {
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
  }
  return facts;
}

export function requireTokenFact(facts, tokenId) {
  const fact = facts.get(String(tokenId));
  if (!fact) throw new Error(`Missing token resolution fact for token ${tokenId}`);
  return fact;
}
