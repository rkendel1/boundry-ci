// Plain-git source adapter: any git host (or a local bare repository) as the source of truth.
// Reads files at exact commits from a local mirror; never reports commit statuses (git has no such concept).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ScmAdapter } from "./types.ts";

const pexec = promisify(execFile);

export class GitScmAdapter implements ScmAdapter {
  readonly provider = "git";
  readonly #template: string; readonly #cache: string;
  /** urlTemplate: e.g. "https://git.example.com/{repo}.git" or "file:///srv/git/{repo}.git" */
  constructor(urlTemplate: string, cacheDir: string) { this.#template = urlTemplate; this.#cache = cacheDir; }
  #url(repo: string) { return this.#template.replace("{repo}", repo); }
  async #mirror(repo: string, sha: string): Promise<string> {
    const dir = join(this.#cache, repo.replace("/", "__"));
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); await pexec("git", ["init", "-q", "--bare", dir]); }
    try { await pexec("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`]); }
    catch { await pexec("git", ["-C", dir, "fetch", "-q", "--depth", "1", this.#url(repo), sha], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
    return dir;
  }
  async readFile(repository: string, sha: string, path: string): Promise<string | null> {
    const dir = await this.#mirror(repository, sha);
    try { return (await pexec("git", ["-C", dir, "show", `${sha}:${path}`], { maxBuffer: 32 * 1024 * 1024 })).stdout; } catch { return null; }
  }
  async listFiles(repository: string, sha: string, d: string): Promise<string[] | null> {
    const dir = await this.#mirror(repository, sha);
    try { return (await pexec("git", ["-C", dir, "ls-tree", "--name-only", `${sha}:${d === "." ? "" : d}`])).stdout.trim().split("\n").filter(Boolean).sort(); } catch { return null; }
  }
  async resolveBranch(repository: string, branch: string): Promise<string | null> {
    const out = (await pexec("git", ["ls-remote", this.#url(repository), `refs/heads/${branch}`])).stdout.trim();
    return out.split(/\s+/)[0] || null;
  }
  async reportStatus(): Promise<void> { throw new Error("plain git has no commit statuses; recipes run through this adapter must not ask to report"); }
  async checkoutAuth(repository: string) { return { url: this.#url(repository) }; }
}
