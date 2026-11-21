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
  const errorCounts = new Map();
  const errorSamples = [];
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
          recentBuys: Array.isArray(audit.recentBuys) ? audit.recentBuys : [],
          currentPositions: Array.isArray(audit.currentPositions) ? audit.currentPositions : [],
          comboRows: Array.isArray(audit.comboRows) ? audit.comboRows : [],
        };
        if (audit.complete !== true) failed += 1;
      } catch (error) {
        failed += 1;
        const stage = error?.auditStage ?? "unknown";
        const message = error?.message ?? String(error);
        const key = `${stage}: ${message}`;
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
        if (errorSamples.length < 12) {
          errorSamples.push({ wallet: candidate.wallet, stage, message });
        }
        results[index] = {
          wallet: candidate.wallet,
          username: candidate.username,
          complete: false,
          qualification: { qualified: false, reason: "audit_error" },
          auditStage: stage,
          error: message,
        };
      }
      completed += 1;
      // Emit progress for small diagnostic samples as well as full scans.
      if (onProgress && (completed % 5 === 0 || completed === candidates.length)) {
        const commonErrors = [...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([error, count]) => ({ error, count }));
        await onProgress({
          completed, total: candidates.length, failed,
          commonErrors, errorSamples: errorSamples.slice(0, 5),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { results, complete: completed === candidates.length, allAuditsComplete: failed === 0, completed, failed,
    errorCounts: Object.fromEntries(errorCounts), errorSamples };
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
    throw new Error("Every discovered wallet must have an audit result before ranking");
  }
  if (!Number.isInteger(topN) || topN < 1) throw new RangeError("topN must be positive");

  const audits = new Map(auditBatch.results.map((row) => [row.wallet.toLowerCase(), row]));
  for (const candidate of discovery.candidates) {
    const audit = audits.get(candidate.wallet.toLowerCase());
    if (!audit) throw new Error(`Missing audit result for wallet ${candidate.wallet}`);
    // An individual failed/incomplete audit disqualifies only that wallet.
    // It must never be ranked, but it must not block every other verified wallet.
    if (audit.complete !== true) continue;
    if (!audit.summary || audit.qualification?.qualified === undefined ||
        (audit.qualification.qualified && audit.summary.integrityPassed !== true)) {
      throw new Error(`Invalid completed audit for wallet ${candidate.wallet}`);
    }
  }

  function buildPeriod(period) {
    const rows = [];
    for (const candidate of discovery.candidates) {
      const audit = audits.get(candidate.wallet.toLowerCase());
      if (audit.complete !== true || !audit.qualification?.qualified) continue;
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
    qualifiedWalletCount: auditBatch.results.filter((row) => row.complete === true && row.qualification?.qualified).length,
    auditedWalletCount: auditBatch.results.length,
    complete: true,
  };
}
