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
function pct(value) { return Number.isFinite(value) ? (value*100).toFixed(1)+"%" : "No settled sample"; }
function link(url, label) {
  const a=node("a",label); a.href=url; a.target="_blank"; a.rel="noopener noreferrer"; return a;
}
async function fetchJson(path) {
  const response=await fetch(path,{cache:"no-store"});
  if(!response.ok) throw new Error("Could not load "+path);
  return response.json();
}
function renderLeaderboard(rows) {
  const target=$("#leaderboard"); target.replaceChildren(); target.className="table-wrap";
  if(!Array.isArray(rows)||!rows.length){target.className="empty";target.textContent="No traders currently meet the settlement qualification rules.";return;}
  const table=node("table"),head=node("thead"),header=node("tr");
  for(const label of ["Rank","Trader","30d win rate","Resolved","Wins","Losses","Monthly P&L"])header.append(node("th",label));
  head.append(header);table.append(head);const body=node("tbody");
  for(const trader of rows){
    const tr=node("tr");tr.append(node("td",trader.rank));
    const who=node("td");who.append(node("strong",trader.username||"Unknown trader"),node("small",trader.wallet?trader.wallet.slice(0,6)+"…"+trader.wallet.slice(-4):""));
    if(trader.wallet)who.append(link("https://polymarket.com/profile/"+trader.wallet,"Profile ↗"));
    tr.append(who,node("td",pct(trader.winRate)),node("td",trader.resolvedMarkets),node("td",trader.wins),node("td",trader.losses),node("td",usd(trader.leaderboardPnl)));body.append(tr);
  }
  table.append(body);target.append(table);
}
function renderConsensus(consensus) {
  const target=$("#consensus");target.replaceChildren();target.className="signal-list";
  const rows=consensus?.signals;
  if(!Array.isArray(rows)||!rows.length){target.className="empty";target.textContent="No consensus markets currently meet all filters. The scan records the exact exclusion reasons in consensus.json.";return;}
  for(const market of rows){
    const card=node("div",undefined,"signal");
    const heading=node("div",undefined,"signal-heading");
    heading.append(node("strong",market.marketTitle||"Untitled market"),node("span",market.qualifiedWalletCount+" traders","signal-count"));card.append(heading);
    card.append(node("p",market.outcome+" · "+market.category+" · resolves in "+market.minutesToResolution+" minutes"));
    card.append(node("p",usd(market.totalUsd)+" combined recent BUY volume · "+market.wallets.length+" qualified wallets"));
    const participants=node("div",undefined,"signal-wallets");
    for(const trader of market.wallets.slice(0,20)){
      const item=node("span");
      item.append(link("https://polymarket.com/profile/"+trader.wallet,trader.username||trader.wallet.slice(0,6)+"…"+trader.wallet.slice(-4)));
      item.append(document.createTextNode(" "+usd(trader.usdSize)+" · "));
      participants.append(item);
    }
    card.append(participants);
    if(market.eventSlug)card.append(link("https://polymarket.com/event/"+market.eventSlug,"Open market ↗"));
    target.append(card);
  }
}
function renderCombos(comboData) {
  const target=$("#combos");target.replaceChildren();target.className="signal-list";
  const budget=Number($("#combo-budget").value||100),minimum=Number($("#combo-multiplier").value||10);
  const rows=(comboData?.opportunities||[]).filter(row=>row.entryCostUsd<=budget&&row.multiplier>=minimum)
    .sort((a,b)=>b.multiplier-a.multiplier||a.entryCostUsd-b.entryCostUsd);
  const scan=comboData?.validation;
  $("#combo-status").textContent=scan?.complete===true
    ? "Complete scan · "+(comboData.walletsWithComboData??0)+" wallets returned combo data"
    : "Partial scan · "+(scan?.failedWallets??"unknown")+" wallet requests failed; results may be incomplete";
  if(!rows.length){target.className="empty";target.textContent="No active combos match these budget and multiplier filters in the latest scan.";return;}
  for(const combo of rows){
    const card=node("div",undefined,"signal combo");
    const title=node("div",undefined,"signal-heading");
    title.append(node("strong",(combo.legCount||combo.legs?.length||"Multi")+"-leg combo"),node("span",combo.multiplier.toFixed(1)+"×","signal-count"));card.append(title);
    card.append(node("p",usd(combo.entryCostUsd)+" entry · "+usd(combo.potentialPayoutUsd)+" potential gross payout · "+usd(combo.potentialProfitUsd)+" potential profit"));
    card.append(node("p",combo.timing?.label||"Event timing unavailable"));
    const record=combo.traderComboRecord||{};
    card.append(node("p","Trader's 30-day combo record: "+record.wins+"W–"+record.losses+"L"+(record.partial?" · "+record.partial+" partial":"")+" · "+record.resolved+" settled · "+pct(record.winRate)));
    const trader=node("div",undefined,"combo-trader");
    trader.append(link("https://polymarket.com/profile/"+combo.wallet,combo.username||combo.wallet.slice(0,6)+"…"+combo.wallet.slice(-4)));
    card.append(trader);
    const legs=node("ol",undefined,"combo-legs");
    for(const leg of combo.legs||[]){
      const li=node("li",(leg.title||"Market leg")+" — "+(leg.outcome||"Outcome unavailable"));
      if(leg.eventSlug)li.append(document.createTextNode(" "),link("https://polymarket.com/event/"+leg.eventSlug,"Open ↗"));
      legs.append(li);
    }
    if(combo.legs?.length)card.append(legs);
    target.append(card);
  }
}
async function loadDashboard(){
  try{
    const [status,qualification,weekly,monthly,consensus]=await Promise.all([
      fetchJson("./data/status.json"),fetchJson("./data/qualification.json"),
      fetchJson("./data/week.json"),fetchJson("./data/month.json"),fetchJson("./data/consensus.json"),
    ]);
    const valid=status.schemaVersion===1&&status.validation?.passed===true&&status.state==="success"&&
      qualification.schemaVersion===1&&qualification.validation?.passed===true&&
      monthly.schemaVersion===1&&monthly.validation?.passed===true&&Array.isArray(monthly.traders)&&
      consensus.schemaVersion===1&&consensus.validation?.passed===true;
    if(!valid)throw new Error("The latest scanner generation did not pass validation");
    statusPanel.classList.add("status-success");statusTitle.textContent=(status.failedWalletAudits??0)>0?"Validated scan · incomplete wallets excluded":"Latest scanner generation validated";
    statusDetail.textContent=status.discoveredWallets.toLocaleString()+" wallets processed · "+(status.fullyAuditedWallets??status.auditedWallets??status.discoveredWallets).toLocaleString()+" fully audited · "+(status.failedWalletAudits??0).toLocaleString()+" settlement audits excluded · "+(status.consensusWalletAuditFailures??0).toLocaleString()+" recent-activity audits excluded · "+status.qualifiedWallets.toLocaleString()+" qualified · "+(status.consensusCount??0)+" consensus markets · "+(status.comboCount??0)+" combo opportunities.";
    lastScan.textContent=status.completedAt?new Date(status.completedAt).toLocaleString():new Date(status.generatedAt).toLocaleString();
    renderLeaderboard(monthly.traders);renderConsensus(consensus);renderCombos(consensus.combos);
  }catch(error){
    statusPanel.classList.remove("status-success");statusTitle.textContent="Waiting for complete validated scan";
    statusDetail.textContent=error.message;lastScan.textContent="Not yet available";
    for(const id of ["leaderboard","consensus","combos"]){const target=$("#"+id);target.className="empty";target.textContent="Awaiting validated data";}
  }
}
$("#combo-budget").addEventListener("change",()=>fetchJson("./data/consensus.json").then(data=>renderCombos(data.combos)).catch(()=>{}));
$("#combo-multiplier").addEventListener("change",()=>fetchJson("./data/consensus.json").then(data=>renderCombos(data.combos)).catch(()=>{}));
loadDashboard();
