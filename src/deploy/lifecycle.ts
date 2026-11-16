// Transactional install / upgrade / rollback of Boundry CI on one host.
//
//   preflight → stage (immutable release dir) → activate (compose up + worker restart)
//     → verify (independent health) → commit (move `current`) | automatic rollback to `current`
//
// Two pointers: `active` = what is running, `current` = last release that passed verification.
// Every attempt and outcome is written to the hash-chained journal before and after it happens.
// Nothing here edits another compose project, network, volume, Caddy, firewall or systemd unit.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readlinkSync, symlinkSync, renameSync, rmSync, statSync,
  chownSync, chmodSync, readdirSync, openSync, closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { canonicalJson } from "../canonical.ts";
import { Journal, type DeployEvent } from "./journal.ts";

const pexec = promisify(execFile);

export interface ImagePin { ref: string; configDigest: string }
export interface ReleaseManifest {
  releaseId: string;
  revision: string; // git commit of rkendel1/boundry-ci the control image was built from
  images: { control: ImagePin; feltdb: ImagePin; canary: ImagePin };
  settings: {
    workerCapabilities: string;
    ociCli: "podman" | "docker";
    /** Must be true to let the worker drive a ROOTFUL Docker daemon. Never set on the shared production host. */
    allowRootfulExecutor?: boolean;
    casMinFreeBytes: number;
    leaseMs?: number;
    requireGithubApp: boolean;
    githubAppId?: string;
    githubInstallations?: string;
    publicHost?: string;
    egressCaFile?: string;
  };
}

export interface Layout {
  root: string; etc: string; var: string; project: string;
  portControl: number; portFeltdb: number; subnet: string;
  identityScript: string;
  workerDriver: "systemd" | "process";
  workerUnit: string;
  workerId: string;
  workerUid?: number;
  verifyTimeoutMs: number;
  drainTimeoutMs: number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}

export const UID = { control: 21030, feltdb: 21031 };
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface Check { name: string; ok: boolean; detail: string }
export interface Outcome { ok: boolean; event: DeployEvent; releaseId: string; deploymentId: string; checks?: Check[]; problems?: string[]; restored?: string | null }

export class Deployer {
  readonly L: Layout;
  readonly journal: Journal;
  readonly #log: NonNullable<Layout["log"]>;

  constructor(layout: Layout) {
    this.L = layout;
    this.journal = new Journal(join(layout.var, "deployments.jsonl"));
    this.#log = layout.log ?? (() => {});
  }

