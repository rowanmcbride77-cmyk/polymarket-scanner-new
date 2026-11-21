const $ = (s) => document.querySelector(s);
const set = (s,v) => { const e=$(s); if(e) e.textContent=String(v); };
const node=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value??"");return e;};
const money=v=>Number.isFinite(Number(v))?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v)):"—";
async function json(path){const r=await fetch(path,{cache:"no-store"});if(!r.ok)throw new Error("Could not load "+path);return r.json();}
let boards={week:[],month:[]};
function render(period){
 const target=$("#leaderboard");if(!target)throw new Error("Dashboard markup is missing #leaderboard");
 const rows=boards[period];target.replaceChildren();target.className="table-wrap";
 if(!Array.isArray(rows)||rows.length===0){target.className="empty";target.textContent="No public leaderboard entries were returned.";return;}
 const table=node("table",""),thead=node("thead",""),hr=node("tr","");
 for(const label of ["#","Trader","Leaderboard P&L","Volume"])hr.append(node("th",label));
 thead.append(hr);table.append(thead);const body=node("tbody","");
 for(const t of rows){
  const tr=node("tr","");
  tr.append(node("td",t.rank),node("td",t.username||("Trader #"+t.rank)),node("td",money(t.pnl)),node("td",money(t.volume)));
  body.append(tr);
 }
 table.append(body);target.append(table);
}
async function start(){
 try{
  const [status,week,month]=await Promise.all([json("./data/status.json"),json("./data/week.json"),json("./data/month.json")]);
  const valid=status.schemaVersion===1&&status.state==="success"&&status.validation?.passed===true&&
   week.validation?.passed===true&&week.validation?.complete===true&&Array.isArray(week.traders)&&week.traders.length===100&&
   month.validation?.passed===true&&month.validation?.complete===true&&Array.isArray(month.traders)&&month.traders.length===100&&
   [...week.traders,...month.traders].every(t=>/^0x[a-f0-9]{40}$/i.test(t.wallet)&&Number.isFinite(t.pnl));
  if(!valid)throw new Error("The public weekly/monthly Top 100 data failed validation.");
  boards={week:week.traders,month:month.traders};
  const panel=$(".status");if(panel)panel.classList.add("status-success");
  set("#status-title","Live Polymarket Top 100");
  set("#status-detail","Fetched directly from Polymarket's public leaderboard API. Rankings show public leaderboard P&L and volume; settlement win-rate qualification is not run in this fast refresh.");
  set("#last-scan",new Date(status.completedAt||status.generatedAt).toLocaleString());
  const period=$("#leader-period");render(period?.value==="month"?"month":"week");
  if(period)period.addEventListener("change",()=>render(period.value==="month"?"month":"week"));
  set("#consensus","Consensus market scanning runs separately and is not delayed by Top 100 leaderboard refreshes.");
  set("#combos","Combo scanning runs separately and is not delayed by Top 100 leaderboard refreshes.");
  set("#combo-status","Fast Top 100 refresh");
 }catch(error){
  const panel=$(".status");if(panel)panel.classList.remove("status-success");
  set("#status-title","Waiting for a valid Top 100 refresh");
  set("#status-detail",error?.message||"Unknown dashboard error");
  set("#last-scan","Not yet available");
  const target=$("#leaderboard");if(target){target.className="empty";target.textContent="Awaiting validated public Top 100 data.";}
 }
}
start();
