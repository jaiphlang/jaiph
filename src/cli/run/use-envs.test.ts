// Pre-flight for `use` clauses: every `use` key in the import graph must be
// granted with `--env KEY[=VALUE]` before `jaiph run` / `serve` / `mcp`
// spawns anything. Extra --env keys nothing `use`s are allowed; a graph with
// no `use` requires no --env at all.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModuleGraph } from "../../transpiler";
import { planUseEnvs } from "./use-envs";

function writeFlow(root: string, name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("planUseEnvs: an ungranted use key is E_ENV_MISSING naming the script and the flag", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-"));
  try {
    const entry = writeFlow(root, "flow.jh", [
      "script gh use GITHUB_TOKEN = `gh pr list`",
      "export def main() {",
      "  run gh()",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set());
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /E_ENV_MISSING/);
    assert.match(plan.errors[0], /script gh .*uses GITHUB_TOKEN/);
    assert.match(plan.errors[0], /--env GITHUB_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planUseEnvs: a granted key passes; extra --env keys are allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-ok-"));
  try {
    const entry = writeFlow(root, "flow.jh", [
      "script gh use GITHUB_TOKEN = `gh pr list`",
      "export def main() {",
      "  run gh()",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set(["GITHUB_TOKEN", "UNUSED_EXTRA"]));
    assert.deepEqual(plan.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planUseEnvs: a graph with no use requires no --env", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-none-"));
  try {
    const entry = writeFlow(root, "flow.jh", [
      "script show = `echo x`",
      "export def main() {",
      "  run show()",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set());
    assert.deepEqual(plan.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planUseEnvs: use keys are collected across the whole import graph, incl. import script", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-graph-"));
  try {
    writeFileSync(join(root, "gh.sh"), "#!/usr/bin/env bash\necho x\n");
    writeFlow(root, "lib.jh", [
      "export script publish use NPM_TOKEN = `npm publish`",
      "export def pub() {",
      "  run publish()",
      "}",
    ]);
    const entry = writeFlow(root, "flow.jh", [
      'import "lib.jh" as lib',
      'import script "./gh.sh" as gh use GITHUB_TOKEN',
      "export def main() {",
      "  run gh()",
      "  run lib.pub()",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set(["GITHUB_TOKEN"]));
    assert.equal(plan.errors.length, 1, "the imported module's use key is still required");
    assert.match(plan.errors[0], /script publish .*uses NPM_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planUseEnvs: an ungranted use key on a named prompt is E_ENV_MISSING", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-prompt-"));
  try {
    const entry = writeFlow(root, "flow.jh", [
      'prompt analyze(log) use GITHUB_TOKEN = "Look at ${log}"',
      "export def main() {",
      '  const l = "x"',
      "  prompt analyze(l)",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set());
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /E_ENV_MISSING/);
    assert.match(plan.errors[0], /prompt analyze .*uses GITHUB_TOKEN/);
    assert.match(plan.errors[0], /--env GITHUB_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planUseEnvs: a granted named-prompt use key passes", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-envs-prompt-ok-"));
  try {
    const entry = writeFlow(root, "flow.jh", [
      'prompt analyze(log) use GITHUB_TOKEN = "Look at ${log}"',
      "export def main() {",
      '  const l = "x"',
      "  prompt analyze(l)",
      "}",
    ]);
    const plan = planUseEnvs(loadModuleGraph(entry, root), new Set(["GITHUB_TOKEN"]));
    assert.deepEqual(plan.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
