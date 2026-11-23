const $ = (s) => document.querySelector(s);
const set = (s,v) => { const e=$(s); if(e) e.textContent=String(v); };
const node=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value??"");return e;};
const money=v=>Number.isFinite(Number(v))?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v)):"—";
const percent=v=>Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+"%":"—";
async function json(path){const r=await fetch(path,{cache:"no-store"});if(!r.ok)throw new Error("Could not load "+path);return r.json();}
let boards={week:[],month:[]};
function render(period){
 const target=$("#leaderboard");if(!target)throw new Error("Dashboard markup is missing #leaderboard");
 const rows=boards[period];target.replaceChildren();target.className="table-wrap";
 if(!Array.isArray(rows)||rows.length===0){target.className="empty";target.textContent="No traders currently meet both settlement qualification requirements.";return;}
 const table=node("table",""),thead=node("thead",""),hr=node("tr","");
 for(const label of ["#","Trader","60-Day Win Rate","Resolved Markets","W–L","Leaderboard P&L"])hr.append(node("th",label));
 thead.append(hr);table.append(thead);const body=node("tbody","");
 for(const t of rows){
  const tr=node("tr","");
  const displayName=t.username&& !/^0x[a-f0-9]{40}(?:-|$)/i.test(t.username) ? t.username : "Trader #"+t.rank;
  tr.append(node("td",t.rank),node("td",displayName),node("td",percent(t.winRate)),node("td",t.resolvedMarkets),node("td",String(t.wins)+"–"+String(t.losses)),node("td",money(t.leaderboardPnl)));
  body.append(tr);
 }
 table.append(body);target.append(table);
}
async function loadConsensus(){
 const target=$("#consensus");
 try{
  const [consensus,status,qualification]=await Promise.all([
   json("./data/consensus.json"),
   json("./data/consensus-status.json").catch(()=>null),
   json("./data/qualification-status.json").catch(()=>null)
  ]);
  const signals=Array.isArray(consensus.signals)?consensus.signals:[];
  // Consensus is built from the settlement-qualified trader boards. Only show
  // a complete consensus snapshot generated after the current qualification run.
  const qualificationAt=Date.parse(qualification?.completedAt||qualification?.generatedAt||"");
  const consensusAt=Date.parse(consensus.generatedAt||"");
  const validated=qualification?.state==="success"&&Number.isFinite(qualificationAt)&&
   Number.isFinite(consensusAt)&&consensusAt>=qualificationAt&&
   status?.state==="success"&&status.generatedAt===consensus.generatedAt&&
   consensus.schemaVersion===1&&consensus.validation?.passed===true&&
   consensus.validation?.complete===true&&Number.isInteger(consensus.walletsChecked)&&
   consensus.walletsChecked===consensus.qualifiedWalletsConsidered&&
   consensus.scanDiagnostics?.activityWalletsChecked===consensus.walletsChecked&&
   consensus.scanDiagnostics?.failedWallets===0;
  if(target){
   target.replaceChildren();
   if(!validated){
    target.className="signal-list empty";
    target.textContent=status?.state==="scanning"
     ? "The qualified-trader consensus scan is running. Previous results are hidden until the new scan is validated."
     : "Waiting for a fresh, validated consensus scan from the qualified trader boards. Previous results are hidden.";
    return;
   }
   target.className=signals.length?"signal-list":"signal-list empty";
   target.append(node("strong",signals.length+" active same-side consensus markets"));
   if(!signals.length) target.append(node("p","The latest completed scan found no markets meeting the consensus thresholds."));
   for(const signal of signals.slice(0,12)){
    const item=node("p","");
    item.textContent=(signal.marketTitle||"Market")+" — "+(signal.outcome||"")+" · "+signal.qualifiedWalletCount+" traders · "+money(signal.totalUsd);
    target.append(item);
   }
  }
 }catch(error){
  if(target){target.className="signal-list empty";target.textContent="Consensus data is temporarily unavailable.";}
 }
}
async function start(){
 loadConsensus();
 try{
  let status;
  try {
   status=await json("./data/qualification-status.json");
  } catch {
   throw new Error("Settlement-qualified Top 100 has not been published yet. Consensus scanning is independent and appears above.");
  }
  if(status.schemaVersion!==1||status.state!=="success"||status.validation?.passed!==true) {
   throw new Error("Settlement-qualified Top 100 is still being built. Consensus scanning is independent and appears above.");
  }
  const [week,month]=await Promise.all([
   json("./data/qualified-week.json"),
   json("./data/qualified-month.json")
  ]);
  const validBoard=board=>board.schemaVersion===1&&board.validation?.passed===true&&board.validation?.complete===true&&Array.isArray(board.traders)&&
   board.traders.every((t,i)=>t.rank===i+1&&Number.isFinite(t.winRate)&&t.winRate>=0.9&&Number.isInteger(t.resolvedMarkets)&&t.resolvedMarkets>=10&&
    Number.isInteger(t.wins)&&Number.isInteger(t.losses)&&t.wins+t.losses===t.resolvedMarkets&&
    Math.abs(t.winRate-t.wins/t.resolvedMarkets)<1e-9&&Number.isFinite(t.leaderboardPnl));
  const valid=status.schemaVersion===1&&status.state==="success"&&status.validation?.passed===true&&
   week.period==="week"&&month.period==="month"&&validBoard(week)&&validBoard(month)&&
   status.weeklyCount===week.traders.length&&status.monthlyCount===month.traders.length;
  if(!valid)throw new Error("Settlement-qualified leaderboard data failed validation.");
  boards={week:week.traders,month:month.traders};
  const panel=$(".status");if(panel)panel.classList.add("status-success");
  set("#status-title","Settlement-qualified Top 100");
  const incomplete=Number(status.failedWalletAudits||0);
  set("#status-detail","Only traders with at least 90% wins across at least 10 closed markets in the last 60 days are shown. Early exits are included. "+(incomplete?incomplete+" incomplete wallet audits were excluded.":"All candidate wallet audits completed."));
  set("#last-scan",new Date(status.completedAt||status.generatedAt).toLocaleString());
  const period=$("#leader-period");render(period?.value==="month"?"month":"week");
  if(period)period.addEventListener("change",()=>render(period.value==="month"?"month":"week"));
  set("#combos","Combo scanning runs separately from settlement qualification.");
  set("#combo-status","Settlement-qualified leaderboard refresh");
 }catch(error){
  const panel=$(".status");if(panel)panel.classList.remove("status-success");
  const missingQualificationFiles=/Could not load \.\/data\/(qualified-week|qualified-month|qualification-status)\.json/.test(error?.message||"");
  set("#status-title",missingQualificationFiles?"Top 100 data not published yet":"Waiting for verified settlement qualification");
  set("#status-detail",missingQualificationFiles
   ?"The settlement-qualified leaderboard files have not been published yet. The 20,000-wallet consensus scan runs separately and will appear above as soon as its data is published."
   :(error?.message||"Unknown dashboard error"));
  set("#last-scan","Not yet available");
  const target=$("#leaderboard");if(target){target.className="empty";target.textContent="Awaiting the first validated 90% / 10-market qualification run.";}
 }
}
start();
