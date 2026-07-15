import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsejaiph } from "../parser";
import { loadModuleGraph } from "./module-graph";
import { collectDiagnostics } from "./validate";
import { buildConstVars, interpolateWorkflowMetadata } from "../config";

test("validateConfig: rejects unknown identifier in workflow config", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-config-"));
  try {
    writeFileSync(
      join(root, "test.jh"),
      [
        "workflow implement(model) {",
        "  config {",
        "    agent.model = model",
        "  }",
        "}",
        "",
        "workflow other() {",
        "  config {",
        "    agent.model = missing",
        "  }",
        "}",
        "",
        "workflow default() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "test.jh"));
    const diag = collectDiagnostics(graph);
    assert.equal(diag.errors.length, 1);
    assert.match(diag.errors[0]!.message, /unknown identifier "missing"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateConfig: accepts workflow parameter in workflow config", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-config-"));
  try {
    writeFileSync(
      join(root, "test.jh"),
      [
        "workflow implement(model) {",
        "  config {",
        "    agent.model = model",
        "  }",
        "}",
        "",
        "workflow default() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "test.jh"));
    const diag = collectDiagnostics(graph);
    assert.equal(diag.errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateConfig: accepts module const in module config", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-config-"));
  try {
    writeFileSync(
      join(root, "test.jh"),
      [
        'const DEFAULT_MODEL = "claude-sonnet-5"',
        "",
        "config {",
        "  agent.model = DEFAULT_MODEL",
        "}",
        "",
        "workflow default() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    const graph = loadModuleGraph(join(root, "test.jh"));
    const diag = collectDiagnostics(graph);
    assert.equal(diag.errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interpolateWorkflowMetadata: resolves workflow parameter", () => {
  const vars = new Map([["model", "claude-sonnet-5"]]);
  const resolved = interpolateWorkflowMetadata({ agent: { model: "${model}" } }, vars);
  assert.equal(resolved.agent?.model, "claude-sonnet-5");
});

test("buildConstVars: resolves module const chain for module config", () => {
  const ast = parsejaiph(
    ['const DEFAULT_MODEL = "claude-sonnet-5"', "", "config {", "  agent.model = DEFAULT_MODEL", "}"].join(
      "\n",
    ),
    "test.jh",
  );
  const vars = buildConstVars(ast.envDecls);
  const resolved = interpolateWorkflowMetadata(ast.metadata!, vars);
  assert.equal(resolved.agent?.model, "claude-sonnet-5");
});
