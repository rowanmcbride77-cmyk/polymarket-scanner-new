const title = document.querySelector("#status-title");
const detail = document.querySelector("#status-detail");
const lastScan = document.querySelector("#last-scan");
const statusPanel = document.querySelector(".status");

function setEmpty(id, message) {
  const target = document.getElementById(id);
  target.className = "empty";
  target.textContent = message;
}

function cell(row, value, className = "") {
  const element = document.createElement(row);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(value);
}

function formatWinRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function renderLeaderboard(id, rows) {
  const target = document.getElementById(id);
  target.replaceChildren();
  target.className = "table-wrap";
  if (!Array.isArray(rows) || rows.length === 0) {
    setEmpty(id, "No traders currently meet the qualification rules.");
    return;
  }

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["Rank", "Trader", "Category", "30d win rate", "Markets", "Window P&L"]) {
    headerRow.append(cell("th", label));
  }
  head.append(headerRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const trader of rows) {
    const tr = document.createElement("tr");
    tr.append(cell("td", String(trader.rank ?? "—")));
    const nameCell = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = trader.username || "Unknown trader";
    const wallet = document.createElement("small");
    wallet.textContent = trader.wallet ? `${trader.wallet.slice(0, 6)}…${trader.wallet.slice(-4)}` : "";
    nameCell.append(name, wallet);
    tr.append(nameCell);
    tr.append(cell("td", trader.category || "—"));
    tr.append(cell("td", formatWinRate(trader.winRate)));
    tr.append(cell("td", String(trader.resolvedMarkets ?? "—")));
    tr.append(cell("td", formatUsd(trader.leaderboardPnl)));
    body.append(tr);
  }
  table.append(body);
  target.append(table);
}

function renderConsensus(signals) {
  const target = document.getElementById("consensus-board");
  target.replaceChildren();
  target.className = "signal-list";
  if (!Array.isArray(signals) || signals.length === 0) {
    setEmpty("consensus-board", "No markets currently meet the same-side consensus thresholds.");
    return;
  }
  for (const signal of signals) {
    const card = document.createElement("article");
    card.className = "signal";
    const heading = document.createElement("div");
    heading.className = "signal-heading";
    heading.append(
      cell("strong", signal.marketTitle || "Untitled market"),
      cell("span", `${signal.qualifiedWalletCount} qualified wallets`, "signal-count"),
    );
    const meta = document.createElement("p");
    meta.textContent = `${signal.category} · ${signal.outcome || "Outcome"} · ${formatUsd(signal.totalUsd)} combined`;
    const end = document.createElement("small");
    end.textContent = `Resolves ${new Date(signal.endDate).toLocaleString()}`;
    const participants = document.createElement("small");
    participants.className = "signal-wallets";
    participants.textContent = (signal.wallets ?? [])
      .map((row) => row.wallet ? `${row.wallet.slice(0, 6)}…${row.wallet.slice(-4)}` : "")
      .filter(Boolean).join(" · ");
    card.append(heading, meta, end, participants);
    target.append(card);
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
}

async function loadDashboard() {
  try {
    const status = await fetchJson("./data/status.json");
    if (status.schemaVersion !== 1 || status.validation?.passed !== true || status.state !== "success") {
      throw new Error("Latest scan has not passed validation");
    }
    const [weekly, monthly, consensus] = await Promise.all([
      fetchJson("./data/week.json"),
      fetchJson("./data/month.json"),
      fetchJson("./data/consensus.json"),
    ]);
    for (const data of [weekly, monthly, consensus]) {
      if (data.schemaVersion !== 1 || data.validation?.passed !== true) {
        throw new Error("Published scanner data failed validation");
      }
    }

    statusPanel.classList.add("status-success");
    title.textContent = "Latest scan validated";
    detail.textContent = `${status.discoveredWallets.toLocaleString()} wallets scanned · ${status.qualifiedWallets.toLocaleString()} qualified · ${(status.earlyExitsExcluded ?? 0).toLocaleString()} early exits excluded · ${status.consensusCount.toLocaleString()} consensus signals.`;
    lastScan.textContent = status.completedAt ? new Date(status.completedAt).toLocaleString()
      : status.generatedAt ? new Date(status.generatedAt).toLocaleString() : "Not reported";
    renderLeaderboard("weekly-board", weekly.traders);
    renderLeaderboard("monthly-board", monthly.traders);
    renderConsensus(consensus.signals);
  } catch {
    statusPanel.classList.remove("status-success");
    title.textContent = "Waiting for first validated scan";
    detail.textContent = "No valid complete scan is published. Unverified or stale rankings are never substituted.";
    lastScan.textContent = "Not yet available";
    setEmpty("weekly-board", "Awaiting validated data");
    setEmpty("monthly-board", "Awaiting validated data");
    setEmpty("consensus-board", "No signals published until validation is complete");
  }
}

loadDashboard();
