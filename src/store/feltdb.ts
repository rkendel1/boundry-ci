// Thin adapter over FeltDB's documented namespace HTTP routes
// (crates/feltdb-server, docs/reference/public-api.md):
//   POST /transactions   atomic, idempotent by transactionId, requireAbsent / expectedVersion guards
//   POST /query          bounded query (where/orderBy/limit/cursor)
//   GET  /collections/{c}/{id}
// No FeltDB semantics are reimplemented here; conflicts surface as PreconditionFailed.

export interface Rec { id: string; __version: number; [k: string]: unknown }

export interface TxOp {
  collection: string;
  id: string;
  value?: Record<string, unknown>; // absent = delete
  requireAbsent?: boolean;
  expectedVersion?: number;
}
export interface TxPrecondition { collection: string; id: string; requireAbsent?: boolean; expectedVersion?: number }

export interface Where { field: string; eq?: unknown; neq?: unknown; lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown; in?: unknown[] }

export class PreconditionFailed extends Error {
  readonly failure: unknown;
  constructor(failure: unknown) { super(`PRECONDITION_FAILED ${JSON.stringify(failure)}`); this.failure = failure; }
}
export class StoreUnavailable extends Error {}

export interface TxResult { transactionId: string; duplicate: boolean; commitRevision: number }

export class FeltStore {
  readonly url: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(opts: { url: string; token: string; timeoutMs?: number }) {
    this.url = opts.url.replace(/\/$/, "");
    this.#token = opts.token;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new StoreUnavailable(`FeltDB unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  async get<T extends Rec = Rec>(collection: string, id: string): Promise<T | null> {
    const { status, json } = await this.#req("GET", `/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) throw this.#error(status, json);
    return json.value as T;
  }

  /** Commit atomically. Reusing transactionId with the same payload is a verified no-op. */
  async transact(transactionId: string, operations: TxOp[], preconditions: TxPrecondition[] = []): Promise<TxResult> {
    const { status, json } = await this.#req("POST", "/transactions", { transactionId, operations, preconditions });
    if (status === 409 && json?.code === "PRECONDITION_FAILED") throw new PreconditionFailed(json.failure);
    if (status < 200 || status > 299) throw this.#error(status, json);
    return { transactionId: json.transactionId, duplicate: !!json.duplicate, commitRevision: json.commitRevision };
  }

  async query<T extends Rec = Rec>(collection: string, where: Where[] = [], opts: { limit?: number; orderBy?: { field: string; direction: "asc" | "desc" }[] } = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { status, json } = await this.#req("POST", "/query", {
        collection, where, limit: opts.limit ?? 500, ...(opts.orderBy ? { orderBy: opts.orderBy } : {}), ...(cursor ? { cursor } : {}),
      });
      if (status !== 200) throw this.#error(status, json);
      for (const r of json.records) { const { recordId: _r, ...rest } = r; out.push(rest as T); }
      if (json.exhausted || !json.nextCursor || (opts.limit && out.length >= opts.limit)) return out;
      cursor = json.nextCursor;
    }
  }

  async ready(): Promise<boolean> {
    try { return (await this.#req("GET", "/ready")).status === 200; } catch { return false; }
  }

  #error(status: number, json: any): Error {
    if (status >= 500 || status === 0) return new StoreUnavailable(`FeltDB ${status} ${json?.code ?? ""}`);
    return new Error(`FeltDB ${status} ${json?.code ?? ""} ${json?.message ?? ""}`.trim());
  }
}

/** Strip FeltDB bookkeeping before writing a record back. */
export function body(rec: Rec): Record<string, unknown> {
  const { __version: _v, ...rest } = rec;
  return rest;
}
