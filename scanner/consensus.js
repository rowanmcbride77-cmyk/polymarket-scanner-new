function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tagText(tag) {
  if (typeof tag === "string") return tag.toLowerCase();
  if (tag && typeof tag === "object") {
    return [tag.label, tag.name, tag.slug].filter(Boolean).join(" ").toLowerCase();
  }
  return "";
}

function marketCategory(market) {
  const category = String(market.category ?? "").toLowerCase();
  const tags = (market.tags ?? []).map(tagText);
  const all = [category, market.title ?? "", ...tags].join(" ");
  if (/politic|election|government|congress|senate|president|white house/.test(all)) return null;
  if (/esport/.test(all)) return "esports";
  if (/crypto|bitcoin|ethereum|solana/.test(all)) return "crypto";
  if (/sport|nba|nfl|mlb|nhl|soccer|football|basketball|baseball|hockey/.test(all)) return "sports";
  return null;
}

function count(exclusions, key) {
  exclusions[key] = (exclusions[key] ?? 0) + 1;
}

function normalizeTitle(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildConsensusSignals(auditBatch, marketFacts, {
  nowSeconds = Math.floor(Date.now() / 1000),
  windowMinutes = 60,
  maxResolutionHours = 24,
  minWallets = 8,
  minUsdPerWallet = 10,
} = {}) {
  if (auditBatch?.complete !== true || !Array.isArray(auditBatch.results)) {
    throw new Error("Consensus requires a complete wallet audit batch");
  }
  if (!(marketFacts instanceof Map)) throw new TypeError("marketFacts must be a Map");
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(windowMinutes) ||
      !Number.isInteger(maxResolutionHours) || !Number.isInteger(minWallets) ||
      !Number.isFinite(minUsdPerWallet)) {
    throw new TypeError("Invalid consensus thresholds");
  }

  const cutoff = nowSeconds - windowMinutes * 60;
  const qualified = new Set(auditBatch.results
    .filter((row) => row.complete === true && row.qualification?.qualified === true)
    .map((row) => row.wallet.toLowerCase()));
  const byCondition = new Map();
  const heldByWallet = new Map();
  const exclusions = {};
  const mixedCurrentHoldings = new Set();

  for (const audit of auditBatch.results) {
    const wallet = audit.wallet.toLowerCase();
    if (!qualified.has(wallet)) continue;
    const recentBuys = audit.recentBuys ?? [];
    const heldByCondition = new Map();
    for (const position of audit.currentPositions ?? []) {
      if (!position?.conditionId || !position?.tokenId ||
          !Number.isFinite(position.currentSize) || position.currentSize <= 0) continue;
      const conditionId = String(position.conditionId).toLowerCase();
      const tokens = heldByCondition.get(conditionId) ?? new Set();
      tokens.add(String(position.tokenId));
      heldByCondition.set(conditionId, tokens);
    }
    heldByWallet.set(wallet, heldByCondition);
    for (const buy of recentBuys) {
      if (!buy || !buy.conditionId || !buy.tokenId ||
          !Number.isInteger(buy.timestamp) || buy.timestamp < cutoff ||
          buy.timestamp > nowSeconds || !Number.isFinite(buy.size) || buy.size <= 0 ||
          !Number.isFinite(buy.usdSize) || buy.usdSize <= 0) continue;
      const conditionId = buy.conditionId.toLowerCase();
      const tokenId = String(buy.tokenId);
      const heldTokens = heldByCondition.get(conditionId);
      if (!heldTokens?.has(tokenId)) {
        count(exclusions, "recent_buy_not_currently_held");
        continue;
      }
      const tokens = byCondition.get(conditionId) ?? new Map();
      const walletBuys = tokens.get(tokenId) ?? new Map();
      const existing = walletBuys.get(wallet) ?? { wallet, username: audit.username ?? null, usdSize: 0, buyCount: 0, lastBuyAt: 0 };
      existing.usdSize += buy.usdSize;
      existing.buyCount += 1;
      existing.lastBuyAt = Math.max(existing.lastBuyAt, buy.timestamp);
      walletBuys.set(wallet, existing);
      tokens.set(tokenId, walletBuys);
      byCondition.set(conditionId, tokens);
    }
  }

  for (const [conditionId, tokenGroups] of byCondition) {
    for (const [tokenId, walletBuys] of tokenGroups) {
      for (const [wallet, buy] of walletBuys) {
        if (buy.usdSize < minUsdPerWallet) {
          walletBuys.delete(wallet);
          count(exclusions, "wallet_below_minimum_usd");
        }
      }
      if (walletBuys.size === 0) tokenGroups.delete(tokenId);
    }
    if (tokenGroups.size === 0) {
      byCondition.delete(conditionId);
      continue;
    }
    for (const walletBuys of tokenGroups.values()) {
      for (const [wallet, buy] of walletBuys) {
        if (buy.usdSize >= minUsdPerWallet &&
            (heldByWallet.get(wallet)?.get(conditionId)?.size ?? 0) > 1) {
          mixedCurrentHoldings.add(conditionId);
        }
      }
    }
  }

  const signals = [];
  for (const [conditionId, tokenGroups] of byCondition) {
    if (mixedCurrentHoldings.has(conditionId)) {
      count(exclusions, "mixed_current_holdings");
      continue;
    }
    if (tokenGroups.size !== 1) {
      count(exclusions, "mixed_outcomes_in_market");
      continue;
    }
    const [tokenId, walletBuys] = [...tokenGroups.entries()][0];
    const market = marketFacts.get(conditionId);
    if (!market) { count(exclusions, "missing_market_metadata"); continue; }
    if (market.active !== true || market.enableOrderBook !== true || market.closed !== false) {
      count(exclusions, "market_not_open"); continue;
    }
    const endDateMs = Date.parse(market.endDate ?? "");
    if (!Number.isFinite(endDateMs)) { count(exclusions, "missing_market_end_date"); continue; }
    const secondsToResolution = Math.floor(endDateMs / 1000) - nowSeconds;
    if (secondsToResolution <= 0 || secondsToResolution > maxResolutionHours * 3600) {
      count(exclusions, "outside_24h_resolution_window"); continue;
    }
    const category = marketCategory(market);
    if (!category) { count(exclusions, "excluded_or_unclassified_category"); continue; }

    const tokenIds = parseArray(market.clobTokenIds).map(String);
    if (!tokenIds.length || !tokenIds.includes(tokenId)) {
      count(exclusions, "token_not_in_market"); continue;
    }
    const outcomes = parseArray(market.outcomes);
    const outcomeIndex = tokenIds.indexOf(tokenId);
    if (outcomeIndex < 0 || outcomes[outcomeIndex] === undefined) {
      count(exclusions, "missing_token_outcome"); continue;
    }
    const outcome = String(outcomes[outcomeIndex]);

    const wallets = [...walletBuys.values()]
      .filter((row) => row.usdSize >= minUsdPerWallet)
      .sort((a, b) => b.usdSize - a.usdSize);
    if (wallets.length < minWallets) {
      count(exclusions, "insufficient_qualified_wallets");
      continue;
    }
    signals.push({
      conditionId,
      tokenId,
      outcome,
      marketTitle: market.title,
      marketSlug: market.slug,
      eventId: market.eventId,
      eventSlug: market.eventSlug,
      category,
      endDate: new Date(endDateMs).toISOString(),
      minutesToResolution: Math.round(secondsToResolution / 60),
      qualifiedWalletCount: wallets.length,
      totalUsd: wallets.reduce((sum, row) => sum + row.usdSize, 0),
      wallets,
    });
  }

  signals.sort((a, b) =>
    b.qualifiedWalletCount - a.qualifiedWalletCount ||
    b.totalUsd - a.totalUsd ||
    a.minutesToResolution - b.minutesToResolution);
  const seenRepresentations = new Set();
  const uniqueSignals = [];
  for (const signal of signals) {
    const eventIdentity = signal.eventId ?? signal.eventSlug;
    const titleIdentity = normalizeTitle(signal.marketTitle);
    const duplicateKey = eventIdentity && titleIdentity
      ? `${eventIdentity}:${titleIdentity}` : null;
    if (duplicateKey && seenRepresentations.has(duplicateKey)) {
      count(exclusions, "duplicate_market_representation");
      continue;
    }
    if (duplicateKey) seenRepresentations.add(duplicateKey);
    uniqueSignals.push(signal);
  }
  return {
    signals: uniqueSignals,
    qualifiedWalletsConsidered: qualified.size,
    marketsWithRecentQualifiedBuys: byCondition.size,
    exclusions,
    thresholds: { windowMinutes, maxResolutionHours, minWallets, minUsdPerWallet, requireCurrentHoldings: true, sameSideOnly: true, excludeDuplicateRepresentations: true },
    complete: true,
  };
}
