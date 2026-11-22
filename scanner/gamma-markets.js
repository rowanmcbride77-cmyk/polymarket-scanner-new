const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";

function retryDelay(response, attempt) {
  const header = response.headers?.get?.("retry-after");
  if (header !== null && header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15000, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, Math.min(15000, date - Date.now()));
  }
  return Math.min(15000, 500 * (2 ** attempt));
}

export async function fetchGammaMarkets(conditionIds, {
  tokenIds = [],
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  batchSize = 100,
  maxRetries = 4,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  if (!Array.isArray(conditionIds)) throw new TypeError("conditionIds must be an array");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("Gamma batchSize must be 1..100");
  }
  const ids = [...new Set(conditionIds.map((id) => String(id).toLowerCase()))];
  const markets = new Map();

  async function fetchBatches(values, parameter) {
    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      const url = new URL("/markets", baseUrl);
      for (const value of batch) url.searchParams.append(parameter, value);
    url.searchParams.set("limit", String(batch.length));
    url.searchParams.set("include_tag", "true");
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        await sleep(Math.min(15000, 500 * (2 ** attempt)));
        continue;
      }
      if ((response.status === 429 || response.status === 503 || response.status >= 500) &&
          attempt < maxRetries) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      break;
    }
    if (!response.ok) throw new Error(`Gamma API returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Gamma markets response was not an array");
      for (const market of body) {
        const conditionId = market?.conditionId ?? market?.condition_id;
        if (typeof conditionId !== "string") throw new Error("Gamma market is missing conditionId");
        markets.set(conditionId.toLowerCase(), {
        conditionId: conditionId.toLowerCase(),
        title: market.question ?? market.title ?? "",
        slug: market.slug ?? "",
        eventId: market.eventId ?? market.event_id ?? market.events?.[0]?.id ?? null,
        eventSlug: market.eventSlug ?? market.event_slug ?? market.events?.[0]?.slug ?? null,
        endDate: market.endDate ?? market.end_date ?? market.endDateIso ?? null,
        active: market.active === true,
        enableOrderBook: market.enableOrderBook === true,
        closed: typeof market.closed === "boolean" ? market.closed : null,
        category: market.category ?? "",
        tags: Array.isArray(market.tags) ? market.tags : [],
        clobTokenIds: market.clobTokenIds ?? market.clob_token_ids ?? [],
        outcomes: market.outcomes ?? [],
        });
      }
    }
  }

  await fetchBatches(ids, "condition_ids");
  // Some Data API position snapshots expose token identifiers that Gamma can
  // resolve more reliably than condition IDs. Retry by CLOB token ID rather
  // than silently publishing a successful scan with zero market metadata.
  if (markets.size === 0 && tokenIds.length > 0) {
    const tokens = [...new Set(tokenIds.map((id) => String(id)).filter(Boolean))];
    await fetchBatches(tokens, "clob_token_ids");
  }
  if (ids.length > 0 && markets.size === 0) {
    throw new Error(`Gamma returned zero market metadata for ${ids.length} conditions (including token-ID fallback). Refusing to publish empty consensus.`);
  }
  return markets;
}
