export async function auditCandidates(candidates, {
  auditWallet,
  concurrency = 8,
  onProgress,
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (typeof auditWallet !== "function") throw new TypeError("auditWallet function is required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("concurrency must be 1..32");
  }
  const results = new Array(candidates.length);
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      try {
        const audit = await auditWallet(candidate.wallet);
        results[index] = {
          wallet: candidate.wallet,
          username: candidate.username,
          complete: audit.complete === true,
          qualification: audit.qualification ?? { qualified: false, reason: "missing_qualification_result" },
          summary: audit.summary ?? null,
          coverage: audit.coverage ?? null,
        };
        if (audit.complete !== true) failed += 1;
      } catch (error) {
        failed += 1;
        results[index] = {
          wallet: candidate.wallet,
          username: candidate.username,
          complete: false,
          qualification: { qualified: false, reason: "audit_error" },
          error: error?.message ?? String(error),
        };
      }
      completed += 1;
      if (onProgress && (completed % 100 === 0 || completed === candidates.length)) {
        await onProgress({ completed, total: candidates.length, failed });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { results, complete: failed === 0, completed, failed };
}

function periodAppearance(candidate, period) {
  const rows = candidate.appearances.filter((item) => item.timePeriod === period);
  if (!rows.length) return null;
  return rows.sort((a, b) => b.pnl - a.pnl || a.rank - b.rank)[0];
}

export function buildQualifiedLeaderboards(discovery, auditBatch, { topN = 100 } = {}) {
  if (!discovery?.validation?.passed || !Array.isArray(discovery.candidates)) {
    throw new Error("A validated discovery dataset is required");
  }
  if (!auditBatch || auditBatch.complete !== true ||
      !Array.isArray(auditBatch.results) ||
      auditBatch.results.length !== discovery.candidates.length) {
    throw new Error("Every discovered wallet must have a complete audit before ranking");
  }
  if (!Number.isInteger(topN) || topN < 1) throw new RangeError("topN must be positive");

  const audits = new Map(auditBatch.results.map((row) => [row.wallet.toLowerCase(), row]));
  for (const candidate of discovery.candidates) {
    const audit = audits.get(candidate.wallet.toLowerCase());
    if (!audit || audit.complete !== true || !audit.summary ||
        audit.qualification?.qualified === undefined) {
      throw new Error(`Missing complete audit for wallet ${candidate.wallet}`);
    }
  }

  function buildPeriod(period) {
    const rows = [];
    for (const candidate of discovery.candidates) {
      const audit = audits.get(candidate.wallet.toLowerCase());
      if (!audit.qualification.qualified) continue;
      const appearance = periodAppearance(candidate, period);
      if (!appearance) continue;
      rows.push({
        wallet: candidate.wallet,
        username: candidate.username,
        verified: candidate.verified === true,
        category: appearance.category,
        leaderboardPnl: appearance.pnl,
        sourceRank: appearance.rank,
        winRate: audit.summary.winRate,
        resolvedMarkets: audit.summary.resolvedMarkets,
        wins: audit.summary.wins,
        losses: audit.summary.losses,
      });
    }
    rows.sort((a, b) =>
      b.leaderboardPnl - a.leaderboardPnl ||
      b.winRate - a.winRate ||
      b.resolvedMarkets - a.resolvedMarkets ||
      a.sourceRank - b.sourceRank);
    return rows.slice(0, topN).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  return {
    weekly: buildPeriod("week"),
    monthly: buildPeriod("month"),
    qualifiedWalletCount: auditBatch.results.filter((row) => row.qualification.qualified).length,
    auditedWalletCount: auditBatch.results.length,
    complete: true,
  };
}
