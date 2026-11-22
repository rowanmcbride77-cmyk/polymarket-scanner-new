import { createDataApiClient } from "./data-api.js";

function parseResolvedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : NaN;
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
      const numeric = Number(value);
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    return Date.parse(value);
  }
  return NaN;
}

async function mapLimit(items, concurrency, worker, onProgress) {
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
      completed += 1;
      if (onProgress) await onProgress({ stage: "shared_market_resolutions", completed, total: items.length });
    }
  }));
}

export async function fetchMarketResolutions(client, conditionIds, {
  batchSize = 20,
  concurrency = 8,
  onProgress,
} = {}) {
  if (!Array.isArray(conditionIds)) throw new TypeError("conditionIds must be an array");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new RangeError("resolution batchSize must be 1..20");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("resolution lookup concurrency must be 1..16");
  }
  const ids = [...new Set(conditionIds.map((id) => String(id).toLowerCase()))];
  const requested = new Set(ids);
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
  const result = new Map();
  await mapLimit(batches, concurrency, async (batch) => {
    const body = await client.getJson("/v2/resolutions", { condition: batch.join(",") });
    if (body.data !== null && !Array.isArray(body.data)) {
      throw new Error("Resolution lookup returned malformed data envelope");
    }
    for (const row of (body.data ?? [])) {
      if (!row || typeof row !== "object") continue;
      const status = String(row.status ?? "").toLowerCase();
      if (status !== "resolved") continue;
      const conditionId = row.condition_id ?? row.conditionId;
      if (typeof conditionId !== "string" || !requested.has(conditionId.toLowerCase())) continue;
      const timestamp = parseResolvedAt(row.resolved_at ?? row.resolvedAt);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
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
  }, onProgress);
  return result;
}

export function createResolutionService(client = createDataApiClient()) {
  return { fetchMarketResolutions: (conditionIds, options) =>
    fetchMarketResolutions(client, conditionIds, options) };
}
