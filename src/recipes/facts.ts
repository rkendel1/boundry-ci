// Project facts: what Boundry learns about a repository by READING files (never by running them).
// The same files always yield the same facts; facts are recorded with every compiled plan.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../canonical.ts";

export interface FileSource {
  /** Entries (files and directories, names only) in `dir` relative to the repository root, or null if absent. */
  list(dir: string): Promise<string[] | null>;
  read(path: string): Promise<string | null>;
}

export type Ecosystem = "node" | "bun" | "rust" | "go" | "python" | "zig";

export interface ProjectFacts {
  dir: string; // project directory relative to the repository root ("." for root)
  ecosystems: Ecosystem[]; // every ecosystem with evidence in `dir`
  node?: {
    packageManager: "npm" | "pnpm" | "yarn" | "bun" | null; // null = no lockfile
    lockfile: string | null;
    scripts: Record<string, string>;
    workspaces: boolean;
    hints: { main?: string; files?: string[] };
  };
  rust?: { lockfile: boolean; workspace: boolean; packageName: string | null; edition: string | null };
  go?: { module: string | null };
  python?: { lockfile: string | null; pyproject: boolean; requirements: boolean };
  evidence: string[]; // files that produced these facts
}

const LOCKS: [string, NonNullable<ProjectFacts["node"]>["packageManager"]][] = [
  ["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
];

export async function gatherFacts(src: FileSource, dir = "."): Promise<ProjectFacts> {
  const p = (f: string) => (dir === "." ? f : `${dir}/${f}`);
  const entries = new Set((await src.list(dir)) ?? []);
  const facts: ProjectFacts = { dir, ecosystems: [], evidence: [] };

  if (entries.has("package.json")) {
    let pkg: any = {};
    try { pkg = JSON.parse((await src.read(p("package.json"))) ?? "{}"); } catch { pkg = {}; }
    const locks = LOCKS.filter(([f]) => entries.has(f));
    const pm = locks.length === 1 ? locks[0][1] : locks.length === 0 ? null : (null as any);
    facts.node = {
      packageManager: locks.length > 1 ? null : pm,
      lockfile: locks.length === 1 ? locks[0][0] : null,
      scripts: Object.fromEntries(Object.entries(pkg.scripts ?? {}).map(([k, v]) => [k, String(v)]).sort()),
      workspaces: Array.isArray(pkg.workspaces) || !!pkg.workspaces?.packages,
      hints: { ...(typeof pkg.main === "string" ? { main: pkg.main } : {}), ...(Array.isArray(pkg.files) ? { files: pkg.files.map(String) } : {}) },
    };
    if (locks.length > 1) facts.node.lockfile = locks.map(([f]) => f).join(",");
    facts.ecosystems.push(facts.node.packageManager === "bun" ? "bun" : "node");
    facts.evidence.push(p("package.json"), ...locks.map(([f]) => p(f)));
  }
  if (entries.has("Cargo.toml")) {
    const toml = (await src.read(p("Cargo.toml"))) ?? "";
    facts.rust = {
      lockfile: entries.has("Cargo.lock"),
      workspace: /^\[workspace\]/m.test(toml),
      packageName: /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null,
      edition: /^edition\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null,
    };
    facts.ecosystems.push("rust");
    facts.evidence.push(p("Cargo.toml"), ...(entries.has("Cargo.lock") ? [p("Cargo.lock")] : []));
  }
  if (entries.has("go.mod")) {
    facts.go = { module: /^module\s+(\S+)/m.exec((await src.read(p("go.mod"))) ?? "")?.[1] ?? null };
    facts.ecosystems.push("go");
    facts.evidence.push(p("go.mod"));
  }
  if (entries.has("pyproject.toml") || entries.has("requirements.txt")) {
    const lock = ["uv.lock", "poetry.lock"].find((f) => entries.has(f)) ?? null;
    facts.python = { lockfile: lock, pyproject: entries.has("pyproject.toml"), requirements: entries.has("requirements.txt") };
    facts.ecosystems.push("python");
    facts.evidence.push(...["pyproject.toml", "requirements.txt", lock].filter((f): f is string => !!f && entries.has(f)).map(p));
  }
  if (entries.has("build.zig")) { facts.ecosystems.push("zig"); facts.evidence.push(p("build.zig")); }
  facts.evidence.sort();
  return facts;
}

export const factsDigest = (f: ProjectFacts) => sha256Hex(canonicalJson(f));

/** Read facts from a local checkout (CLI, tests). */
export function localSource(root: string): FileSource {
  return {
    async list(dir) {
      try { return readdirSync(join(root, dir)).sort(); } catch { return null; }
    },
    async read(path) {
      try { const f = join(root, path); return statSync(f).isFile() ? readFileSync(f, "utf8") : null; } catch { return null; }
    },
  };
}

/** A script counts only if it does something (npm's generated "no test specified" stub does not). */
export function realScript(facts: ProjectFacts, name: string): string | null {
  const s = facts.node?.scripts[name];
  if (!s) return null;
  if (/no test specified/.test(s) && /exit 1/.test(s)) return null;
  return s;
}
