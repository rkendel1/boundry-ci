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
import { Deployer, type Layout } from "../src/deploy/lifecycle.ts";
import { compileRecipeSource, RecipeError, RECIPES_DIR, catalogTable } from "../src/recipes/compile.ts";
import { explain, explainDiagnostics, diffCompiled } from "../src/recipes/explain.ts";
import { localSource } from "../src/recipes/facts.ts";
import { authorRecipe } from "../src/recipes/author.ts";
import { convertGithubWorkflow, convertLegacyCiYaml, renderReport } from "../src/recipes/convert.ts";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) { console.error(`missing ${k}`); process.exit(2); }
  return v;
};
const secretFile = (k: string): string => {
  const p = env(k);
  const st = statSync(p);
  // Group read is allowed (secrets are root:<service-gid> 0440); group write and any world access are not.
  if (st.mode & 0o027) { console.error(`${k}: ${p} must not be group-writable or world-accessible`); process.exit(2); }
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
      if (statSync(p).mode & 0o027) throw new Error(`secret file for ${repository} has unsafe permissions`);
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
  const server = createControlServer({ cp, cas, webhookSecret: secretFile("BCI_WEBHOOK_SECRET_FILE"), operators, log, canaryImage: process.env.BCI_CANARY_IMAGE });
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
  process.exit(0);
}

/** Host layout for `deploy`; production defaults, every path overridable for staging and tests. */
function layout(): Layout {
  const e = process.env;
  return {
    root: e.BCI_DEPLOY_ROOT ?? "/opt/boundry-ci", etc: e.BCI_DEPLOY_ETC ?? "/etc/boundry-ci", var: e.BCI_DEPLOY_VAR ?? "/var/lib/boundry-ci",
    project: e.BCI_DEPLOY_PROJECT ?? "boundry-ci", portControl: Number(e.BCI_DEPLOY_PORT_CONTROL ?? 21030), portFeltdb: Number(e.BCI_DEPLOY_PORT_FELTDB ?? 21031),
    subnet: e.BCI_DEPLOY_SUBNET ?? "172.31.8.0/24", identityScript: e.BCI_DEPLOY_IDENTITY_SCRIPT ?? "/opt/boundry/image-identity.mjs",
    workerDriver: (e.BCI_DEPLOY_WORKER_DRIVER as Layout["workerDriver"]) ?? "systemd", workerUnit: e.BCI_DEPLOY_WORKER_UNIT ?? "boundry-ci-worker",
    workerId: e.BCI_DEPLOY_WORKER_ID ?? "hetzner-1", workerUid: e.BCI_DEPLOY_WORKER_UID ? Number(e.BCI_DEPLOY_WORKER_UID) : undefined,
    verifyTimeoutMs: Number(e.BCI_DEPLOY_VERIFY_TIMEOUT_MS ?? 180_000), drainTimeoutMs: Number(e.BCI_DEPLOY_DRAIN_TIMEOUT_MS ?? 600_000), log,
  };
}

async function deployCmd(args: string[]) {
  const d = new Deployer(layout());
  const print = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  switch (args[0]) {
    case "init": print(await d.init(JSON.parse(readFileSync(join(args[1], "release.json"), "utf8")))); return;
    case "preflight": { const m = JSON.parse(readFileSync(join(args[1], "release.json"), "utf8")); const r = await d.preflight(m, args[1]); print({ problems: r.problems, identities: Object.fromEntries(Object.entries(r.identities).map(([k, v]) => [k, v.configDigest])) }); process.exit(r.problems.length ? 1 : 0); }
    case "apply": { const r = await d.apply(args[1]); print(r); process.exit(r.ok ? 0 : 1); }
    case "rollback": { const r = await d.rollback(); print(r); process.exit(r.ok ? 0 : 1); }
    case "verify": { const id = d.pointer("active"); if (!id) { print({ error: "nothing active" }); process.exit(1); } const r = await d.verify(id, { canary: !args.includes("--no-canary") }); print(r); process.exit(r.ok ? 0 : 1); }
    case "status": print(await d.status()); return;
    case "backup": print(await d.backup(args[1])); return;
    case "restore": { if (!args[1]) { console.error("usage: deploy restore <backup-set-dir>"); process.exit(2); } const r = await d.restore(args[1]); print(r); process.exit(r.ok ? 0 : 1); }
    default:
      console.error("usage: boundry-ci deploy init|preflight|apply <bundleDir> | rollback | verify [--no-canary] | status | backup [dir] | restore <set>");
      process.exit(2);
  }
}

