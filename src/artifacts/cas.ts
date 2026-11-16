// Content-addressed, immutable artifact storage on local disk (FeltDB holds the metadata;
// FeltDB's 1 MiB request limit rules it out for artifact bytes — verified with HTTP 413).
// Layout: <root>/sha256/<ab>/<full-hex>. Objects are written to a temp file, hashed, fsynced,
// and renamed into place. An existing object is never overwritten.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, statfsSync, renameSync, rmSync, openSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";

export class DigestMismatch extends Error {}
export class StorageExhausted extends Error {}
export class TooLarge extends Error {}

export interface CasOptions { root: string; maxObjectBytes?: number; minFreeBytes?: number }

export class ContentStore {
  readonly root: string;
  readonly maxObjectBytes: number;
  readonly minFreeBytes: number;

  constructor(o: CasOptions) {
    this.root = o.root;
    this.maxObjectBytes = o.maxObjectBytes ?? 2 * 1024 ** 3;
    this.minFreeBytes = o.minFreeBytes ?? 5 * 1024 ** 3;
    mkdirSync(join(this.root, "tmp"), { recursive: true });
    mkdirSync(join(this.root, "sha256"), { recursive: true });
  }

  pathOf(hex: string): string {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("invalid sha256");
    return join(this.root, "sha256", hex.slice(0, 2), hex);
  }

  has(hex: string): boolean { return existsSync(this.pathOf(hex)); }

  freeBytes(): number {
    const s = statfsSync(this.root);
    return Number(s.bavail) * Number(s.bsize);
  }

  /** Store a stream that must hash to `expectedHex`. Returns size. Idempotent for identical content. */
  async put(input: Readable, expectedHex: string, declaredSize?: number): Promise<{ size: number; created: boolean }> {
    const dest = this.pathOf(expectedHex);
    if (declaredSize !== undefined && declaredSize > this.maxObjectBytes) throw new TooLarge(`object exceeds ${this.maxObjectBytes} bytes`);
    if (this.freeBytes() - (declaredSize ?? 0) < this.minFreeBytes) throw new StorageExhausted("artifact store below free-space reserve");
    const tmp = join(this.root, "tmp", randomUUID());
    const hash = createHash("sha256");
    let size = 0;
    const max = this.maxObjectBytes;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new TooLarge(`object exceeds ${max} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, createWriteStream(tmp, { flags: "wx", mode: 0o444 }));
      const actual = hash.digest("hex");
      if (actual !== expectedHex) throw new DigestMismatch(`expected sha256:${expectedHex}, got sha256:${actual}`);
      const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd);
      if (existsSync(dest)) { rmSync(tmp, { force: true }); return { size: statSync(dest).size, created: false }; }
      mkdirSync(join(this.root, "sha256", expectedHex.slice(0, 2)), { recursive: true });
      renameSync(tmp, dest);
      const dfd = openSync(join(this.root, "sha256", expectedHex.slice(0, 2)), "r"); fsyncSync(dfd); closeSync(dfd);
      return { size, created: true };
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  open(hex: string): Readable { return createReadStream(this.pathOf(hex)); }

  /** Re-hash a stored object (used by verification and deploy gates). */
  async verify(hex: string): Promise<boolean> {
    if (!this.has(hex)) return false;
    const h = createHash("sha256");
    for await (const c of this.open(hex)) h.update(c as Buffer);
    return h.digest("hex") === hex;
  }

  /** Delete objects not in `keep` (garbage collection driven by FeltDB retention metadata). */
  sweep(keep: Set<string>): string[] {
    const removed: string[] = [];
    const base = join(this.root, "sha256");
    for (const pre of readdirSync(base)) {
      for (const hex of readdirSync(join(base, pre))) {
        if (!keep.has(hex)) { rmSync(join(base, pre, hex), { force: true }); removed.push(hex); }
      }
    }
    return removed;
  }
}
