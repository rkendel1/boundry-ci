// Source-control adapter contract. The scheduler and executor depend only on this.
import type { EventKind } from "../spec/compile.ts";

export interface SourceEvent {
  provider: string; // "github"
  deliveryId: string; // provider-unique delivery identity, used for duplicate suppression
  kind: EventKind;
  repository: string; // owner/name
  ref: string;
  sha: string;
  trusted: boolean;
  baseBranch?: string;
  cron?: string;
  actor?: string;
  prNumber?: number;
}

export type CommitState = "pending" | "success" | "failure" | "error";

export interface ScmAdapter {
  readonly provider: string;
  /** Read a file at an exact commit; null if absent. */
  readFile(repository: string, sha: string, path: string): Promise<string | null>;
  /** Resolve a branch to its current head commit; null if absent. */
  resolveBranch(repository: string, branch: string): Promise<string | null>;
  /** Report a commit status. Must be idempotent for identical inputs. */
  reportStatus(repository: string, sha: string, s: { context: string; state: CommitState; description: string; targetUrl?: string }): Promise<void>;
  /** Clone URL and short-lived credentials for a worker-side checkout (never passed into jobs). */
  checkoutAuth(repository: string): Promise<{ url: string; header?: string }>;
}
