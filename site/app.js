const title=document.querySelector("#status-title");
const detail=document.querySelector("#status-detail");
const lastScan=document.querySelector("#last-scan");
const statusPanel=document.querySelector(".status");
function setEmpty(id,message){const target=document.getElementById(id);target.className="empty";target.textContent=message;}
function cell(tag,value,className=""){const e=document.createElement(tag);if(className)e.className=className;e.textContent=value;return e;}
function formatUsd(v){return Number.isFinite(v)?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(v):"—";}
function formatRate(v){return Number.isFinite(v)?`${(v*100).toFixed(1)}%`:"—";}
function renderLeaderboard(rows){
 const target=document.getElementById("leaderboard");target.replaceChildren();target.className="table-wrap";
 if(!Array.isArray(rows)||!rows.length){setEmpty("leaderboard","No traders currently meet the qualification rules.");return;}
 const table=document.createElement("table"),head=document.createElement("thead"),hr=document.createElement("tr");
 for(const label of ["Rank","Trader","30d win rate","Closed markets","Wins","Losses","Monthly P&L"])hr.append(cell("th",label));
 head.append(hr);table.append(head);const body=document.createElement("tbody");
 for(const trader of rows){const tr=document.createElement("tr");tr.append(cell("td",String(trader.rank??"—")));
  const nc=document.createElement("td"),name=cell("strong",trader.username||"Unknown trader"),wallet=cell("small",trader.wallet?`${trader.wallet.slice(0,6)}…${trader.wallet.slice(-4)}`:"");nc.append(name,wallet);tr.append(nc);
  tr.append(cell("td",formatRate(trader.winRate)),cell("td",String(trader.resolvedMarkets??"—")),cell("td",String(trader.wins??"—")),cell("td",String(trader.losses??"—")),cell("td",formatUsd(trader.leaderboardPnl)));body.append(tr);}
 table.append(body);target.append(table);
}
async function fetchJson(path){const r=await fetch(path,{cache:"no-store"});if(!r.ok)throw Error(`Could not load ${path}`);return r.json();}
async function loadDashboard(){try{
 const [status,monthly]=await Promise.all([fetchJson("./data/status.json"),fetchJson("./data/month.json")]);
 if(status.schemaVersion!==1||status.validation?.passed!==true||status.state!=="success"||monthly.schemaVersion!==1||monthly.validation?.passed!==true||!Array.isArray(monthly.traders))throw Error("Not validated");
 statusPanel.classList.add("status-success");title.textContent="30-day leaderboard validated";
 detail.textContent=`${status.discoveredWallets.toLocaleString()} overall monthly wallets scanned · ${status.qualifiedWallets.toLocaleString()} qualified · ${Number(status.earlyExitsExcluded??0).toLocaleString()} early exits excluded.`;
 lastScan.textContent=status.completedAt?new Date(status.completedAt).toLocaleString():new Date(status.generatedAt).toLocaleString();renderLeaderboard(monthly.traders);
 }catch{statusPanel.classList.remove("status-success");title.textContent="Waiting for first validated leaderboard";detail.textContent="No valid complete 30-day leaderboard is published. Incomplete or unverified rankings are never shown.";lastScan.textContent="Not yet available";setEmpty("leaderboard","Awaiting validated data");}}
loadDashboard();
