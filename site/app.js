const $ = (s) => document.querySelector(s);
const set = (s,v) => { const e=$(s); if(e) e.textContent=String(v); };
const node=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value??"");return e;};
const money=v=>Number.isFinite(Number(v))?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v)):"—";
const percent=v=>Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+"%":"—";
async function json(path){const r=await fetch(path,{cache:"no-store"});if(!r.ok)throw new Error("Could not load "+path);return r.json();}
function render(rows){
 const target=$("#leaderboard");if(!target)throw new Error("Dashboard markup is missing #leaderboard");
 target.replaceChildren();target.className="table-wrap";
 if(!Array.isArray(rows)||rows.length===0){target.className="empty";target.textContent="No traders currently meet both requirements.";return;}
 const table=node("table",""),thead=node("thead",""),hr=node("tr","");
 for(const label of ["#","Trader","Win Rate (60 days)","Closed Markets","Wins–Losses","P&L"])hr.append(node("th",label));
 thead.append(hr);table.append(thead);const body=node("tbody","");
 for(const t of rows){
  const tr=node("tr","");
  const displayName=t.username&&!/^0x[a-f0-9]{40}(?:-|$)/i.test(t.username)?t.username:"Trader #"+t.rank;
  tr.append(node("td",t.rank),node("td",displayName),node("td",percent(t.winRate)),node("td",t.resolvedMarkets),node("td",String(t.wins)+"–"+String(t.losses)),node("td",money(t.leaderboardPnl)));
  body.append(tr);
 }
 table.append(body);target.append(table);
}
async function start(){
 try{
  const status=await json("./data/qualification-status.json");
  const validQualification=q=>q?.minimumWinRate===0.9&&q?.minimumResolvedMarkets===10&&q?.lookbackDays===60&&q?.earlyExitsCounted===false;
  if(status.schemaVersion!==1||status.state!=="success"||status.validation?.passed!==true||status.validation?.complete!==true||
     status.earlyExitsIncluded!==false||!validQualification(status.qualification)||!Number.isFinite(Date.parse(status.completedAt||""))) {
   throw new Error("The latest scan is still running or has not passed validation. The previous results are hidden until a complete scan is published.");
  }
  const [week,month]=await Promise.all([json("./data/qualified-week.json"),json("./data/qualified-month.json")]);
  const validBoard=board=>board.schemaVersion===1&&board.validation?.passed===true&&board.validation?.complete===true&&
   validQualification(board.qualification)&&Array.isArray(board.traders)&&
   board.traders.every((t,i)=>t.rank===i+1&&Number.isFinite(t.winRate)&&t.winRate>=0.9&&Number.isInteger(t.resolvedMarkets)&&t.resolvedMarkets>=10&&
    Number.isInteger(t.wins)&&Number.isInteger(t.losses)&&t.wins+t.losses===t.resolvedMarkets&&
    Math.abs(t.winRate-t.wins/t.resolvedMarkets)<1e-9&&Number.isFinite(t.leaderboardPnl));
  if(week.period!=="week"||month.period!=="month"||!validBoard(week)||!validBoard(month)||
     status.weeklyCount!==week.traders.length||status.monthlyCount!==month.traders.length) {
   throw new Error("The published Top 100 data did not pass validation. No unverified results are being shown.");
  }
  const period=$("#leader-period");
  const show=()=>render(period?.value==="month"?month.traders:week.traders);
  show();if(period)period.addEventListener("change",show);
  const panel=$(".status");if(panel)panel.classList.add("status-success");
  set("#status-title","Top 100 scan complete");
  const total=Number(status.sourceCandidateCount||status.discoveredWallets||0);
  const checked=Number(status.auditedWallets||0);
  const coverage=status.auditUniverseComplete===false
   ? checked.toLocaleString()+" of "+total.toLocaleString()+" discovered wallets checked so far."
   : "The full discovered wallet list was checked.";
  const failed=Number(status.failedWalletAudits||0);
  set("#status-detail","Showing traders with at least 90% wins across 10 or more resolved markets in the last 60 days. Early exits are excluded from wins, losses, and the resolved-market count. "+coverage+(failed?" "+failed+" wallet histories could not be fully checked and were excluded.":""));
  set("#last-scan",new Date(status.completedAt||status.generatedAt).toLocaleString());
 }catch(error){
  const panel=$(".status");if(panel)panel.classList.remove("status-success");
  set("#status-title","Top 100 not yet verified");
  set("#status-detail",error?.message||"The latest scan could not be loaded.");
  set("#last-scan","Not yet available");
  const target=$("#leaderboard");if(target){target.className="empty";target.textContent="Waiting for a complete, verified Top 100 scan.";}
 }
}
start();