/** `boundry-ci recipe …` — everything works offline and without an LLM. */
async function recipeCmd(args: string[]) {
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const repoArg = (i: number) => args[i] ?? ".";
  const compileFile = async (repo: string, file: string) => {
    const path = file.includes("/") ? file : `${RECIPES_DIR}/${file}`;
    const src = readFileSync(join(repo, path), "utf8");
    return compileRecipeSource(src, path, localSource(repo), null);
  };
  const fail = (e: unknown) => { if (e instanceof RecipeError) { console.log(explainDiagnostics(e.path, e.diagnostics)); process.exit(1); } throw e; };
  switch (args[0]) {
    case "new": {
      const repo = repoArg(1);
      const goal = (flag("--goal") ?? "check") as "check" | "release";
      const a = await authorRecipe(localSource(repo), { goal, dir: flag("--dir"), ecosystem: flag("--project") as any, outputs: flag("--output")?.split(","), approver: flag("--approver"), publishTo: flag("--publish") as any });
      for (const q of a.questions) console.error(`? ${q.question}${q.answers ? ` [${q.answers.join(" | ")}]` : ""}\n  answer with ${q.flag}`);
      for (const n of a.notes) console.error(`· ${n}`);
      if (!a.recipe) process.exit(3);
      const out = flag("--write");
      if (out) { mkdirSync(dirname(join(repo, out)), { recursive: true }); writeFileSync(join(repo, out), a.recipe); console.error(`wrote ${out}`); }
      else process.stdout.write(a.recipe);
      if (args.includes("--explain")) console.error("\n" + explain(a.compiled!));
      return;
    }
    case "check": {
      const repo = repoArg(1);
      let names: string[] = [];
      try { names = readdirSync(join(repo, RECIPES_DIR)).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort(); } catch { /* none */ }
      if (!names.length) { console.log(`no recipes in ${RECIPES_DIR}/`); process.exit(1); }
      let bad = 0;
      for (const n of names) {
        try { const c = await compileFile(repo, n); console.log(`ok   ${RECIPES_DIR}/${n} — ${c.title} · ${c.jobs.length} job(s) · definition ${c.definitionDigest.slice(0, 12)}`); }
        catch (e) { if (!(e instanceof RecipeError)) throw e; bad++; console.log(explainDiagnostics(e.path, e.diagnostics)); }
      }
      process.exit(bad ? 1 : 0);
    }
    case "explain": try { console.log(explain(await compileFile(repoArg(1), args[2]))); } catch (e) { fail(e); } return;
    case "plan": try { const c = await compileFile(repoArg(1), args[2]); console.log(JSON.stringify({ definitionDigest: c.definitionDigest, compiler: c.compiler, catalog: c.catalog, capabilities: c.capabilities, facts: c.facts, plan: c.plan }, null, 2)); } catch (e) { fail(e); } return;
    case "diff": {
      const repo = repoArg(1);
      try {
        const [a, b] = await Promise.all([args[2], args[3]].map((f) => compileRecipeSource(readFileSync(f, "utf8"), `${RECIPES_DIR}/${basename(args[3])}`, localSource(repo), null)));
        const d = diffCompiled(a, b); console.log(d.text); process.exit(d.changed ? 10 : 0);
      } catch (e) { fail(e); }
      return;
    }
    case "capabilities": {
      const t = catalogTable();
      for (const kind of ["trigger", "check", "step", "approval", "keep", "after", "project"]) {
        console.log(`\n${kind.toUpperCase()}`);
        for (const c of t.filter((x) => x.kind === kind)) console.log(`  ${c.status.padEnd(11)} ${c.says.padEnd(48)} ${c.id}@${c.version}${c.note ? ` — ${c.note}` : ""}`);
      }
      return;
    }
    case "convert": {
      const file = args[1], repo = args[2] ?? ".";
      const src = readFileSync(file, "utf8");
      const r = file.endsWith("ci.yaml") && src.includes("version: 1") ? convertLegacyCiYaml(src, file) : convertGithubWorkflow(src, file);
      let result: string;
      try { const c = await compileRecipeSource(r.recipe, `${RECIPES_DIR}/converted.md`, localSource(repo), null); result = `Yes — ${c.jobs.length} job(s), definition ${c.definitionDigest.slice(0, 12)}.`; }
      catch (e) { if (!(e instanceof RecipeError)) throw e; result = "No, not until the decisions are made:\n\n" + explainDiagnostics("draft", e.diagnostics).split("\n").slice(2).join("\n"); }
      console.log(renderReport(r, result));
      return;
    }
    default:
      console.error("usage: boundry-ci recipe new <repo> [--goal check|release] [--output dir] [--project kind] [--dir folder] [--approver name --publish npm] [--write path] [--explain]\n       boundry-ci recipe check|explain|plan <repo> [recipe.md] | diff <repo> <old.md> <new.md> | capabilities | convert <workflow.yml> [repo]");
      process.exit(2);
  }
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
    case "deploy": return deployCmd(rest);
    case "recipe": return recipeCmd(rest);
    case "admin":
      if (rest[0] === "ensure-worker" && rest[1]) {
        const cp = new ControlPlane({ store: store(), scm: github(), secrets: new FileSecrets("/nonexistent") });
        const caps = rest.slice(2).filter((a) => a !== "--rotate");
        const token = await cp.ensureWorker(rest[1], caps, rest.includes("--rotate"));
        if (token) console.log(token);
        return;
      }
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
