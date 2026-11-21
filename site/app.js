const $ = (selector) => document.querySelector(selector);
const statusTitle = $("#status-title");
const statusDetail = $("#status-detail");
const lastScan = $("#last-scan");
const statusPanel = $(".status");

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function usd(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(value) : "—";
}
async function fetchJson(path) {
  const response = await fetch(path,{cache:"no-store"});
  if (!response.ok) throw new Error("Could not load "+path);
  return response.json();
}
let currentBoards = { week: [], month: [] };
let currentPeriod = "week";

function renderLeaderboard(rows) {
  const target=$("#leaderboard"); target.replaceChildren(); target.className="table-wrap";
  if(!Array.isArray(rows)||rows.length!==100){target.className="empty";target.textContent="The latest leaderboard did not contain a complete Top 100.";return;}
  const table=node("table"),head=node("thead"),header=node("tr");
  for(const label of ["#","Trader","Polymarket rank","Period P&L","Volume"])header.append(node("th",label));
  head.append(header);table.append(head);const body=node("tbody");
  for(const trader of rows){
    const tr=node("tr");
    tr.append(node("td",trader.rank));
    const who=node("td");who.append(node("strong",trader.username||("Trader #"+trader.rank)));
    tr.append(who,node("td",trader.leaderboardRank??"—"),node("td",usd(trader.pnl)),node("td",usd(trader.volume)));
    body.append(tr);
  }
  table.append(body);target.append(table);
  // This layout has no legacy summary-metric elements; render only into elements that exist.
  const totalPnl=$("#totalPnl"); if(totalPnl) totalPnl.textContent=usd(rows.reduce((sum,row)=>sum+(row.pnl||0),0));
  const totalVolume=$("#totalVolume"); if(totalVolume) totalVolume.textContent=usd(rows.reduce((sum,row)=>sum+(row.volume||0),0));
  const avgWinRate=$("#avgWinRate"); if(avgWinRate) avgWinRate.textContent="Not included";
}
function selectPeriod(period) {
  currentPeriod=period;
  $("#leader-period").value=period;
  const leaderPeriod=$("#leaderPeriod"); if(leaderPeriod) leaderPeriod.textContent=period==="week"?"Week":"Month";
  renderLeaderboard(currentBoards[period]);
}
async function loadDashboard(){
  try{
    const [status,weekly,monthly]=await Promise.all([
      fetchJson("./data/status.json"),fetchJson("./data/week.json"),fetchJson("./data/month.json")
    ]);
    const valid=status.schemaVersion===1&&status.state==="success"&&status.validation?.passed===true&&
      weekly.schemaVersion===1&&weekly.validation?.passed===true&&Array.isArray(weekly.traders)&&weekly.traders.length===100&&
      monthly.schemaVersion===1&&monthly.validation?.passed===true&&Array.isArray(monthly.traders)&&monthly.traders.length===100;
    if(!valid)throw new Error("The latest weekly/monthly Top 100 data did not pass validation");
    currentBoards={week:weekly.traders,month:monthly.traders};
    statusPanel.classList.add("status-success");
    statusTitle.textContent="Weekly and monthly Top 100 validated";
    statusDetail.textContent="100 weekly traders and 100 monthly traders loaded directly from Polymarket's public leaderboard, ranked by period P&L. This leaderboard does not claim verified settlement win rates.";
    lastScan.textContent=new Date(status.completedAt||status.generatedAt).toLocaleString();
    selectPeriod(currentPeriod);
    const consensus=$("#consensus"); if(consensus) consensus.textContent="Consensus is separate from the Top 100 leaderboard and is not being scanned in this version.";
    const combos=$("#combos"); if(combos) combos.textContent="Combo scanning is separate from the Top 100 leaderboard and is not being scanned in this version.";
    const comboStatus=$("#combo-status"); if(comboStatus) comboStatus.textContent="Top 100 refresh only";
  }catch(error){
    statusPanel.classList.remove("status-success");statusTitle.textContent="Waiting for a complete Top 100 refresh";
    statusDetail.textContent=error.message;lastScan.textContent="Not yet available";
    const leaderboard=$("#leaderboard"); if(leaderboard){leaderboard.className="empty";leaderboard.textContent="Awaiting validated weekly and monthly Top 100 data.";}
  }
}
const periodSelect=$("#leader-period");
if(periodSelect) periodSelect.addEventListener("change",event=>selectPeriod(event.target.value));
loadDashboard();
