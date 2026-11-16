import { readFileSync, writeFileSync } from "node:fs";
const repos = ["flow_db","feltkit","appport","appboundry","authboundry","stack-intel"];
const out = { window: "runs created 2026-10-17..2026-11-16 (30 days)", repos: {}, totals: {} };
const ev = []; const T = { jobs:0, minutes:{linux:0,macos:0,windows:0,other:0}, billable:{linux:0,macos:0,windows:0,other:0}, failedMinutes:0, skippedOrNoRun:0 };
for (const r of repos) {
  const rows = readFileSync(`jobs-${r}.tsv`,"utf8").trim().split("\n").filter(Boolean).map(l=>l.split("\t"));
  const R = { jobs:0, minutes:{linux:0,macos:0,windows:0,other:0}, billable:{linux:0,macos:0,windows:0,other:0}, failedMinutes:0, workflows:{} };
  for (const [path,runId,name,concl,start,end,labels] of rows) {
    if (!start || !end) { T.skippedOrNoRun++; continue; }
    const ms = Date.parse(end)-Date.parse(start); if (!(ms>=0)) continue;
    const os = /macos/i.test(labels)?"macos":/windows/i.test(labels)?"windows":/ubuntu|linux/i.test(labels)?"linux":"other";
    const min = ms/60000; const bill = ms>0?Math.ceil(min):0;
    R.jobs++; R.minutes[os]+=min; R.billable[os]+=bill; if (concl==="failure"||concl==="cancelled") R.failedMinutes+=min;
    const w = (R.workflows[path] ??= { jobs:0, minutes:0, max:0, runs:new Set(), os:new Set() });
    w.jobs++; w.minutes+=min; w.max=Math.max(w.max,min); w.runs.add(runId); w.os.add(os);
    ev.push([Date.parse(start),1],[Date.parse(end),-1]);
  }
  for (const k in R.workflows) { const w=R.workflows[k]; R.workflows[k]={ runs:w.runs.size, jobs:w.jobs, minutes:+w.minutes.toFixed(1), avgJobMin:+(w.minutes/w.jobs).toFixed(2), maxJobMin:+w.max.toFixed(1), os:[...w.os] }; }
  for (const k of ["linux","macos","windows","other"]) { R.minutes[k]=+R.minutes[k].toFixed(1); T.minutes[k]+=R.minutes[k]; T.billable[k]+=R.billable[k]; }
  R.failedMinutes=+R.failedMinutes.toFixed(1); T.failedMinutes+=R.failedMinutes; T.jobs+=R.jobs;
  out.repos[r]=R;
}
ev.sort((a,b)=>a[0]-b[0]||a[1]-b[1]); let c=0,peak=0; for (const [,d] of ev){c+=d;peak=Math.max(peak,c);}
T.peakConcurrentJobs=peak;
T.weightedMinutes = T.billable.linux + 2*T.billable.windows + 10*T.billable.macos;
out.totals=T;
writeFileSync("usage.json", JSON.stringify(out,null,2));
console.log(JSON.stringify(T,null,1));
for (const r of repos) { const R=out.repos[r]; console.log(r, R.jobs, JSON.stringify(R.billable), "failed", R.failedMinutes); const top=Object.entries(R.workflows).sort((a,b)=>b[1].minutes-a[1].minutes).slice(0,4); for (const [k,v] of top) console.log("   ",k,JSON.stringify(v)); }
