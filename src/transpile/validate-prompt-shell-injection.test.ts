/**
 * Acceptance tests for W_PROMPT_IN_SHELL: the validator must emit a diagnostic
 * when a prompt capture is interpolated directly into a workflow shell step,
 * and must NOT emit that diagnostic when the prompt value is passed as a
 * named script argument (the safe argv path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModuleGraph } from "./module-graph";
import { collectDiagnostics } from "./validate";

test("W_PROMPT_IN_SHELL: prompt capture interpolated in shell step produces diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-shell-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const x = prompt "What is your name?"',
        '  echo "${x}"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "m.jh"));
    const diag = collectDiagnostics(graph);
    const errs = diag.sorted().filter((d) => d.file.endsWith("m.jh"));
    assert.equal(errs.length, 1, `expected 1 diagnostic, got: ${JSON.stringify(errs)}`);
    assert.equal(errs[0].code, "W_PROMPT_IN_SHELL");
    assert.match(errs[0].message, /"x"/);
    assert.equal(errs[0].line, 3, "diagnostic should point at the shell line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W_PROMPT_IN_SHELL: typed prompt capture (with returns schema) interpolated in shell step produces diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-shell-typed-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow default() {",
        '  const r = prompt "Pick a name:" returns "{ name: string }"',
        '  echo "${r}"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "m.jh"));
    const diag = collectDiagnostics(graph);
    const errs = diag.sorted().filter((d) => d.code === "W_PROMPT_IN_SHELL");
    assert.ok(errs.length >= 1, `expected at least 1 W_PROMPT_IN_SHELL diagnostic, got: ${JSON.stringify(diag.sorted())}`);
    assert.match(errs[0].message, /"r"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W_PROMPT_IN_SHELL: passing prompt capture as script arg does not produce diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-shell-safe-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script greet = ```",
        "echo $1",
        "```",
        "",
        "workflow default() {",
        '  const x = prompt "What is your name?"',
        "  run greet(x)",
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "m.jh"));
    const diag = collectDiagnostics(graph);
    const promptShellErrs = diag.sorted().filter((d) => d.code === "W_PROMPT_IN_SHELL");
    assert.equal(
      promptShellErrs.length,
      0,
      `expected no W_PROMPT_IN_SHELL diagnostics, got: ${JSON.stringify(promptShellErrs)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W_PROMPT_IN_SHELL: non-prompt variable interpolated in shell step is not flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-prompt-shell-nonprompt-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script compute = ```",
        "echo hello",
        "```",
        "",
        "workflow default() {",
        "  const output = run compute()",
        '  echo "${output}"',
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "m.jh"));
    const diag = collectDiagnostics(graph);
    const promptShellErrs = diag.sorted().filter((d) => d.code === "W_PROMPT_IN_SHELL");
    assert.equal(
      promptShellErrs.length,
      0,
      `expected no W_PROMPT_IN_SHELL diagnostics for non-prompt capture, got: ${JSON.stringify(promptShellErrs)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
