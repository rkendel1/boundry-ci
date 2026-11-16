import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, SpecError, globMatch, type CompileContext } from "../src/spec/compile.ts";

const ctx = (over: Partial<CompileContext> = {}): CompileContext => ({
  repository: "rkendel1/resolver", kind: "push", ref: "refs/heads/main", sha: "a".repeat(40), trusted: true, ...over,
});

const SPEC = `
version: 1
name: resolver
on:
  push: { branches: [main, "release/*"] }
  pull_request: { branches: [main] }
  tag: { patterns: ["v*"] }
  schedule: [{ cron: "17 6 * * *", branch: main }]
concurrency: { group: "\${repository}/\${ref}", cancel_in_progress: true }
defaults:
  image: mirror.gcr.io/library/node:22-bookworm-slim
  timeout_minutes: 15
templates:
  node:
    network: egress
    env: { CI: "true" }
jobs:
  test:
    extends: node
    matrix: { node: [20, 22] }
    image: "mirror.gcr.io/library/node:\${{ matrix.node }}-bookworm-slim"
    steps: [{ name: "test on \${{ matrix.node }}", run: "npm ci && npm test" }]
  build:
    extends: node
    needs: [test]
    artifacts: [{ name: dist, path: dist/out.tgz }]
    steps: [{ run: npm run build }]
  publish:
    needs: [build]
    when: { events: [tag] }
    requires: [release]
    permissions: { release: true }
    image: "mirror.gcr.io/library/node@sha256:${"b".repeat(64)}"
    secrets: [NPM_TOKEN]
    steps: [{ run: npm publish }]
`;

test("compilation is deterministic and records source + plan digests", () => {
  const a = compile(SPEC, ctx());
  const b = compile(SPEC, ctx());
  assert.equal(a.planDigest, b.planDigest);
  assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan));
  assert.match(a.plan.sourceDigest, /^[0-9a-f]{64}$/);
  // Any source change changes both digests.
  const c = compile(SPEC + "\n# comment\n", ctx());
  assert.notEqual(c.plan.sourceDigest, a.plan.sourceDigest);
  assert.notEqual(c.planDigest, a.planDigest);
});

test("matrix expansion, needs fan-in, templates and env merge", () => {
  const { plan } = compile(SPEC, ctx());
  assert.deepEqual(plan.jobs.map((j) => j.key), ["build", "test[node=20]", "test[node=22]"]);
  const build = plan.jobs.find((j) => j.key === "build")!;
  assert.deepEqual(build.needs, ["test[node=20]", "test[node=22]"]);
  assert.equal(build.network, "egress");
  assert.equal(build.env.CI, "true");
  const t20 = plan.jobs.find((j) => j.key === "test[node=20]")!;
  assert.equal(t20.image, "mirror.gcr.io/library/node:20-bookworm-slim");
  assert.equal(t20.env.MATRIX_NODE, "20");
  assert.equal(t20.steps[0].name, "test on 20");
  assert.equal(t20.timeoutMinutes, 15);
  assert.deepEqual(plan.concurrency, { group: "rkendel1/resolver/refs/heads/main", cancelInProgress: true });
});

test("event selection: tag adds release job; unsubscribed events produce empty plans", () => {
  const tag = compile(SPEC, ctx({ kind: "tag", ref: "refs/tags/v1.2.0" }));
  assert.ok(tag.plan.jobs.some((j) => j.key === "publish"));
  assert.equal(compile(SPEC, ctx({ ref: "refs/heads/feature" })).plan.jobs.length, 0);
  assert.equal(compile(SPEC, ctx({ kind: "manual" })).plan.jobs.length, 0);
  const sched = compile(SPEC, ctx({ kind: "schedule", cron: "17 6 * * *" }));
  assert.equal(sched.plan.jobs.length, 3);
  assert.equal(compile(SPEC, ctx({ kind: "schedule", cron: "0 0 * * *" })).plan.jobs.length, 0);
  const pr = compile(SPEC, ctx({ kind: "pull_request", ref: "refs/pull/7/head", baseBranch: "main", trusted: false }));
  assert.equal(pr.plan.jobs.length, 3);
});

test("schema rejects unknown fields and bad types", () => {
  assert.throws(() => compile("version: 1\njobs: { a: { image: x, steps: [{run: x}], runs-on: ubuntu } }", ctx()), SpecError);
  assert.throws(() => compile("version: 2\njobs: { a: { image: x, steps: [{run: x}] } }", ctx()), SpecError);
  assert.throws(() => compile("version: 1\njobs: { a: { image: x, steps: [{run: x}], requires: [windows] } }", ctx()), SpecError);
});

test("graph and authority rules", () => {
  const cyc = `version: 1\non: {push: {}}\ndefaults: {image: x}\njobs:\n  a: {needs: [b], steps: [{run: x}]}\n  b: {needs: [a], steps: [{run: x}]}\n`;
  assert.throws(() => compile(cyc, ctx()), /dependency cycle/);
  const unknown = `version: 1\njobs:\n  a: {image: x, needs: [zz], steps: [{run: x}]}\n`;
  assert.throws(() => compile(unknown, ctx()), /unknown job 'zz'/);
  const unpinned = `version: 1\njobs:\n  rel: {image: "node:22", requires: [release], permissions: {release: true}, steps: [{run: x}]}\n`;
  assert.throws(() => compile(unpinned, ctx()), /pin image by @sha256/);
  const capNoPerm = `version: 1\njobs:\n  rel: {image: x, requires: [deploy], steps: [{run: x}]}\n`;
  assert.throws(() => compile(capNoPerm, ctx()), /requires the matching explicit permission/);
});

test("YAML 1.2: 'on' key is a string, duplicate keys rejected", () => {
  assert.throws(() => compile("version: 1\nversion: 1\njobs: {a: {image: x, steps: [{run: x}]}}", ctx()), SpecError);
  const ok = compile("version: 1\non: {push: {}}\njobs: {a: {image: x, steps: [{run: x}]}}", ctx());
  assert.equal(ok.plan.jobs.length, 1);
});

test("glob matching", () => {
  assert.ok(globMatch("release/*", "release/1.0"));
  assert.ok(!globMatch("release/*", "release/1.0/x"));
  assert.ok(globMatch("release/**", "release/1.0/x"));
  assert.ok(globMatch("v*", "v1.2.3"));
  assert.ok(!globMatch("main", "main2"));
});
