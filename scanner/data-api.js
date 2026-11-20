const DEFAULT_BASE_URL = "https://data-api.polymarket.com";
const RETRYABLE_STATUSES = new Set([429, 503]);

function retryDelayMs(response, attempt, baseDelayMs, maxDelayMs) {
  const header = response.headers?.get?.("retry-after");
  if (header !== null && header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
}

export class DataApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DataApiError";
    Object.assign(this, details);
  }
}

export function createDataApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  maxRetries = 8,
  baseDelayMs = 500,
  maxDelayMs = 60_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  async function getJson(path, params = {}) {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt >= maxRetries) {
          throw new DataApiError("Polymarket Data API request failed", {
            cause: error,
            url: url.toString(),
            retryable: true,
          });
        }
        await sleep(Math.min(maxDelayMs, baseDelayMs * (2 ** attempt)));
        continue;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        clearTimeout(timeout);
        await sleep(retryDelayMs(response, attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch {}
        clearTimeout(timeout);
        throw new DataApiError(
          body?.error || `Polymarket Data API returned HTTP ${response.status}`,
          {
            status: response.status,
            code: body?.code ?? null,
            traceId: body?.trace_id ?? response.headers?.get?.("x-trace-id") ?? null,
            retryable: body?.retryable ?? RETRYABLE_STATUSES.has(response.status),
            url: url.toString(),
          },
        );
      }

      let body;
      try { body = await response.json(); }
      catch (error) {
        clearTimeout(timeout);
        throw new DataApiError("Polymarket Data API returned invalid JSON", {
          cause: error, url: url.toString(), status: response.status,
        });
      }
      clearTimeout(timeout);
      if (!body || typeof body !== "object" || !Object.hasOwn(body, "data")) {
        throw new DataApiError("Unexpected Data API envelope: expected a data field", {
          url: url.toString(), status: response.status,
        });
      }
      return body;
    }
  }

  async function getPage(path, params = {}, cursor = undefined) {
    const body = await getJson(path, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(body.data)) {
      throw new DataApiError("Expected paginated endpoint data to be an array", {
        path, receivedType: body.data === null ? "null" : typeof body.data,
      });
    }
    if (!body.pagination || typeof body.pagination !== "object") {
      throw new DataApiError("Expected pagination metadata on paginated endpoint", { path });
    }
    const nextCursor = body.pagination.next_cursor ?? null;
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new DataApiError("Invalid next_cursor type", { path });
    }
    return { rows: body.data, nextCursor, hasMore: body.pagination.has_more === true };
  }

  async function collectPages(path, params = {}, { maxPages = 10_000, onPage } = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive integer");
    const rows = [];
    const seenCursors = new Set();
    let cursor;
    let pages = 0;
    while (true) {
      if (pages >= maxPages) {
        throw new DataApiError("Pagination page limit reached; history is incomplete", {
          path, pages, complete: false,
        });
      }
      const page = await getPage(path, params, cursor);
      pages += 1;
      rows.push(...page.rows);
      if (onPage) await onPage({ pageNumber: pages, rowCount: page.rows.length, totalRows: rows.length });
      if (!page.hasMore) {
        return { rows, pages, complete: true };
      }
      if (page.nextCursor === null) {
        throw new DataApiError("API reported more data but supplied no next_cursor", {
          path, pages, complete: false,
        });
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new DataApiError("Repeated pagination cursor; refusing an incomplete history", {
          path, pages, complete: false,
        });
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  return { getJson, getPage, collectPages };
}
