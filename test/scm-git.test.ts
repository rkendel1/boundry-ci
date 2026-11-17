import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitScmAdapter } from "../src/scm/git.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

test("plain git adapter reads files at exact commits from any git URL and never reports statuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "bci-git-"));
  const bare = join(root, "srv", "acme", "app.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  const work = join(root, "work");
  git(root, "clone", "-q", bare, work);
  git(work, "config", "user.email", "t@t"); git(work, "config", "user.name", "t");
  mkdirSync(join(work, ".boundry", "recipes"), { recursive: true });
  writeFileSync(join(work, ".boundry", "recipes", "ci.md"), "v1\n");
  git(work, "add", "-A"); git(work, "commit", "-qm", "one");
  const first = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, ".boundry", "recipes", "ci.md"), "v2\n");
  git(work, "commit", "-qam", "two");
  git(work, "push", "-q", "origin", "main");
  const second = git(work, "rev-parse", "HEAD");

  const scm = new GitScmAdapter(`file://${join(root, "srv")}/{repo}.git`, join(root, "cache"));
  assert.equal(await scm.resolveBranch("acme/app", "main"), second);
  assert.equal(await scm.resolveBranch("acme/app", "nope"), null);
  assert.equal(await scm.readFile("acme/app", second, ".boundry/recipes/ci.md"), "v2\n");
  assert.equal(await scm.readFile("acme/app", first, ".boundry/recipes/ci.md"), "v1\n", "an older commit is read as it was");
  assert.equal(await scm.readFile("acme/app", second, "missing.txt"), null);
  assert.deepEqual(await scm.listFiles("acme/app", second, ".boundry/recipes"), ["ci.md"]);
  await assert.rejects(() => scm.reportStatus(), /no commit statuses/);
});
