// Isolated job execution through an OCI CLI (docker or podman; identical flags).
// Boundaries: non-root uid inside the container, all capabilities dropped, no-new-privileges,
// read-only root filesystem, tmpfs /tmp, pids/memory/cpu limits, no network unless the job
// declares `network: egress`, no container-runtime socket, ephemeral workspace, wall-clock timeout,
// polled workspace disk quota. Container isolation is one boundary, not a guarantee against
// hostile code; untrusted jobs additionally never receive secrets or trusted caches.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { PlanJob } from "../spec/compile.ts";

export interface ExecInput {
  job: PlanJob;
  workspace: string; // host path with the checked-out source, mounted at /workspace
  repository: string;
  trusted: boolean;
  secrets: Record<string, string>;
  onOutput: (text: string) => void;
  signal: AbortSignal; // aborted on cancel / lost lease
}
export interface ExecResult { exitCode: number | null; timedOut: boolean; cancelled: boolean; diskExceeded: boolean; reason: string | null }

export interface ExecutorOptions {
  cli?: string; jobUid?: string; cacheSchema?: string; diskPollMs?: number;
  /** Operator setting: CA bundle of the worker's egress proxy, mounted read-only for `network: egress` jobs only. */
  egressCaFile?: string;
}

export class OciExecutor {
  readonly cli: string;
  readonly jobUid: string;
  readonly cacheSchema: string;
  readonly diskPollMs: number;
  readonly egressCaFile: string | undefined;
  constructor(o: ExecutorOptions = {}) {
    this.egressCaFile = o.egressCaFile;
    this.cli = o.cli ?? "docker";
    this.jobUid = o.jobUid ?? "65534:65534";
    this.cacheSchema = o.cacheSchema ?? "1";
    this.diskPollMs = o.diskPollMs ?? 5_000;
  }

  /** Cache volume name: trust-scoped so untrusted jobs can never write a cache trusted jobs read. */
  cacheVolume(repository: string, job: PlanJob, cache: PlanJob["cache"][number], workspace: string, trusted: boolean): string {
    const h = createHash("sha256");
    h.update(`schema=${this.cacheSchema}\0repo=${repository}\0name=${cache.name}\0image=${job.image}\0caps=${job.requires.join(",")}\0`);
    for (const f of cache.keyFiles) {
      const p = safeJoin(workspace, f);
      h.update(`file=${f}\0`);
      h.update(p && existsSync(p) ? readFileSync(p) : Buffer.from("<absent>"));
    }
    return `bci-cache-${trusted ? "t" : "u"}-${h.digest("hex").slice(0, 32)}`;
  }

  /** New volumes are root-owned; hand them to the job uid with a fixed, network-less command. */
  async #prepareVolume(vol: string, image: string): Promise<void> {
    const exists = await new Promise<boolean>((r) => spawn(this.cli, ["volume", "inspect", vol], { stdio: "ignore" }).on("close", (c) => r(c === 0)));
    if (exists) return;
    await new Promise<void>((res, rej) => spawn(this.cli, ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--user", "0:0",
      "--label", "com.boundry.owner=boundry-ci", "-v", `${vol}:/c`, "--entrypoint", "chown", image, this.jobUid, "/c"], { stdio: "ignore" })
      .on("close", (c) => (c === 0 ? res() : rej(new Error(`cache volume init failed (${c})`)))));
  }

  async run(x: ExecInput): Promise<ExecResult> {
    const { job } = x;
    const name = `bci-${randomUUID()}`;
    const secretDir = mkdtempSync(join(tmpdir(), "bci-env-"));
    const envFile = join(secretDir, "env");
    const env: Record<string, string> = { ...job.env, CI: "true", BOUNDRY_CI: "true", HOME: "/tmp", ...(x.trusted ? x.secrets : {}) };
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v.replace(/\n/g, "\\n")}`).join("\n") + "\n", { mode: 0o600 });

    const script = job.steps.map((s) => `printf '%s\\n' ${shq(`::step:: ${s.name}`)}\n${s.run}`).join("\n");
    const scriptPath = join(x.workspace, ".boundry-ci-steps.sh");
    writeFileSync(scriptPath, `set -eu\n${script}\n`, { mode: 0o755 });
    chmodSync(x.workspace, 0o777);

    const args = [
      "run", "--rm", "--name", name,
      "--user", this.jobUid,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--pids-limit", String(job.resources.pids),
      "--memory", `${job.resources.memoryMb}m`, "--memory-swap", `${job.resources.memoryMb}m`,
      "--cpus", String(job.resources.cpus),
      "--network", job.network === "egress" ? "bridge" : "none",
      "--env-file", envFile,
      "-v", `${x.workspace}:/workspace:rw`, "-w", "/workspace",
      "--label", "com.boundry.owner=boundry-ci",
    ];
    if (job.network === "egress" && this.egressCaFile) {
      args.push("-v", `${this.egressCaFile}:/etc/boundry-ci/egress-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/boundry-ci/egress-ca.crt", "-e", "PIP_CERT=/etc/boundry-ci/egress-ca.crt", "-e", "CARGO_HTTP_CAINFO=/etc/boundry-ci/egress-ca.crt");
    }
    // Release/deploy jobs never mount caches: their inputs must come from verified artifacts only.
    if (!job.permissions.release && !job.permissions.deploy) {
      for (const c of job.cache) {
        const vol = this.cacheVolume(x.repository, job, c, x.workspace, x.trusted);
        await this.#prepareVolume(vol, job.image);
        args.push("-v", `${vol}:${c.path}:rw`);
      }
    }
    args.push(job.image, "sh", "/workspace/.boundry-ci-steps.sh");

    let timedOut = false, cancelled = false, diskExceeded = false;
    const child = spawn(this.cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => { spawn(this.cli, ["kill", name], { stdio: "ignore" }); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, job.timeoutMinutes * 60_000);
    const onAbort = () => { cancelled = true; kill(); };
    x.signal.addEventListener("abort", onAbort, { once: true });
    const diskTimer = setInterval(async () => {
      if ((await duBytes(x.workspace)) > job.resources.diskMb * 1024 * 1024) { diskExceeded = true; kill(); }
    }, this.diskPollMs);
    child.stdout.on("data", (d) => x.onOutput(d.toString("utf8")));
    child.stderr.on("data", (d) => x.onOutput(d.toString("utf8")));
    const exitCode: number | null = await new Promise((res) => child.on("close", (code) => res(code)));
    clearTimeout(timer); clearInterval(diskTimer);
    x.signal.removeEventListener("abort", onAbort);
    rmSync(secretDir, { recursive: true, force: true });
    rmSync(scriptPath, { force: true });
    const reason = timedOut ? `timed out after ${job.timeoutMinutes}m`
      : cancelled ? "cancelled"
      : diskExceeded ? `workspace exceeded ${job.resources.diskMb} MiB`
      : exitCode === 137 ? "killed (out of memory or signal)"
      : exitCode === 0 ? null : `exit code ${exitCode}`;
    return { exitCode, timedOut, cancelled, diskExceeded, reason };
  }
}

export function safeJoin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const p = resolve(root, rel);
  const r = relative(root, p);
  return r.startsWith("..") || isAbsolute(r) ? null : p;
}

export function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

async function duBytes(dir: string): Promise<number> {
  return new Promise((res) => {
    const p = spawn("du", ["-sb", dir], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(Number(out.split(/\s/)[0]) || 0));
  });
}

export function fileSizeIfRegular(p: string): number | null {
  try { const s = statSync(p); return s.isFile() ? s.size : null; } catch { return null; }
}
