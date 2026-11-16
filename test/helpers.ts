import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { FeltStore } from "../src/store/feltdb.ts";
import { ControlPlane, type SecretProvider } from "../src/control/core.ts";
import type { ScmAdapter, CommitState } from "../src/scm/types.ts";

export const FELTDB_BIN = process.env.FELTDB_SERVER_BIN ?? "/home/user/flow_db/target/release/feltdb-server";

const cleanEnv = () => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("FELTDB_") || k.startsWith("VITE_FELTDB_")) delete e[k];
  return { ...e, FELTDB_ENVIRONMENT: "development", FELTDB_MASTER_KEY: "disposable-test-master-key" };
};

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

/** A real, authenticated feltdb-server on a private data directory. Restartable on the same data. */
export class FeltDbProcess {
  dir = mkdtempSync(join(tmpdir(), "bci-feltdb-"));
  port = 0;
  token = "";
  proc: ChildProcess | null = null;

  async start(): Promise<void> {
    if (!this.token) {
      this.port = await freePort();
      const r = spawnSync(FELTDB_BIN, ["keys", "create", "--keys", join(this.dir, "keys.json"), "--name", "test", "--scope", "*", "--namespace", "boundry-ci"], { env: cleanEnv() });
      if (r.status !== 0) throw new Error(`keys create failed: ${r.stderr}`);
      this.token = r.stdout.toString().trim().split("\n").pop()!.trim();
    }
    this.proc = spawn(FELTDB_BIN, ["--host", "127.0.0.1", "--port", String(this.port), "--namespace", "boundry-ci", "--data", join(this.dir, "data", "feltdb.log"), "--auth", "--keys", join(this.dir, "keys.json")], { env: cleanEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    this.proc.stderr!.on("data", (d) => (err += d));
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${this.url}/ready`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`feltdb did not start: ${err}`);
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  store() { return new FeltStore({ url: this.url, token: this.token, timeoutMs: 3_000 }); }
  async stop(): Promise<void> {
    const p = this.proc; this.proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((res) => { p.on("exit", () => res()); p.kill("SIGKILL"); });
  }
}

export class FakeScm implements ScmAdapter {
  readonly provider = "github";
  files = new Map<string, string>(); // `${repo}@${sha}` -> ci.yaml
  branches = new Map<string, string>(); // `${repo}#${branch}` -> sha
  statuses: { repository: string; sha: string; context: string; state: CommitState; description: string }[] = [];
  failStatus = false;
  async readFile(repository: string, sha: string) { return this.files.get(`${repository}@${sha}`) ?? null; }
  async resolveBranch(repository: string, branch: string) { return this.branches.get(`${repository}#${branch}`) ?? null; }
  async reportStatus(repository: string, sha: string, s: any) { if (this.failStatus) throw new Error("github down"); this.statuses.push({ repository, sha, ...s }); }
  async checkoutAuth(repository: string) { return { url: `https://github.com/${repository}.git` }; }
}

export class MapSecrets implements SecretProvider {
  readonly scoped: Record<string, Record<string, string>>;
  constructor(scoped: Record<string, Record<string, string>>) { this.scoped = scoped; }
  async resolve(repository: string, names: string[]) {
    const out: Record<string, string> = {};
    for (const n of names) {
      const v = this.scoped[repository]?.[n];
      if (v === undefined) throw new Error(`secret ${n} not scoped to ${repository}`);
      out[n] = v;
    }
    return out;
  }
}

export class Clock { t = Date.UTC(2026, 10, 16, 12, 0, 0); now = () => this.t; advance(ms: number) { this.t += ms; } }

export function makeCp(db: FeltDbProcess, scm = new FakeScm(), clock = new Clock(), secrets = new MapSecrets({})) {
  return { cp: new ControlPlane({ store: db.store(), scm, secrets, now: clock.now, leaseMs: 30_000 }), scm, clock, secrets };
}

export const sha = (n: number) => n.toString(16).padStart(40, "0");
export const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
