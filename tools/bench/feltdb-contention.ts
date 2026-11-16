// Workload evidence for "dedicated FeltDB instance for CI": measures latency of a small
// production-style read while CI-shaped writes (log chunks) run against the same feltdb-server.
// Usage: node tools/bench/feltdb-contention.ts <url> <tokenFile> <writers> <chunkKiB> <seconds>
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [url, tokenFile, writersS, chunkS, secsS] = process.argv.slice(2);
const token = readFileSync(tokenFile, "utf8").trim();
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const writers = Number(writersS), chunk = "x".repeat(Number(chunkS) * 1024), until = Date.now() + Number(secsS) * 1000;
await fetch(`${url}/transactions`, { method: "POST", headers: H, body: JSON.stringify({ transactionId: randomUUID(), operations: [{ collection: "prod_like", id: "r1", value: { v: 1 } }] }) });
let writes = 0, writeErr = 0;
const writer = async () => {
  while (Date.now() < until) {
    const r = await fetch(`${url}/transactions`, { method: "POST", headers: H, body: JSON.stringify({ transactionId: randomUUID(), operations: [{ collection: "ci_log_chunks", id: randomUUID(), value: { data: chunk } }] }) }).catch(() => null);
    r && r.ok ? writes++ : writeErr++;
    await r?.text();
  }
};
const lat: number[] = []; let readErr = 0;
const reader = async () => {
  while (Date.now() < until) {
    const t = performance.now();
    const r = await fetch(`${url}/collections/prod_like/r1`, { headers: H }).catch(() => null);
    r && r.ok ? lat.push(performance.now() - t) : readErr++;
    await r?.text();
    await new Promise((s) => setTimeout(s, 20));
  }
};
await Promise.all([reader(), ...Array.from({ length: writers }, writer)]);
lat.sort((a, b) => a - b);
const p = (q: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1) : "n/a";
console.log(JSON.stringify({ writers, chunkKiB: Number(chunkS), seconds: Number(secsS), writesPerSec: +(writes / Number(secsS)).toFixed(1), writeErrors: writeErr, writeMiBPerSec: +((writes * Number(chunkS)) / 1024 / Number(secsS)).toFixed(2), readP50ms: p(0.5), readP99ms: p(0.99), readMaxMs: lat.length ? lat[lat.length - 1].toFixed(1) : "n/a", readErrors: readErr }));
