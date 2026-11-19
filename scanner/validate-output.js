function fail(message) {
  throw new Error(`Published output validation failed: ${message}`);
}

function normalizeTitle(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validateBoard(rows, label) {
  if (!Array.isArray(rows) || rows.length > 100) fail(`${label} board shape/size`);
  const seen = new Set();
  rows.forEach((row, index) => {
    const wallet = String(row.wallet ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || seen.has(wallet)) fail(`${label} duplicate or missing wallet`);
    seen.add(wallet);
    if (row.rank !== index + 1) fail(`${label} rank sequence`);
    if (!Number.isFinite(row.winRate) || row.winRate < 0.9 ||
        !Number.isInteger(row.resolvedMarkets) || row.resolvedMarkets < 20) {
      fail(`${label} qualification threshold`);
    }
    if (!Number.isFinite(row.leaderboardPnl)) fail(`${label} missing leaderboard PnL`);
  });
}

export function validatePublishedOutput({ qualification, weekly, monthly, consensus, status }) {
  for (const [label, data] of Object.entries({ qualification, weekly, monthly, consensus, status })) {
    if (!data || data.schemaVersion !== 1 || data.validation?.passed !== true) {
      fail(`${label} schema or validation flag`);
    }
  }
  if (status.state !== "success") fail("status is not successful");
  if (status.discoveredWallets !== qualification.validation.discoveredWallets ||
      status.auditedWallets !== qualification.validation.auditedWallets ||
      status.qualifiedWallets !== qualification.validation.qualifiedWallets) {
    fail("status/qualification count mismatch");
  }
  if (qualification.validation.allWalletAuditsComplete !== true ||
      qualification.validation.auditedWallets !== qualification.validation.discoveredWallets) {
    fail("candidate wallet audit coverage");
  }
  if (!Array.isArray(qualification.qualifiedWallets) ||
      qualification.qualifiedWallets.length !== qualification.validation.qualifiedWallets) {
    fail("qualified wallet universe");
  }
  for (const row of qualification.qualifiedWallets) {
    if (!/^0x[0-9a-f]{40}$/i.test(String(row.wallet ?? "")) || row.summary?.integrityPassed !== true ||
        row.summary.resolvedMarkets < 20 || row.summary.winRate < 0.9) {
      fail("qualified wallet lacks verified settlement thresholds");
    }
  }
  validateBoard(weekly.traders, "weekly");
  validateBoard(monthly.traders, "monthly");
  if (weekly.count !== weekly.traders.length || monthly.count !== monthly.traders.length) {
    fail("leaderboard count mismatch");
  }
  if (!Array.isArray(consensus.signals)) fail("consensus signal list");
  const duplicateKeys = new Set();
  for (const signal of consensus.signals) {
    if (!["sports", "esports", "crypto"].includes(signal.category) ||
        !signal.conditionId || !signal.tokenId || !signal.marketTitle || !signal.outcome ||
        !Number.isFinite(signal.minutesToResolution) ||
        signal.minutesToResolution < 0 || signal.minutesToResolution > 1440 ||
        !Number.isFinite(Date.parse(signal.endDate)) ||
        !Number.isInteger(signal.qualifiedWalletCount) || signal.qualifiedWalletCount < 8 ||
        !Array.isArray(signal.wallets) || signal.wallets.length !== signal.qualifiedWalletCount) {
      fail("consensus market or threshold");
    }
    const participants = new Set();
    let participantUsd = 0;
    for (const row of signal.wallets) {
      const wallet = String(row.wallet ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(wallet) || participants.has(wallet) || !Number.isFinite(row.usdSize) || row.usdSize < 10) {
        fail("consensus participant threshold or duplicate");
      }
      participants.add(wallet);
      participantUsd += row.usdSize;
    }
    if (!Number.isFinite(signal.totalUsd) || Math.abs(signal.totalUsd - participantUsd) > 0.01) {
      fail("consensus total notional");
    }
    const eventIdentity = signal.eventId ?? signal.eventSlug;
    const titleIdentity = normalizeTitle(signal.marketTitle);
    if (eventIdentity && titleIdentity) {
      const key = `${eventIdentity}:${titleIdentity}`;
      if (duplicateKeys.has(key)) fail("duplicate event/market representation");
      duplicateKeys.add(key);
    }
  }
  if (consensus.signalCount !== consensus.signals.length ||
      status.consensusCount !== consensus.signals.length ||
      status.weeklyCount !== weekly.traders.length ||
      status.monthlyCount !== monthly.traders.length) {
    fail("published count mismatch");
  }
  return { passed: true, weekly: weekly.traders.length, monthly: monthly.traders.length, signals: consensus.signals.length };
}
