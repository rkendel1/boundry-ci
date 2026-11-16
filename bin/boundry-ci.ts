#!/usr/bin/env node
// boundry-ci <command>
//   control                       run the control plane (HTTP API + reaper + status outbox + scheduler)
//   worker                        run a worker agent
//   compile <file> [k=v ...]      validate and compile a pipeline locally (kind=, ref=, sha=, trusted=)
//   admin create-worker <id> <capability...>   create a worker identity; prints its token once
//
// Configuration is BCI_-prefixed on purpose: it never picks up a FELTDB_* production
// configuration that happens to be present in the environment.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { FeltStore } from "../src/store/feltdb.ts";
import { ControlPlane, type SecretProvider } from "../src/control/core.ts";
import { createControlServer } from "../src/control/http.ts";
import { ContentStore } from "../src/artifacts/cas.ts";
import { GithubAdapter } from "../src/scm/github.ts";
import { WorkerAgent } from "../src/worker/agent.ts";
import { OciExecutor } from "../src/worker/executor.ts";
import { compile } from "../src/spec/compile.ts";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) { console.error(`missing ${k}`); process.exit(2); }
  return v;
};
const secretFile = (k: string): string => {
  const p = env(k);
  const st = statSync(p);
  if (st.mode & 0o077) { console.error(`${k}: ${p} must not be group/world readable`); process.exit(2); }
  return readFileSync(p, "utf8").trim();
};
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...f }));

/** Secrets live on the host (0600 env files per repository), never in FeltDB or in the repository. */
class FileSecrets implements SecretProvider {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }
  async resolve(repository: string, names: string[]) {
    const p = join(this.dir, `${repository.replace("/", "__")}.env`);
    const vals: Record<string, string> = {};
    if (existsSync(p)) {
      if (statSync(p).mode & 0o077) throw new Error(`secret file for ${repository} has unsafe permissions`);
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m) vals[m[1]] = m[2];
      }
    }
    const out: Record<string, string> = {};
    for (const n of names) {
      if (!(n in vals)) throw new Error(`secret ${n} is not scoped to ${repository}`);
      out[n] = vals[n];
    }
    return out;
  }
}

function store() {
  return new FeltStore({ url: env("BCI_FELTDB_URL"), token: secretFile("BCI_FELTDB_TOKEN_FILE") });
}

function github() {
  const installations: Record<string, string> = {};
  for (const kv of (process.env.BCI_GITHUB_INSTALLATIONS ?? "").split(",").filter(Boolean)) {
    const [owner, id] = kv.split("=");
    installations[owner] = id;
  }
  return new GithubAdapter({
    apiUrl: process.env.BCI_GITHUB_API_URL,
    appId: process.env.BCI_GITHUB_APP_ID,
    privateKeyPem: process.env.BCI_GITHUB_PRIVATE_KEY_FILE ? secretFile("BCI_GITHUB_PRIVATE_KEY_FILE") : undefined,
    installations,
    staticToken: process.env.BCI_GITHUB_STATIC_TOKEN, // only for proxies that inject credentials
  });
}

async function control() {
  const cp = new ControlPlane({
    store: store(), scm: github(), secrets: new FileSecrets(env("BCI_SECRETS_DIR")),
    leaseMs: Number(env("BCI_LEASE_MS", "60000")), publicUrl: process.env.BCI_PUBLIC_URL,
  });
  const operators: Record<string, string> = {};
  if (process.env.BCI_OPERATOR_TOKENS_FILE) {
    for (const line of secretFile("BCI_OPERATOR_TOKENS_FILE").split("\n")) {
      const [hash, who] = line.trim().split(/\s+/);
      if (hash && who) operators[hash] = who;
    }
  }
  const cas = new ContentStore({ root: join(env("BCI_DATA_DIR"), "cas"), minFreeBytes: Number(env("BCI_CAS_MIN_FREE_BYTES", String(10 * 1024 ** 3))) });
  const server = createControlServer({ cp, cas, webhookSecret: secretFile("BCI_WEBHOOK_SECRET_FILE"), operators, log });
  const [host, port] = env("BCI_LISTEN", "127.0.0.1:21030").split(":");
  server.listen(Number(port), host, () => log("control listening", { host, port }));
  const loop = (name: string, ms: number, f: () => Promise<unknown>) => {
    let busy = false;
    setInterval(async () => {
      if (busy) return; busy = true;
      try { const r = await f(); if (r && typeof r === "object" && Object.values(r).some(Boolean)) log(name, r as any); }
      catch (e) { log(`${name} error`, { error: (e as Error).message }); }
      finally { busy = false; }
    }, ms).unref();
  };
  loop("reap", 10_000, () => cp.reap());
  loop("statuses", 5_000, async () => ({ delivered: await cp.deliverStatuses() }));
  loop("schedules", 30_000, async () => ({ fired: await cp.tickSchedules() }));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log("shutting down"); server.close(() => process.exit(0)); });
}

async function worker() {
  const agent = new WorkerAgent({
    controlUrl: env("BCI_CONTROL_URL"), token: secretFile("BCI_WORKER_TOKEN_FILE"),
    capabilities: env("BCI_CAPABILITIES", "linux-small").split(",").map((s) => s.trim()).filter(Boolean),
    workRoot: env("BCI_WORK_ROOT"),
    executor: new OciExecutor({ cli: env("BCI_OCI_CLI", "docker"), egressCaFile: process.env.BCI_EGRESS_CA_FILE }),
    log,
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log("draining"); agent.stop(); });
  await agent.runForever();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "control": return control();
    case "worker": return worker();
    case "compile": {
      const kv = Object.fromEntries(rest.slice(1).map((a) => a.split("=")));
      const r = compile(readFileSync(rest[0], "utf8"), {
        repository: kv.repository ?? "local/repo", kind: kv.kind ?? "push", ref: kv.ref ?? "refs/heads/main",
        sha: kv.sha ?? "0".repeat(40), trusted: kv.trusted !== "false", baseBranch: kv.base, cron: kv.cron,
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "admin":
      if (rest[0] === "create-worker" && rest[1]) {
        const cp = new ControlPlane({ store: store(), scm: github(), secrets: new FileSecrets("/nonexistent") });
        console.log(await cp.createWorker(rest[1], rest.slice(2)));
        return;
      }
    // falls through
    default:
      console.error("usage: boundry-ci control | worker | compile <file> [k=v] | admin create-worker <id> <caps...>");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