  // ───────── paths ─────────
  rel(id: string) { return join(this.L.root, "releases", id); }
  pointer(name: "current" | "active"): string | null {
    try { return readlinkSync(join(this.L.root, name)).split("/").pop()!; } catch { return null; }
  }
  #setPointer(name: "current" | "active", id: string | null) {
    const link = join(this.L.root, name);
    if (id === null) { rmSync(link, { force: true }); return; }
    const tmp = `${link}.tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    symlinkSync(join("releases", id), tmp);
    renameSync(tmp, link); // atomic replace
  }
  secret(...p: string[]) { return join(this.L.etc, ...p); }

  // ───────── init (first install; idempotent, never overwrites a secret) ─────────
  async init(m: ReleaseManifest): Promise<Record<string, string>> {
    const report: Record<string, string> = {};
    const dir = (p: string, mode: number, uid = 0, gid = 0) => { mkdirSync(p, { recursive: true }); chmodSync(p, mode); chownSync(p, uid, gid); };
    dir(this.L.root, 0o755); dir(join(this.L.root, "releases"), 0o755);
    dir(this.L.var, 0o755); dir(join(this.L.var, "feltdb"), 0o700, UID.feltdb, UID.feltdb); dir(join(this.L.var, "data"), 0o700, UID.control, UID.control);
    dir(join(this.L.var, "work"), 0o700, this.L.workerUid ?? 0, this.L.workerUid ?? 0);
    dir(this.L.etc, 0o755); dir(this.secret("secrets"), 0o700); dir(this.secret("secrets", "control"), 0o750, 0, UID.control);
    dir(this.secret("repo-secrets"), 0o750, 0, UID.control); dir(this.secret("deployer"), 0o700); dir(this.secret("worker"), 0o700, this.L.workerUid ?? 0, this.L.workerUid ?? 0);

    const put = (path: string, content: string, mode: number, gid = 0, uid = 0) => {
      const fd = openSync(path, "wx", mode); closeSync(fd); // fails if it exists: never overwrite
      writeFileSync(path, content, { mode }); chownSync(path, uid, gid); chmodSync(path, mode);
    };
    const rnd = () => randomBytes(48).toString("base64url");

    const fenv = this.secret("secrets", "feltdb.env");
    if (existsSync(fenv)) report["feltdb.env"] = "exists";
    else { put(fenv, `FELTDB_MASTER_KEY=${rnd()}\nFELTDB_SESSION_SECRET=${rnd()}\nFELTDB_GRANT_SIGNING_KEY=${rnd()}\n`, 0o600); report["feltdb.env"] = "generated"; }

    const tok = this.secret("secrets", "control", "feltdb-token");
    if (existsSync(tok)) report["feltdb-token"] = "exists";
    else {
      const { stdout } = await pexec("docker", ["run", "--rm", "--user", `${UID.feltdb}:${UID.feltdb}`, "--read-only", "--cap-drop", "ALL", "--network", "none",
        "--env-file", fenv, "-v", `${join(this.L.var, "feltdb")}:/srv/feltdb/ci`, "--entrypoint", "/usr/local/bin/feltdb-server", m.images.feltdb.ref,
        "keys", "create", "--keys", "/srv/feltdb/ci/api-keys.json", "--name", "boundry-ci-control", "--scope", "state:read,state:write", "--namespace", "boundry-ci"]);
      put(tok, lastLineKey(stdout), 0o440, UID.control); report["feltdb-token"] = "generated (scopes state:read,state:write)";
    }

    // Backups use their own key with only cluster:write (POST /admin/backups); the control plane cannot take backups
    // and the backup key cannot read or write CI state. NOTE: feltdb-server keeps only the last of repeated --scope flags;
    // scopes must be one comma-separated value (verified against flow_db@a55a5a6).
    const btok = this.secret("secrets", "backup-token");
    if (existsSync(btok)) report["backup-token"] = "exists";
    else {
      const { stdout } = await pexec("docker", ["run", "--rm", "--user", `${UID.feltdb}:${UID.feltdb}`, "--read-only", "--cap-drop", "ALL", "--network", "none",
        "--env-file", fenv, "-v", `${join(this.L.var, "feltdb")}:/srv/feltdb/ci`, "--entrypoint", "/usr/local/bin/feltdb-server", m.images.feltdb.ref,
        "keys", "create", "--keys", "/srv/feltdb/ci/api-keys.json", "--name", "boundry-ci-backup", "--scope", "cluster:write", "--namespace", "boundry-ci"]);
      put(btok, lastLineKey(stdout), 0o600); report["backup-token"] = "generated (scope cluster:write)";
    }

    const opTok = this.secret("deployer", "operator-token");
    const ops = this.secret("secrets", "control", "operators");
    if (existsSync(opTok)) report["operator-token"] = "exists";
    else {
      const t = `bci_op_${rnd()}`;
      put(opTok, t, 0o600);
      const line = `${createHash("sha256").update(t).digest("hex")} deployer\n`;
      if (existsSync(ops)) { chmodSync(ops, 0o640); writeFileSync(ops, readFileSync(ops, "utf8") + line); chmodSync(ops, 0o440); } else put(ops, line, 0o440, UID.control);
      report["operator-token"] = "generated";
    }

    const wh = this.secret("secrets", "control", "github-webhook");
    if (existsSync(wh)) report["github-webhook"] = "exists";
    else if (!m.settings.requireGithubApp) { put(wh, rnd(), 0o440, UID.control); report["github-webhook"] = "generated (no GitHub App configured)"; }
    else report["github-webhook"] = "MISSING: operator must supply the GitHub App webhook secret";

    const pem = this.secret("secrets", "control", "github-app.pem");
    report["github-app.pem"] = existsSync(pem) ? "exists" : m.settings.requireGithubApp ? "MISSING: operator must supply the GitHub App private key" : "not required";
    return report;
  }

  // ───────── preflight (read-only) ─────────
  async preflight(m: ReleaseManifest, bundleDir: string): Promise<{ problems: string[]; identities: Record<string, Identity> }> {
    const problems: string[] = [];
    const identities: Record<string, Identity> = {};
    if (!RELEASE_ID.test(m.releaseId)) problems.push(`releaseId '${m.releaseId}' is not a valid release identifier`);
    if (!/^[0-9a-f]{40}$/.test(m.revision)) problems.push("revision must be a full 40-hex git commit");
    if (!existsSync(join(bundleDir, "compose.yml"))) problems.push("bundle has no compose.yml");
    try { await pexec("docker", ["version", "--format", "{{.Server.Version}}"]); } catch { problems.push("container engine (docker CLI → daemon) not reachable for the platform services"); }
    try { await pexec("docker", ["compose", "version"]); } catch { problems.push("docker compose plugin missing"); }
    for (const [name, pin] of Object.entries(m.images)) {
      if (!DIGEST.test(pin.configDigest)) { problems.push(`images.${name}.configDigest must be sha256:<64 hex>`); continue; }
      try {
        const id = await this.identity(pin.ref);
        identities[name] = id;
        if (id.configDigest !== pin.configDigest) problems.push(`images.${name}: ${pin.ref} has config digest ${id.configDigest}, release pins ${pin.configDigest}`);
      } catch (e) { problems.push(`images.${name}: ${pin.ref} not present on this host (${errLine(e)})`); }
    }
    if (m.settings.ociCli === "docker" && !m.settings.allowRootfulExecutor) problems.push("worker executor is rootful Docker: refused unless settings.allowRootfulExecutor is explicitly true (never on the shared production host)");
    try { await pexec(m.settings.ociCli, ["--version"]); } catch { problems.push(`worker OCI CLI '${m.settings.ociCli}' not installed`); }
    const need: [string[], number][] = [
      [["secrets", "feltdb.env"], 0o600], [["secrets", "control", "feltdb-token"], 0o440], [["secrets", "control", "operators"], 0o440],
      [["secrets", "control", "github-webhook"], 0o440], [["deployer", "operator-token"], 0o600],
    ];
    if (m.settings.requireGithubApp) need.push([["secrets", "control", "github-app.pem"], 0o440]);
    for (const [p, mode] of need) {
      const f = this.secret(...p);
      if (!existsSync(f)) { problems.push(`secret ${p.join("/")} missing (run 'deploy init' or supply it)`); continue; }
      const actual = statSync(f).mode & 0o777;
      if (actual & 0o007 || actual & ~mode & 0o777) problems.push(`secret ${p.join("/")} mode ${actual.toString(8)} is broader than ${mode.toString(8)}`);
    }
    if (m.settings.requireGithubApp && (!m.settings.githubAppId || !m.settings.githubInstallations)) problems.push("settings.githubAppId and settings.githubInstallations are required");
    if (!this.pointer("active")) {
      for (const port of [this.L.portControl, this.L.portFeltdb]) if (await portInUse(port)) problems.push(`loopback port ${port} is already in use by something else`);
    }
    // The CI network must not overlap any existing network on the host (other projects' bridges included).
    try {
      const { stdout: nets } = await pexec("docker", ["network", "ls", "-q"]);
      const ids = nets.trim().split("\n").filter(Boolean);
      if (ids.length) {
        const { stdout } = await pexec("docker", ["network", "inspect", ...ids, "--format", "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}"]);
        for (const line of stdout.trim().split("\n")) {
          const [name, ...subnets] = line.trim().split(/\s+/);
          if (name === this.L.project) continue;
          for (const sn of subnets) if (sn && cidrOverlap(sn, this.L.subnet)) problems.push(`subnet ${this.L.subnet} overlaps network '${name}' (${sn})`);
        }
      }
    } catch (e) { problems.push(`could not list container networks: ${errLine(e)}`); }
    if (m.settings.workerCapabilities.split(",").some((c) => c.trim() === "release" || c.trim() === "deploy")) problems.push("the shared-host build worker must not be granted release/deploy capabilities");
    return { problems, identities };
  }

  async identity(ref: string): Promise<Identity> {
    const { stdout } = await pexec("node", [this.L.identityScript, "identity", ref], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  }

  // ───────── stage (immutable release directory) ─────────
  async stage(m: ReleaseManifest, bundleDir: string): Promise<string> {
    const compose = readFileSync(join(bundleDir, "compose.yml"), "utf8");
    const digest = createHash("sha256").update(canonicalJson(m)).update("\0").update(compose).digest("hex");
    const target = this.rel(m.releaseId);
    if (existsSync(target)) {
      const existing = readFileSync(join(target, "RELEASE_DIGEST"), "utf8").trim();
      if (existing !== digest) throw new Error(`release ${m.releaseId} already staged with different content (${existing.slice(0, 12)} ≠ ${digest.slice(0, 12)}); release ids are immutable`);
      return digest;
    }
    const tmp = join(this.L.root, "releases", `.staging-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(join(tmp, "release.json"), JSON.stringify(m, null, 2) + "\n");
      writeFileSync(join(tmp, "compose.yml"), compose);
      writeFileSync(join(tmp, "release.env"), renderEnv(this.composeEnv(m)));
      writeFileSync(join(tmp, "worker.env"), renderEnv(this.workerEnv(m)));
      // Worker runtime comes out of the pinned control image: the worker runs the same bytes as the control plane.
      const name = `bci-extract-${randomUUID()}`;
      await pexec("docker", ["create", "--name", name, m.images.control.ref]);
      try {
        await pexec("docker", ["cp", `${name}:/app`, join(tmp, "app")]);
        mkdirSync(join(tmp, "runtime"));
        await pexec("docker", ["cp", "-L", `${name}:/usr/local/bin/node`, join(tmp, "runtime", "node")]);
      } finally { await pexec("docker", ["rm", "-f", name]).catch(() => {}); }
      // The compose file must render with this release's configuration before anything changes.
      await pexec("docker", ["compose", "-p", this.L.project, "--env-file", join(tmp, "release.env"), "-f", join(tmp, "compose.yml"), "config", "-q"]);
      writeFileSync(join(tmp, "RELEASE_DIGEST"), digest + "\n");
      renameSync(tmp, target);
    } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
    return digest;
  }

  composeEnv(m: ReleaseManifest): Record<string, string> {
    return {
      BCI_CONTROL_IMAGE: m.images.control.ref, BCI_FELTDB_IMAGE: m.images.feltdb.ref, BCI_CANARY_IMAGE: m.images.canary.ref,
      BCI_REVISION: m.revision, BCI_ETC: this.L.etc, BCI_VAR: this.L.var,
      BCI_PORT_CONTROL: String(this.L.portControl), BCI_PORT_FELTDB: String(this.L.portFeltdb), BCI_SUBNET: this.L.subnet,
      BCI_NETWORK: `${this.L.project}`, BCI_CAS_MIN_FREE_BYTES: String(m.settings.casMinFreeBytes), BCI_LEASE_MS: String(m.settings.leaseMs ?? 60_000),
      BCI_GITHUB_APP_ID: m.settings.githubAppId ?? "", BCI_GITHUB_INSTALLATIONS: m.settings.githubInstallations ?? "",
      BCI_PUBLIC_URL: m.settings.publicHost ? `https://${m.settings.publicHost}` : "",
      BCI_GITHUB_KEY_FILE: m.settings.requireGithubApp ? "/run/secrets/github-app.pem" : "",
    };
  }

  workerEnv(m: ReleaseManifest): Record<string, string> {
    return {
      BCI_CONTROL_URL: `http://127.0.0.1:${this.L.portControl}`, BCI_WORKER_TOKEN_FILE: this.secret("worker", "token"),
      BCI_CAPABILITIES: m.settings.workerCapabilities, BCI_WORK_ROOT: join(this.L.var, "work"), BCI_OCI_CLI: m.settings.ociCli,
      BCI_REVISION: m.revision, ...(m.settings.egressCaFile ? { BCI_EGRESS_CA_FILE: m.settings.egressCaFile } : {}),
    };
  }

  // ───────── activate ─────────
  #compose(id: string, ...args: string[]) {
    return pexec("docker", ["compose", "-p", this.L.project, "--env-file", join(this.rel(id), "release.env"), "-f", join(this.rel(id), "compose.yml"), ...args], { maxBuffer: 16 * 1024 * 1024 });
  }

  async activate(id: string): Promise<void> {
    const m = this.manifest(id);
    this.#setPointer("active", id);
    await this.#compose(id, "up", "-d", "--no-build", "--pull", "never");
    await this.#waitFeltdb(60_000);
    await this.#ensureWorkerIdentity(id, m);
    await this.#restartWorker(id);
  }

  manifest(id: string): ReleaseManifest { return JSON.parse(readFileSync(join(this.rel(id), "release.json"), "utf8")); }

  async #waitFeltdb(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if ((await fetch(`http://127.0.0.1:${this.L.portFeltdb}/ready`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* starting */ }
      await sleep(500);
    }
    throw new Error("CI FeltDB did not become ready");
  }

  async #ensureWorkerIdentity(id: string, m: ReleaseManifest) {
    const tokenFile = this.secret("worker", "token");
    const caps = m.settings.workerCapabilities.split(",").map((c) => c.trim()).filter(Boolean);
    const args = ["run", "--rm", "--no-deps", "-T", "ci-control", "admin", "ensure-worker", this.L.workerId, ...caps];
    if (!existsSync(tokenFile)) args.push("--rotate");
    const { stdout } = await this.#compose(id, ...args);
    const token = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!existsSync(tokenFile)) {
      if (!token.startsWith("bci_w_")) throw new Error("worker identity: no token returned");
      writeFileSync(tokenFile, token, { mode: 0o400 });
      chownSync(tokenFile, this.L.workerUid ?? 0, this.L.workerUid ?? 0);
    }
  }

  async #restartWorker(id: string) {
    if (this.L.workerDriver === "systemd") {
      await pexec("systemctl", ["restart", this.L.workerUnit]);
      return;
    }
    await this.stopWorkerProcess();
    const env = parseEnv(readFileSync(join(this.rel(id), "worker.env"), "utf8"));
    const out = openSync(join(this.L.var, "worker.log"), "a");
    const child = spawn(join(this.rel(id), "runtime", "node"), [join(this.rel(id), "app", "bin", "boundry-ci.ts"), "worker"], {
      detached: true, stdio: ["ignore", out, out], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_NO_WARNINGS: "1", ...env },
    });
    child.unref();
    writeFileSync(join(this.L.var, "worker.pid"), String(child.pid));
  }

  /** Process driver only: SIGTERM, allow the in-flight job to drain, then SIGKILL. */
  async stopWorkerProcess() {
    const pidFile = join(this.L.var, "worker.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (alive(pid)) {
      process.kill(pid, "SIGTERM");
      const until = Date.now() + this.L.drainTimeoutMs;
      while (alive(pid) && Date.now() < until) await sleep(200);
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(pidFile, { force: true });
  }

  // ───────── verify (independent health) ─────────
  async verify(id: string, opts: { canary?: boolean } = {}): Promise<{ ok: boolean; checks: Check[] }> {
    const m = this.manifest(id);
    const op = readFileSync(this.secret("deployer", "operator-token"), "utf8").trim();
    const H = { authorization: `Bearer ${op}` };
    const base = `http://127.0.0.1:${this.L.portControl}`;
    const deadline = Date.now() + this.L.verifyTimeoutMs;
    const last = new Map<string, Check>();
    const ids = {
      control: (await this.identity(m.images.control.ref)).id,
      feltdb: (await this.identity(m.images.feltdb.ref)).id,
    };

    const checks: Record<string, () => Promise<string>> = {
      "containers run the pinned images": async () => {
        const out: string[] = [];
        for (const [svc, want] of [["ci-feltdb", ids.feltdb], ["ci-control", ids.control]] as const) {
          const { stdout } = await this.#compose(id, "ps", "-q", svc);
          const cid = stdout.trim();
          if (!cid) throw new Error(`${svc}: no container`);
          const { stdout: insp } = await pexec("docker", ["inspect", cid, "--format", "{{.State.Running}} {{.Image}}"]);
          const [running, image] = insp.trim().split(" ");
          if (running !== "true") throw new Error(`${svc}: not running`);
          if (image !== want) throw new Error(`${svc}: runs ${image.slice(0, 19)}, expected ${want.slice(0, 19)}`);
          out.push(`${svc}=${image.slice(7, 19)}`);
        }
        return out.join(" ");
      },
      "FeltDB ready, authenticated, storage writable": async () => {
        const r = await getJson(`http://127.0.0.1:${this.L.portFeltdb}/ready`);
        if (r.status !== "ready" || r.authentication !== true || r.storage !== "writable") throw new Error(JSON.stringify(r));
        return `instance ${r.instance_id}`;
      },
      "control plane serves the release revision": async () => {
        const v = await getJson(`${base}/v1/diag/version`, H);
        if (v.revision !== m.revision) throw new Error(`serving ${v.revision}, expected ${m.revision}`);
        return `revision ${v.revision.slice(0, 12)} since ${v.startedAt}`;
      },
      "FeltDB write/read/delete + every CI collection + artifact store write/read/hash": async () => {
        const r = await getJson(`${base}/v1/diag/probe`, H, "POST");
        if (!r.ok) throw new Error(JSON.stringify(r));
        return `feltdb ${r.feltdb.writeReadDeleteMs}ms, cas ${r.cas.writeVerifyReadMs}ms, cas free ${Math.round(r.cas.freeBytes / 2 ** 30)} GiB`;
      },
      "worker registered with the release revision": async () => {
        const s = await getJson(`${base}/v1/diag/summary`, H);
        const w = s.workers.find((x: any) => x.id === this.L.workerId);
        if (!w) throw new Error("worker not registered");
        if (w.revision !== m.revision) throw new Error(`worker revision ${w.revision}, expected ${m.revision}`);
        if (w.lastSeenSecondsAgo === null || w.lastSeenSecondsAgo > 60) throw new Error(`worker last seen ${w.lastSeenSecondsAgo}s ago`);
        return `${w.id} [${w.capabilities.join(",")}] seen ${w.lastSeenSecondsAgo}s ago`;
      },
    };

    const runAll = async () => {
      for (const [name, f] of Object.entries(checks)) {
        if (last.get(name)?.ok) continue;
        try { last.set(name, { name, ok: true, detail: await f() }); }
        catch (e) { last.set(name, { name, ok: false, detail: String((e as Error).message).slice(0, 300) }); }
      }
      return [...last.values()].every((c) => c.ok);
    };
    let basic = await runAll();
    while (!basic && Date.now() < deadline) { await sleep(1000); basic = await runAll(); }

    if (basic && opts.canary !== false) {
      const name = "canary job leased, executed in isolation, artifact stored, by this release's worker";
      const canaryDeadline = Date.now() + this.L.verifyTimeoutMs; // its own budget, not what basic checks left over
      try {
        const { runId } = await getJson(`${base}/v1/diag/canary`, H, "POST");
        let run: any;
        while (Date.now() < canaryDeadline) {
          run = await getJson(`${base}/v1/runs/${runId}`, H);
          if (run.state !== "running") break;
          await sleep(1000);
        }
        if (run?.state !== "succeeded") throw new Error(`canary ${runId} is '${run?.state}'`);
        const [job] = await getJson(`${base}/v1/runs/${runId}/jobs`, H);
        const log = await (await fetch(`${base}/v1/attempts/${job.attemptId}/log`, { headers: H })).text();
        if (!log.includes(`worker-revision ${m.revision}`)) throw new Error("canary was not executed by this release's worker");
        if (!/uid=(?!0\b)\d+/.test(log)) throw new Error("canary did not prove a non-root job uid");
        if (!log.includes("artifact canary.txt sha256:")) throw new Error("canary artifact not stored");
        last.set(name, { name, ok: true, detail: `${runId} attempt ${job.attemptId}` });
      } catch (e) { last.set(name, { name, ok: false, detail: String((e as Error).message).slice(0, 300) }); }
    }
    const list = [...last.values()];
    return { ok: list.every((c) => c.ok) && (opts.canary === false || list.length === Object.keys(checks).length + 1), checks: list };
  }

  // ───────── apply / rollback ─────────
  async apply(bundleDir: string): Promise<Outcome> {
    const m: ReleaseManifest = JSON.parse(readFileSync(join(bundleDir, "release.json"), "utf8"));
    return this.#locked(async (deploymentId) => {
      const prev = this.pointer("current");
      this.journal.append(deploymentId, "started", m.releaseId, { previous: prev, bundle: resolve(bundleDir), secretFingerprints: this.#fingerprints() });
      const { problems } = await this.preflight(m, bundleDir);
      if (problems.length) {
        this.journal.append(deploymentId, "refused", m.releaseId, { problems });
        return { ok: false, event: "refused", releaseId: m.releaseId, deploymentId, problems };
      }
      let digest: string;
      try { digest = await this.stage(m, bundleDir); }
      catch (e) {
        this.journal.append(deploymentId, "refused", m.releaseId, { problems: [`stage: ${(e as Error).message}`] });
        return { ok: false, event: "refused", releaseId: m.releaseId, deploymentId, problems: [(e as Error).message] };
      }
      if (prev === m.releaseId && this.pointer("active") === m.releaseId) {
        const v = await this.verify(m.releaseId);
        if (v.ok) {
          this.journal.append(deploymentId, "noop_verified", m.releaseId, { releaseDigest: digest, checks: v.checks });
          return { ok: true, event: "noop_verified", releaseId: m.releaseId, deploymentId, checks: v.checks };
        }
        this.journal.append(deploymentId, "failed", m.releaseId, { reason: "current release failed verification; re-activating it", checks: v.checks });
      }
      return this.#activateVerifyCommit(deploymentId, m.releaseId, prev, { releaseDigest: digest });
    });
  }

  /** Re-activate the previously committed release (manual rollback). */
  async rollback(): Promise<Outcome> {
    return this.#locked(async (deploymentId) => {
      const cur = this.pointer("current");
      const history = this.journal.committed();
      const target = [...history].reverse().find((r) => r !== cur && existsSync(this.rel(r)));
      if (!target) {
        this.journal.append(deploymentId, "refused", cur, { problems: ["no earlier committed release to roll back to"] });
        return { ok: false, event: "refused", releaseId: cur ?? "", deploymentId, problems: ["no earlier committed release"] };
      }
      this.journal.append(deploymentId, "started", target, { previous: cur, manualRollback: true, secretFingerprints: this.#fingerprints() });
      return this.#activateVerifyCommit(deploymentId, target, cur, { manualRollback: true });
    });
  }

  async #activateVerifyCommit(deploymentId: string, id: string, prev: string | null, extra: Record<string, unknown>): Promise<Outcome> {
    let checks: Check[] = [];
    let failure: string | null = null;
    try {
      await this.activate(id);
      this.journal.append(deploymentId, "activated", id, {});
      const v = await this.verify(id);
      checks = v.checks;
      if (!v.ok) failure = "health verification failed";
    } catch (e) { failure = `activation failed: ${errLine(e)}`; }

    if (!failure) {
      this.journal.append(deploymentId, "verified", id, { checks });
      this.#setPointer("current", id);
      this.journal.append(deploymentId, "committed", id, { previous: prev, ...extra });
      this.#prune();
      return { ok: true, event: "committed", releaseId: id, deploymentId, checks };
    }

    this.journal.append(deploymentId, "failed", id, { reason: failure, checks });
    if (prev === id) {
      // Re-activation of the committed release failed. There is nothing safer to return to automatically,
      // and tearing down a committed installation is never automatic: leave it and report.
      return { ok: false, event: "failed", releaseId: id, deploymentId, checks, restored: null };
    }
    if (prev) {
      try {
        await this.activate(prev);
        const v = await this.verify(prev);
        if (v.ok) {
          this.journal.append(deploymentId, "rolled_back", id, { restored: prev, checks: v.checks });
          return { ok: false, event: "rolled_back", releaseId: id, deploymentId, checks, restored: prev };
        }
        this.journal.append(deploymentId, "rollback_failed", id, { restored: prev, reason: "previous release failed verification", checks: v.checks });
      } catch (e) {
        this.journal.append(deploymentId, "rollback_failed", id, { restored: prev, reason: errLine(e) });
      }
      return { ok: false, event: "rollback_failed", releaseId: id, deploymentId, checks, restored: null };
    }
    // First install failed: remove what was started (volumes are kept for diagnosis).
    try {
      if (this.L.workerDriver === "systemd") await pexec("systemctl", ["stop", this.L.workerUnit]).catch(() => {});
      else await this.stopWorkerProcess();
      await this.#compose(id, "down", "--remove-orphans");
    } catch { /* recorded below */ }
    this.#setPointer("active", null);
    this.journal.append(deploymentId, "aborted_first_install", id, { reason: failure });
    return { ok: false, event: "aborted_first_install", releaseId: id, deploymentId, checks };
  }

  async #locked<T>(f: (deploymentId: string) => Promise<T>): Promise<T> {
    const lock = join(this.L.var, "deploy.lock");
    mkdirSync(this.L.var, { recursive: true });
    try { mkdirSync(lock); }
    catch {
      const holder = Number(readFileSync(join(lock, "pid"), "utf8").trim() || 0);
      if (alive(holder)) throw new Error(`another deployment is in progress (pid ${holder})`);
      rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); // stale lock from a crashed deploy
    }
    writeFileSync(join(lock, "pid"), String(process.pid));
    try { return await f(`dep_${new Date().toISOString().replace(/[-:.]/g, "")}_${randomUUID().slice(0, 8)}`); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }

  /** SHA-256 fingerprints of the secret files in use (evidence of which secret set ran; never the values). */
  #fingerprints(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of [["secrets", "feltdb.env"], ["secrets", "control", "feltdb-token"], ["secrets", "control", "operators"], ["secrets", "control", "github-webhook"], ["secrets", "control", "github-app.pem"], ["worker", "token"]]) {
      const f = this.secret(...p);
      if (existsSync(f)) out[p.join("/")] = createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
    }
    return out;
  }

  #prune(keep = 5) {
    const dir = join(this.L.root, "releases");
    const pinned = new Set([this.pointer("current"), this.pointer("active")]);
    const recent = [...new Set(this.journal.committed().reverse())].slice(0, keep);
    for (const r of readdirSync(dir)) {
      if (r.startsWith(".staging-")) { rmSync(join(dir, r), { recursive: true, force: true }); continue; }
      if (!pinned.has(r) && !recent.includes(r)) rmSync(join(dir, r), { recursive: true, force: true });
    }
  }

  // ───────── backup / restore ─────────

  backupsDir() { return process.env.BCI_DEPLOY_BACKUPS ?? join(this.L.var, "..", "..", "backups", "boundry-ci"); }

  /**
   * One checksummed backup set: FeltDB online backup bundle (via POST /admin/backups with the cluster:write key),
   * the artifact objects it references (content-addressed, copied once into a shared append-only pool), the active
   * release definition and the deployment journal. Keeps the newest `keep` sets.
   */
  async backup(dir = this.backupsDir(), keep = 48): Promise<{ set: string; feltdbFiles: number; casObjects: number }> {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const set = join(dir, stamp);
    const id = this.pointer("active");
    try {
      if (!id) throw new Error("nothing is installed");
      mkdirSync(set, { recursive: true, mode: 0o700 });
      const bundle = `ci-${stamp}`;
      const key = readFileSync(this.secret("secrets", "backup-token"), "utf8").trim();
      const r = await fetch(`http://127.0.0.1:${this.L.portFeltdb}/admin/backups`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ output: bundle }), signal: AbortSignal.timeout(300_000) });
      const reply = await r.text();
      if (!r.ok || !reply.includes('"entries"')) throw new Error(`FeltDB online backup: HTTP ${r.status}`);
      const src = join(this.L.var, "feltdb", "backups", bundle);
      if (!existsSync(src)) throw new Error(`server reported a bundle but ${src} does not exist`);
      await pexec("cp", ["-a", src, join(set, "feltdb")]);
      rmSync(src, { recursive: true, force: true }); // the volume does not accumulate bundles
      // Artifacts: copy each object once into the pool; the set records which digests it needs.
      const casRoot = join(this.L.var, "data", "cas", "sha256");
      const pool = join(dir, "cas", "sha256");
      const digests: string[] = [];
      if (existsSync(casRoot)) for (const pre of readdirSync(casRoot)) for (const hex of readdirSync(join(casRoot, pre))) {
        digests.push(hex);
        const dst = join(pool, pre, hex);
        if (!existsSync(dst)) { mkdirSync(join(pool, pre), { recursive: true }); await pexec("cp", ["-p", join(casRoot, pre, hex), dst]); }
        const h = createHash("sha256").update(readFileSync(dst)).digest("hex");
        if (h !== hex) throw new Error(`artifact ${hex} corrupted in backup pool`);
      }
      writeFileSync(join(set, "cas-objects.txt"), digests.sort().join("\n") + (digests.length ? "\n" : ""));
      mkdirSync(join(set, "release"));
      for (const f of ["release.json", "compose.yml", "RELEASE_DIGEST"]) await pexec("cp", [join(this.rel(id), f), join(set, "release", f)]);
      await pexec("cp", [this.journal.path, join(set, "deployments.jsonl")]);
      await pexec("sh", ["-c", "find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS"], { cwd: set });
      const feltdbFiles = Number((await pexec("sh", ["-c", "find feltdb -type f | wc -l"], { cwd: set })).stdout.trim());
      // Retention, then drop pool objects no remaining set references.
      const sets = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort();
      for (const old of sets.slice(0, Math.max(0, sets.length - keep))) rmSync(join(dir, old), { recursive: true, force: true });
      const needed = new Set(readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).flatMap((n) => readFileSync(join(dir, n, "cas-objects.txt"), "utf8").split("\n").filter(Boolean)));
      if (existsSync(pool)) for (const pre of readdirSync(pool)) for (const hex of readdirSync(join(pool, pre))) if (!needed.has(hex)) rmSync(join(pool, pre, hex));
      this.journal.append(`bkp_${stamp}`, "backup_completed", id, { set, feltdbFiles, casObjects: digests.length });
      return { set, feltdbFiles, casObjects: digests.length };
    } catch (e) {
      this.journal.append(`bkp_${stamp}`, "backup_failed", id, { set, reason: errLine(e) });
      throw e;
    }
  }

  /**
   * Restore a backup set (explicit operator action, causes downtime). Verifies checksums, verifies the bundle with
   * feltdb-server itself, moves the current data aside (never deletes it), restores, restarts, and runs full health
   * verification. Mirrors appboundry/deploy/boundry/restore-instance.sh.
   */
  async restore(set: string): Promise<Outcome> {
    return this.#locked(async (deploymentId) => {
      const id = this.pointer("active");
      if (!id) throw new Error("nothing is installed; run deploy apply first");
      const m = this.manifest(id);
      this.journal.append(deploymentId, "restore_started", id, { set });
      try {
        await pexec("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: set });
        if (this.L.workerDriver === "systemd") await pexec("systemctl", ["stop", this.L.workerUnit]); else await this.stopWorkerProcess();
        await this.#compose(id, "stop", "ci-control", "ci-feltdb");
        const scratch = join(this.L.var, `restore-${randomUUID()}`);
        mkdirSync(join(scratch, "out"), { recursive: true });
        await pexec("cp", ["-a", join(set, "feltdb"), join(scratch, "in")]);
        await pexec("chown", ["-R", `${UID.feltdb}:${UID.feltdb}`, scratch]);
        const run = ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${UID.feltdb}:${UID.feltdb}`, "--entrypoint", "/usr/local/bin/feltdb-server"];
        await pexec("docker", [...run, "-v", `${join(scratch, "in")}:/in`, m.images.feltdb.ref, "backup", "verify", "/in"]);
        await pexec("docker", [...run, "-v", `${join(scratch, "in")}:/in:ro`, "-v", `${join(scratch, "out")}:/out`, m.images.feltdb.ref, "backup", "restore", "--archive", "/in", "--output", "/out/restored"]);
        const data = join(this.L.var, "feltdb");
        const moved = `${data}.replaced-${new Date().toISOString().replace(/[-:.]/g, "")}`;
        renameSync(data, moved);
        mkdirSync(data, { mode: 0o700 });
        const files = join(scratch, "out", "restored", "files");
        for (const base of readdirSync(files)) {
          const target = base === "state.log" ? "feltdb.log" : base === "audit.log" ? "feltdb.audit.log" : base === "api-keys.json" ? "api-keys.json" : base.startsWith("state.") ? `feltdb.${base.slice(6)}` : null;
          if (target) await pexec("cp", ["-a", join(files, base), join(data, target)]);
        }
        if (!existsSync(join(data, "feltdb.log"))) throw new Error("restored data has no state log");
        await pexec("chown", ["-R", `${UID.feltdb}:${UID.feltdb}`, data]);
        rmSync(scratch, { recursive: true, force: true });
        // Artifacts referenced by the set that are missing locally come back from the pool (existing objects are immutable).
        const pool = join(set, "..", "cas", "sha256");
        let casRestored = 0;
        for (const hex of readFileSync(join(set, "cas-objects.txt"), "utf8").split("\n").filter(Boolean)) {
          const dst = join(this.L.var, "data", "cas", "sha256", hex.slice(0, 2), hex);
          if (existsSync(dst)) continue;
          mkdirSync(dirnameOf(dst), { recursive: true });
          await pexec("cp", ["-p", join(pool, hex.slice(0, 2), hex), dst]);
          casRestored++;
        }
        await pexec("chown", ["-R", `${UID.control}:${UID.control}`, join(this.L.var, "data")]);
        await this.activate(id);
        const v = await this.verify(id);
        if (!v.ok) throw new Error(`restored installation failed verification: ${v.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
        this.journal.append(deploymentId, "restored", id, { set, movedAside: moved, casRestored, checks: v.checks });
        return { ok: true, event: "restored", releaseId: id, deploymentId, checks: v.checks };
      } catch (e) {
        this.journal.append(deploymentId, "restore_failed", id, { set, reason: errLine(e) });
        return { ok: false, event: "restore_failed", releaseId: id, deploymentId, problems: [errLine(e)] };
      }
    });
  }

  /** Read-only status: pointers, recent journal, service state. Never prints secrets. */
  async status(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { current: this.pointer("current"), active: this.pointer("active") };
    let entries; try { entries = this.journal.read(); out.journalIntegrity = "ok"; } catch (e) { entries = []; out.journalIntegrity = (e as Error).message; }
    out.recentDeployments = entries.slice(-12).map((e) => ({ seq: e.seq, at: e.at, deploymentId: e.deploymentId, event: e.event, releaseId: e.releaseId, reason: e.data.reason ?? e.data.problems ?? undefined, restored: e.data.restored }));
    const id = this.pointer("active");
    if (id) {
      try { out.services = (await this.#compose(id, "ps", "--format", "{{.Service}} {{.State}} {{.Status}}")).stdout.trim().split("\n"); } catch (e) { out.services = `unavailable: ${errLine(e)}`; }
      try {
        const op = readFileSync(this.secret("deployer", "operator-token"), "utf8").trim();
        out.control = await getJson(`http://127.0.0.1:${this.L.portControl}/v1/diag/summary`, { authorization: `Bearer ${op}` });
      } catch (e) { out.control = `unavailable: ${(e as Error).message}`; }
    }
    return out;
  }
}

function lastLineKey(stdout: string): string {
  const key = stdout.trim().split("\n").pop()!.trim();
  if (key.length < 20) throw new Error("FeltDB key creation returned no key");
  return key;
}

export interface Identity { configDigest: string; layers: string[]; id: string; store: string }

async function getJson(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<any> {
  const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let j: any; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${new URL(url).pathname}: HTTP ${r.status} non-JSON`); }
  if (!r.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

function renderEnv(o: Record<string, string>): string {
  return Object.entries(o).map(([k, v]) => {
    if (/[\n\r]/.test(v)) throw new Error(`${k} contains a newline`);
    return `${k}=${v}`;
  }).join("\n") + "\n";
}
export function parseEnv(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const l of s.split("\n")) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l); if (m) o[m[1]] = m[2]; }
  return o;
}
function alive(pid: number): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function portInUse(port: number): Promise<boolean> {
  return new Promise((res) => { const s = connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
}
export function cidrOverlap(a: string, b: string): boolean {
  const parse = (c: string) => {
    const [ip, bits] = c.split("/");
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null; // IPv6 networks cannot overlap an IPv4 subnet
    const n = ip.split(".").reduce((x, o) => x * 256 + Number(o), 0);
    const m = Number(bits);
    const size = 2 ** (32 - m);
    return [Math.floor(n / size) * size, Math.floor(n / size) * size + size - 1];
  };
  const x = parse(a), y = parse(b);
  return !!x && !!y && x[0] <= y[1] && y[0] <= x[1];
}

/** One-line, operator-readable error: the failing step plus the command's last stderr line (never env or secrets). */
export function errLine(e: unknown): string {
  const err = e as Error & { stderr?: string; cmd?: string };
  const first = String(err.message ?? err).split("\n")[0].replace(/--env-file \S+ /g, "").slice(0, 200);
  const tail = (err.stderr ?? "").trim().split("\n").filter(Boolean).pop()?.slice(0, 300);
  return tail ? `${first} :: ${tail}` : first;
}
const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

