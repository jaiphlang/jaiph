import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModuleGraph } from "../../transpile/module-graph";
import { planTrustedEnvs, isTrustedEnvsOptIn } from "./trusted-envs";

function writeFlow(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "jaiph-trusted-plan-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("planTrustedEnvs: resolves module- and workflow-level keys from the host env, deduplicated", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "GH_TOKEN"',
      "}",
      "workflow default() {",
      "  config {",
      '    trusted_envs = "GH_TOKEN NPM_TOKEN"',
      "  }",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(loadModuleGraph(jh, root), {}, {
      GH_TOKEN: "gh-value",
      NPM_TOKEN: "npm-value",
      UNRELATED: "nope",
    });
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.resolved, { GH_TOKEN: "gh-value", NPM_TOKEN: "npm-value" });
  });
});

test("planTrustedEnvs: an explicit --env pair overrides the host value for the same key", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "GH_TOKEN"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(
      loadModuleGraph(jh, root),
      { GH_TOKEN: "cli-wins" },
      { GH_TOKEN: "host-value" },
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.resolved, { GH_TOKEN: "cli-wins" });
  });
});

test("planTrustedEnvs: a declared key missing from --env and the host env is an E_ENV_MISSING error", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "ABSENT_TOKEN"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(loadModuleGraph(jh, root), {}, {});
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0]!, /E_ENV_MISSING/);
    assert.match(plan.errors[0]!, /ABSENT_TOKEN/);
    assert.deepEqual(plan.resolved, {});
  });
});

test("planTrustedEnvs: --env satisfies a declared key that is unset on the host", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "GH_TOKEN"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(loadModuleGraph(jh, root), { GH_TOKEN: "from-flag" }, {});
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.resolved, { GH_TOKEN: "from-flag" });
  });
});

test("planTrustedEnvs: trusted_envs in an imported module is not resolved and produces a warning", () => {
  withTempDir((root) => {
    writeFlow(root, "lib.jh", [
      "config {",
      '  trusted_envs = "HOST_SECRET"',
      "}",
      "workflow grab() {",
      '  log "x"',
      "}",
    ]);
    const jh = writeFlow(root, "entry.jh", [
      'import "lib.jh" as lib',
      "workflow default() {",
      "  run lib.grab()",
      "}",
    ]);
    const plan = planTrustedEnvs(loadModuleGraph(jh, root), {}, { HOST_SECRET: "host-value" });
    assert.deepEqual(plan.errors, [], "imported declarations must not fail the pre-flight");
    assert.deepEqual(plan.resolved, {}, "imported declarations must not resolve host values");
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /trusted_envs declared in imported module/);
    assert.match(plan.warnings[0]!, /lib\.jh/);
  });
});

test("planTrustedEnvs: under Docker without the operator opt-in, the entry file's trusted_envs is ignored (not forwarded)", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "AWS_SECRET_ACCESS_KEY"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(
      loadModuleGraph(jh, root),
      {},
      { AWS_SECRET_ACCESS_KEY: "host-secret" },
      { dockerEnabled: true, optIn: false },
    );
    // The host secret must not cross the sandbox allowlist absent operator consent.
    assert.equal(plan.resolved.AWS_SECRET_ACCESS_KEY, undefined);
    assert.deepEqual(plan.resolved, {});
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /JAIPH_TRUSTED_ENVS/);
    assert.match(plan.warnings[0]!, /AWS_SECRET_ACCESS_KEY/);
  });
});

test("planTrustedEnvs: under Docker with the operator opt-in, an arbitrary non-JAIPH_ secret is forwarded", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "AWS_SECRET_ACCESS_KEY"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(
      loadModuleGraph(jh, root),
      {},
      { AWS_SECRET_ACCESS_KEY: "host-secret" },
      { dockerEnabled: true, optIn: true },
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.resolved, { AWS_SECRET_ACCESS_KEY: "host-secret" });
  });
});

test("planTrustedEnvs: under Docker without opt-in, a declared key unset on the host does not error (declaration is not honoured)", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "config {",
      '  trusted_envs = "GITHUB_TOKEN"',
      "}",
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(
      loadModuleGraph(jh, root),
      {},
      {},
      { dockerEnabled: true, optIn: false },
    );
    assert.deepEqual(plan.errors, [], "ignored declarations must not fail the pre-flight");
    assert.deepEqual(plan.resolved, {});
  });
});

test("isTrustedEnvsOptIn: honours 1/true and rejects everything else", () => {
  assert.equal(isTrustedEnvsOptIn({ JAIPH_TRUSTED_ENVS: "1" }), true);
  assert.equal(isTrustedEnvsOptIn({ JAIPH_TRUSTED_ENVS: "true" }), true);
  assert.equal(isTrustedEnvsOptIn({ JAIPH_TRUSTED_ENVS: "0" }), false);
  assert.equal(isTrustedEnvsOptIn({ JAIPH_TRUSTED_ENVS: "yes" }), false);
  assert.equal(isTrustedEnvsOptIn({}), false);
});

test("planTrustedEnvs: no declarations → empty plan", () => {
  withTempDir((root) => {
    const jh = writeFlow(root, "flow.jh", [
      "workflow default() {",
      '  log "x"',
      "}",
    ]);
    const plan = planTrustedEnvs(loadModuleGraph(jh, root), {}, { GH_TOKEN: "unused" });
    assert.deepEqual(plan, { errors: [], warnings: [], resolved: {} });
  });
});
