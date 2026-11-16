// GitHub source adapter: webhook verification + normalization, and narrowly scoped API calls
// (contents:read, statuses:write, metadata:read) via a GitHub App installation token.
// GitHub credentials stay in the control plane; jobs never receive them.
import { createHmac, timingSafeEqual, createSign } from "node:crypto";
import type { ScmAdapter, SourceEvent, CommitState } from "./types.ts";

export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Narrowest permissions the control plane needs.
const CONTROL_PERMISSIONS = { contents: "read", statuses: "write", metadata: "read" };

const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Normalize a verified GitHub delivery into a SourceEvent, or null if it does not start CI. */
export function normalizeGithubEvent(eventName: string, deliveryId: string, p: any): SourceEvent | null {
  const repository = p?.repository?.full_name;
  if (!repository || !deliveryId) return null;
  const base = { provider: "github", deliveryId, repository, actor: p.sender?.login };
  switch (eventName) {
    case "push": {
      if (p.deleted || p.after === ZERO_SHA) return null;
      if (typeof p.ref !== "string") return null;
      if (p.ref.startsWith("refs/tags/")) return { ...base, kind: "tag", ref: p.ref, sha: p.after, trusted: true };
      if (p.ref.startsWith("refs/heads/")) return { ...base, kind: "push", ref: p.ref, sha: p.after, trusted: true };
      return null;
    }
    case "pull_request": {
      if (!["opened", "synchronize", "reopened"].includes(p.action)) return null;
      const pr = p.pull_request;
      // Only PRs whose head lives in the same repository are trusted; forks never are.
      const sameRepo = pr?.head?.repo?.full_name === repository;
      return { ...base, kind: "pull_request", ref: `refs/pull/${pr.number}/head`, sha: pr.head.sha, baseBranch: pr.base.ref, trusted: sameRepo, prNumber: pr.number };
    }
    case "release": {
      if (p.action !== "published") return null;
      return { ...base, kind: "release", ref: `refs/tags/${p.release.tag_name}`, sha: p.release.target_commitish_sha ?? p.release.target_commitish, trusted: true };
    }
    default:
      return null;
  }
}

export interface GithubAppConfig {
  apiUrl?: string; // default https://api.github.com
  appId?: string;
  privateKeyPem?: string;
  /** owner -> installation id */
  installations?: Record<string, string>;
  /** Static token alternative (e.g. a proxy that injects credentials). Never logged. */
  staticToken?: string;
}

export class GithubAdapter implements ScmAdapter {
  readonly provider = "github";
  readonly #cfg: GithubAppConfig;
  readonly #api: string;
  #tokens = new Map<string, { token: string; exp: number }>();

  constructor(cfg: GithubAppConfig) {
    this.#cfg = cfg;
    this.#api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  #appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: this.#cfg.appId })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.#cfg.privateKeyPem!).toString("base64url");
    return `${unsigned}.${sig}`;
  }

  async #token(owner: string, permissions: Record<string, string> = CONTROL_PERMISSIONS): Promise<string> {
    if (this.#cfg.staticToken) return this.#cfg.staticToken;
    const inst = this.#cfg.installations?.[owner];
    if (!inst || !this.#cfg.appId || !this.#cfg.privateKeyPem) throw new Error(`no GitHub App installation configured for ${owner}`);
    const cacheKey = `${inst}:${JSON.stringify(permissions)}`;
    const cached = this.#tokens.get(cacheKey);
    if (cached && cached.exp - Date.now() > 120_000) return cached.token;
    const res = await fetch(`${this.#api}/app/installations/${inst}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#appJwt()}`, accept: "application/vnd.github+json" },
      // Narrowest permissions the control plane needs.
      body: JSON.stringify({ permissions }),
    });
    if (!res.ok) throw new Error(`installation token: HTTP ${res.status}`);
    const j: any = await res.json();
    this.#tokens.set(cacheKey, { token: j.token, exp: Date.parse(j.expires_at) });
    return j.token;
  }

  async #gh(repository: string, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.#token(repository.split("/")[0]);
    return fetch(`${this.#api}/repos/${repository}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
  }

  async readFile(repository: string, sha: string, path: string): Promise<string | null> {
    const res = await this.#gh(repository, `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`, { headers: { accept: "application/vnd.github.raw+json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub readFile ${repository}@${sha}:${path}: HTTP ${res.status}`);
    return res.text();
  }

  async resolveBranch(repository: string, branch: string): Promise<string | null> {
    const res = await this.#gh(repository, `/commits/${encodeURIComponent(branch)}`, { headers: { accept: "application/vnd.github.sha" } });
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new Error(`GitHub resolveBranch: HTTP ${res.status}`);
    return (await res.text()).trim();
  }

  async reportStatus(repository: string, sha: string, s: { context: string; state: CommitState; description: string; targetUrl?: string }): Promise<void> {
    const res = await this.#gh(repository, `/statuses/${sha}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: s.state, context: s.context, description: s.description.slice(0, 140), ...(s.targetUrl ? { target_url: s.targetUrl } : {}) }),
    });
    if (!res.ok) throw new Error(`GitHub status ${repository}@${sha}: HTTP ${res.status}`);
  }

  async checkoutAuth(repository: string): Promise<{ url: string; header?: string }> {
    const url = `https://github.com/${repository}.git`;
    if (this.#cfg.staticToken === undefined && !this.#cfg.installations?.[repository.split("/")[0]]) return { url };
    // Checkout tokens are read-only and short-lived (1h); used by the worker outside the job sandbox.
    const token = await this.#token(repository.split("/")[0], { contents: "read", metadata: "read" });
    return { url, header: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
  }
}
