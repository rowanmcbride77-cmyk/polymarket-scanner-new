import { createDataApiClient } from "./data-api.js";

export async function fetchMarketResolutions(client, conditionIds, { batchSize = 20 } = {}) {
  if (!Array.isArray(conditionIds)) throw new TypeError("conditionIds must be an array");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new RangeError("batchSize must be 1..20");
  }
  const ids = [...new Set(conditionIds.map(String))];
  const result = new Map();
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const body = await client.getJson("/v2/resolutions", { condition: batch.join(",") });
    if (body.data !== null && !Array.isArray(body.data)) throw new Error("Resolution lookup returned malformed data envelope");
    for (const row of (body.data ?? [])) {
      const conditionId = row.condition_id ?? row.conditionId;
      const status = String(row.status ?? "").toLowerCase();
      if (status !== "resolved") continue;
      const resolvedAt = row.resolved_at ?? row.resolvedAt;
      const timestamp = resolvedAt ? Date.parse(resolvedAt) : NaN;
      if (typeof conditionId !== "string" || !Number.isFinite(timestamp)) {
        throw new Error("Resolution lookup returned malformed condition or resolved_at");
      }
      if (status === "resolved") {
        result.set(conditionId.toLowerCase(), {
          conditionId: conditionId.toLowerCase(),
          status,
          resolvedAt: new Date(timestamp).toISOString(),
          resolvedAtSeconds: Math.floor(timestamp / 1000),
          payouts: Array.isArray(row.payouts) ? row.payouts : null,
          wasDisputed: row.was_disputed ?? row.wasDisputed ?? null,
          wasArbitrated: row.was_arbitrated ?? row.wasArbitrated ?? null,
          transactionHash: row.transaction_hash ?? row.transactionHash ?? null,
        });
      }
    }
  }
  return result;
}
