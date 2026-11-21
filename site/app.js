const $ = (s) => document.querySelector(s);
const set = (s,v) => { const e=$(s); if(e) e.textContent=String(v); };
const node=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value??"");return e;};
const money=v=>Number.isFinite(Number(v))?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v)):"—";
async function json(path){const r=await fetch(path,{cache:"no-store"});if(!r.ok)throw new Error("Could not load "+path);return r.json();}
let boards={week:[],month:[]};
function render(period){
 const target=$("#leaderboard"); if(!target)throw new Error("Dashboard markup is missing #leaderboard");
 const rows=boards[period]; target.replaceChildren();target.className="table-wrap";
 if(!Array.isArray(rows)||rows.length!==100){target.className="empty";target.textContent="A complete Top 100 is not available.";return;}
 const table=node("table",""),thead=node("thead",""),hr=node("tr","");
 for(const label of ["#","Trader","Polymarket rank","Period P&L","Volume"])hr.append(node("th",label));
 thead.append(hr);table.append(thead);const body=node("tbody","");
 for(const t of rows){const tr=node("tr","");tr.append(node("td",t.rank),node("td",t.username||("Trader #"+t.rank)),node("td",t.leaderboardRank??"—"),node("td",money(t.pnl)),node("td",money(t.volume)));body.append(tr);}
 table.append(body);target.append(table);
}
async function start(){
 try{
  const [status,week,month]=await Promise.all([json("./data/status.json"),json("./data/week.json"),json("./data/month.json")]);
  const valid=status.schemaVersion===1&&status.state==="success"&&status.validation?.passed===true&&
   week.validation?.passed===true&&week.traders?.length===100&&month.validation?.passed===true&&month.traders?.length===100;
  if(!valid)throw new Error("Weekly/monthly Top 100 data failed validation.");
  boards={week:week.traders,month:month.traders};
  const panel=$(".status");if(panel)panel.classList.add("status-success");
  set("#status-title","Weekly and monthly Top 100 validated");
  set("#status-detail","100 weekly and 100 monthly traders loaded from Polymarket public leaderboard, ranked by period P&L. Settlement win rates are not included.");
  set("#last-scan",new Date(status.completedAt||status.generatedAt).toLocaleString());
  const period=$("#leader-period");const selected=period?.value==="month"?"month":"week";
  render(selected);
  if(period)period.addEventListener("change",()=>render(period.value==="month"?"month":"week"));
  set("#consensus","Consensus is separate and is not included in this Top 100 refresh.");
  set("#combos","Combo scanning is separate and is not included in this Top 100 refresh.");
  set("#combo-status","Top 100 refresh only");
 }catch(error){
  const panel=$(".status");if(panel)panel.classList.remove("status-success");
  set("#status-title","Waiting for a complete Top 100 refresh");
  set("#status-detail",error?.message||"Unknown dashboard error");
  set("#last-scan","Not yet available");
  const target=$("#leaderboard");if(target){target.className="empty";target.textContent="Awaiting validated weekly and monthly Top 100 data.";}
 }
}
start();
