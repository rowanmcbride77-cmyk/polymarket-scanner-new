const TERMINAL = new Set(["RESOLVED_WIN", "RESOLVED_LOSS", "RESOLVED_PARTIAL"]);
const HELD = new Set(["OPEN", "REDEEMABLE", "PARTIAL"]);

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function entryCost(row) {
  return positive(row.entry_cost_usdc) ?? positive(row.gross_entry_cost_usdc);
}

function resolvedAt(row) {
  const values = [row.resolved_at, row.resolvedAt];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    const millis = Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(String(value));
    if (Number.isFinite(millis) && millis > 0) return millis;
  }
  const legTimes = (Array.isArray(row.legs) ? row.legs : [])
    .map((leg) => Date.parse(String(leg?.leg_resolved_at ?? "")))
    .filter(Number.isFinite);
  return TERMINAL.has(String(row.status ?? "").toUpperCase()) && legTimes.length
    ? Math.max(...legTimes) : null;
}

function comboRecord(rows, wallet, nowMs) {
  const cutoff = nowMs - 30 * 24 * 60 * 60 * 1000;
  const seen = new Set();
  let wins = 0, losses = 0, partial = 0;
  for (const row of rows) {
    const id = String(row.combo_position_id ?? row.combo_condition_id ?? "");
    const status = String(row.status ?? "").toUpperCase();
    const at = resolvedAt(row);
    if (!id || seen.has(id) || !TERMINAL.has(status) || at === null || at < cutoff || at > nowMs) continue;
    seen.add(id);
    if (status === "RESOLVED_WIN") wins++;
    else if (status === "RESOLVED_LOSS") losses++;
    else partial++;
  }
  const resolved = wins + losses;
  return { wallet, wins, losses, partial, resolved, winRate: resolved ? wins / resolved : null, lookbackDays: 30 };
}

function legStartMs(leg) {
  const market = leg?.market ?? {};
  const event = market?.event ?? {};
  for (const value of [market.startDate, market.start_date, event.startDate, event.start_date, leg?.event_start_time]) {
    if (!value) continue;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timing(row, nowMs) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (!legs.length) return { key: "unknown", label: "Event start times unavailable" };
  const starts = legs.map(legStartMs);
  if (starts.some((value) => value === null)) return { key: "unknown", label: "Some event start times unavailable" };
  if (starts.some((value) => value <= nowMs)) return { key: "started", label: "At least one leg has started" };
  return { key: "upcoming", label: "All legs are upcoming" };
}

export function buildComboOpportunities(rows, {
  nowMs = Date.now(),
  maxEntryUsd = 100,
  minEntryUsd = 5,
  minMultiplier = 10,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("Combo rows must be an array");
  if (![nowMs, maxEntryUsd, minEntryUsd, minMultiplier].every(Number.isFinite) ||
      minEntryUsd < 0 || maxEntryUsd < minEntryUsd || minMultiplier <= 0) {
    throw new TypeError("Invalid combo opportunity thresholds");
  }

  const unique = new Map();
  for (const row of rows) {
    const wallet = String(row?._wallet ?? row?.proxy_wallet ?? "").toLowerCase();
    const id = String(row?.combo_position_id ?? row?.combo_condition_id ?? "");
    if (!/^0x[a-f0-9]{40}$/.test(wallet) || !id) continue;
    const key = wallet + ":" + id;
    const previous = unique.get(key);
    // Prefer the active/open snapshot when the same combo appears in both feeds.
    if (!previous || HELD.has(String(row.status ?? "").toUpperCase())) unique.set(key, row);
  }

  const allRows = [...unique.values()];
  const historyByWallet = new Map();
  for (const row of allRows) {
    const wallet = String(row._wallet ?? row.proxy_wallet).toLowerCase();
    if (!historyByWallet.has(wallet)) historyByWallet.set(wallet, []);
    historyByWallet.get(wallet).push(row);
  }

  const opportunities = [];
  const excluded = {};
  const count = (key) => { excluded[key] = (excluded[key] ?? 0) + 1; };
  for (const row of allRows) {
    const wallet = String(row._wallet ?? row.proxy_wallet).toLowerCase();
    const status = String(row.status ?? "").toUpperCase();
    if (!HELD.has(status) || !(Number(row.current_size) > 0)) { count("not_currently_held"); continue; }
    const entry = entryCost(row);
    if (entry === null) { count("entry_cost_unavailable"); continue; }
    if (entry < minEntryUsd || entry > maxEntryUsd) { count("entry_outside_budget"); continue; }
    // Polymarket combo shares pay $1 per share if every leg wins. The current
    // size is the maximum gross payout, not profit. Never use undocumented
    // potential-payout fields that can inflate the multiple.
    const potentialPayout = positive(row.current_size);
    const multiplier = potentialPayout === null ? null : potentialPayout / entry;
    if (multiplier === null || multiplier < minMultiplier) { count("below_multiplier_threshold"); continue; }
    const legs = Array.isArray(row.legs) ? row.legs : [];
    const time = timing(row, nowMs);
    const record = comboRecord(historyByWallet.get(wallet) ?? [], wallet, nowMs);
    opportunities.push({
      wallet,
      username: row._username ?? row.username ?? null,
      comboPositionId: String(row.combo_position_id ?? row.combo_condition_id),
      status,
      entryCostUsd: entry,
      shares: Number(row.current_size),
      potentialPayoutUsd: potentialPayout,
      potentialProfitUsd: potentialPayout - entry,
      multiplier,
      legCount: Number.isInteger(row.legs_total) ? row.legs_total : legs.length,
      legs: legs.map((leg, index) => ({
        index: Number.isInteger(leg.leg_index) ? leg.leg_index : index + 1,
        title: leg.market?.question ?? leg.market?.title ?? leg.market?.event?.event_title ?? "Market leg",
        outcome: leg.leg_outcome_label ?? leg.market?.outcome ?? null,
        status: leg.leg_status ?? null,
        eventSlug: leg.market?.event?.event_slug ?? null,
        startTime: legStartMs(leg) === null ? null : new Date(legStartMs(leg)).toISOString(),
      })),
      timing: time,
      traderComboRecord: record,
    });
  }
  opportunities.sort((a, b) => b.multiplier - a.multiplier || a.entryCostUsd - b.entryCostUsd);
  return {
    opportunities,
    scannedWallets: new Set(allRows.map((row) => String(row._wallet ?? row.proxy_wallet).toLowerCase())).size,
    thresholds: { minEntryUsd, maxEntryUsd, minMultiplier, requireCurrentHolding: true, recordLookbackDays: 30, traderWinRateRequired: false },
    exclusions: excluded,
  };
}

export async function fetchWalletCombos(client, wallet, {
  maxPages = 3,
  limit = 1000,
} = {}) {
  const base = { user: wallet, limit, sort_by: "UPDATED", sort_direction: "DESC" };
  const [held, resolved] = await Promise.all([
    client.collectPages("/v2/positions/combos", base, { maxPages }),
    client.collectPages("/v2/positions/combos", {
      ...base, status: "RESOLVED_WIN,RESOLVED_LOSS,RESOLVED_PARTIAL",
    }, { maxPages }),
  ]);
  const byId = new Map();
  for (const row of [...held.rows, ...resolved.rows]) {
    const id = String(row.combo_position_id ?? row.combo_condition_id ?? "");
    if (id) byId.set(id, { ...row, _wallet: wallet.toLowerCase() });
  }
  return { rows: [...byId.values()], complete: held.complete && resolved.complete, pages: held.pages + resolved.pages };
}
