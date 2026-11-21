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
 if(!Array.isArray(rows)||rows.length===0){target.className="empty";target.textContent="No traders currently meet every settlement qualification rule.";return;}
 const table=node("table",""),thead=node("thead",""),hr=node("tr","");
 for(const label of ["#","Trader","Win rate","Resolved markets","Leaderboard P&L"])hr.append(node("th",label));
 thead.append(hr);table.append(thead);const body=node("tbody","");
 for(const t of rows){
  const tr=node("tr","");
  tr.append(node("td",t.rank),node("td",t.username||("Trader #"+t.rank)),node("td",percent(t.winRate)),node("td",t.resolvedMarkets),node("td",money(t.leaderboardPnl)));
  body.append(tr);
 }
 table.append(body);target.append(table);
}
async function start(){
 try{
  const [status,week,month]=await Promise.all([json("./data/status.json"),json("./data/week.json"),json("./data/month.json")]);
  const valid=status.schemaVersion===1&&status.state==="success"&&status.validation?.passed===true&&
   week.validation?.passed===true&&Array.isArray(week.traders)&&week.traders.length<=100&&
   month.validation?.passed===true&&Array.isArray(month.traders)&&month.traders.length<=100&&
   [...week.traders,...month.traders].every(t=>Number.isFinite(t.winRate)&&t.winRate>=0.9&&Number.isInteger(t.resolvedMarkets)&&t.resolvedMarkets>=10);
  if(!valid)throw new Error("The published trader lists failed 90% win-rate / 10 resolved-market qualification validation.");
  boards={week:week.traders,month:month.traders};
  const panel=$(".status");if(panel)panel.classList.add("status-success");
  set("#status-title","Settlement-qualified Top 100");
  set("#status-detail","Only traders with at least a 90% win rate across 10 or more resolved markets in the rolling 30-day window are shown. Early exits are excluded from wins, losses and win rate.");
  set("#last-scan",new Date(status.completedAt||status.generatedAt).toLocaleString());
  const period=$("#leader-period");const selected=period?.value==="month"?"month":"week";
  render(selected);
  if(period)period.addEventListener("change",()=>render(period.value==="month"?"month":"week"));
  set("#consensus","Consensus signals are the next stage; this page currently displays settlement-qualified trader rankings.");
  set("#combos","Combo scanning is not part of this Top 100 qualification refresh.");
  set("#combo-status","Qualified Top 100");
 }catch(error){
  const panel=$(".status");if(panel)panel.classList.remove("status-success");
  set("#status-title","Waiting for a complete qualification scan");
  set("#status-detail",error?.message||"Unknown dashboard error");
  set("#last-scan","Not yet available");
  const target=$("#leaderboard");if(target){target.className="empty";target.textContent="Awaiting validated settlement-qualified traders.";}
 }
}
start();
