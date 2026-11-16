// Append-only, hash-chained, fsynced deployment journal. It is the authority for deployment
// history: it must work when FeltDB (which is itself being deployed) is unavailable.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical.ts";

export type DeployEvent =
  | "started" | "refused" | "noop_verified" | "activated" | "verified" | "committed"
  | "failed" | "rolled_back" | "rollback_failed" | "aborted_first_install"
  | "backup_completed" | "backup_failed" | "restore_started" | "restored" | "restore_failed";

export interface JournalEntry {
  seq: number; at: string; deploymentId: string; event: DeployEvent; releaseId: string | null;
  data: Record<string, unknown>; prevHash: string; hash: string;
}

export class Journal {
  readonly path: string;
  constructor(path: string) { this.path = path; mkdirSync(dirname(path), { recursive: true, mode: 0o750 }); }

  read(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const out: JournalEntry[] = [];
    let prev = "genesis";
    for (const [i, l] of lines.entries()) {
      const e = JSON.parse(l) as JournalEntry;
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || hashOf(rest) !== hash || e.seq !== i + 1) throw new Error(`deployment journal integrity failure at line ${i + 1}`);
      prev = hash; out.push(e);
    }
    return out;
  }

  append(deploymentId: string, event: DeployEvent, releaseId: string | null, data: Record<string, unknown> = {}): JournalEntry {
    const all = this.read();
    const base = { seq: all.length + 1, at: new Date().toISOString(), deploymentId, event, releaseId, data, prevHash: all.at(-1)?.hash ?? "genesis" };
    const entry: JournalEntry = { ...base, hash: hashOf(base) };
    const fd = openSync(this.path, "a", 0o640);
    try { writeSync(fd, JSON.stringify(entry) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    return entry;
  }

  /** Releases that were committed, oldest first (a release may appear more than once). */
  committed(): string[] { return this.read().filter((e) => e.event === "committed" || e.event === "rolled_back").map((e) => (e.event === "rolled_back" ? (e.data.restored as string) : e.releaseId!)); }
}

const hashOf = (o: unknown) => createHash("sha256").update(canonicalJson(o)).digest("hex");
