const title=document.querySelector("#status-title");
const detail=document.querySelector("#status-detail");
const lastScan=document.querySelector("#last-scan");
async function loadStatus(){
  try{
    const response=await fetch("./data/status.json",{cache:"no-store"});
    if(!response.ok)throw new Error("No published status");
    const status=await response.json();
    if(status.schemaVersion!==1||status.validation?.passed!==true)throw new Error("Invalid status contract");
    title.textContent=status.state==="success"?"Latest scan validated":"Latest scan unavailable";
    detail.textContent=status.message||"Status loaded from the latest published scan.";
    lastScan.textContent=status.completedAt?new Date(status.completedAt).toLocaleString():"Not reported";
  }catch{
    title.textContent="Waiting for first validated scan";
    detail.textContent="No valid scan status is published yet. Sample or stale results are never substituted.";
    lastScan.textContent="Not yet available";
  }
}
loadStatus();
