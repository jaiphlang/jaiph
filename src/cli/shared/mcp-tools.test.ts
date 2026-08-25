import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../../parser";
import { deriveTools, toolNameFromFile } from "./mcp-tools";

const FILE = "/ws/deploy-tools.jh";

function mod(source: string) {
  return parsejaiph(source, FILE);
}

// === toolNameFromFile ===

test("toolNameFromFile: strips .jh and sanitizes to [A-Za-z0-9_-]", () => {
  assert.equal(toolNameFromFile("/ws/deploy-tools.jh"), "deploy-tools");
  assert.equal(toolNameFromFile("/ws/my flow!.jh"), "my_flow_");
});

test("toolNameFromFile: truncates the slug to 128 characters", () => {
  const long = `/ws/${"a".repeat(200)}.jh`;
  assert.equal(toolNameFromFile(long).length, 128);
});

// === deriveTools: exposure rules ===

test("deriveTools: zero exports exposes no tools and warns", () => {
  const m = mod(
    [
      "def build(target) {",
      "  log target",
      "}",
      "def lint() {",
      '  log "lint"',
      "}",
    ].join("\n"),
  );
  const { tools, warnings } = deriveTools(m, FILE);
  assert.deepEqual(tools, []);
  assert.ok(warnings.some((w) => w.includes("no exported defs")));
});

test("deriveTools: export def narrows exposure to exported ones", () => {
  const m = mod(
    [
      "export def build(target) {",
      "  log target",
      "}",
      "def helper() {",
      '  log "internal"',
      "}",
    ].join("\n"),
  );
  const { tools } = deriveTools(m, FILE);
  assert.deepEqual(tools.map((t) => t.name), ["build"]);
});

test("deriveTools: an exported route handler is a tool; unexported helpers are not", () => {
  const m = mod(
    [
      "channel alerts -> on_alert",
      "export def on_alert(message, chan, sender) {",
      "  log message",
      "}",
      "def helper() {",
      '  log "internal"',
      "}",
    ].join("\n"),
  );
  const { tools } = deriveTools(m, FILE);
  assert.deepEqual(tools.map((t) => t.name), ["on_alert"]);
});

test("deriveTools: lone export def main is exposed under the file basename", () => {
  const m = mod(["export def main(task) {", "  log task", "}"].join("\n"));
  const { tools } = deriveTools(m, FILE);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "deploy-tools");
  assert.equal(tools[0].def, "main");
});

test("deriveTools: main is skipped (with warning) when other exports exist", () => {
  const m = mod(
    [
      "export def main() {",
      '  log "entry"',
      "}",
      "export def build() {",
      '  log "build"',
      "}",
    ].join("\n"),
  );
  const { tools, warnings } = deriveTools(m, FILE);
  assert.deepEqual(tools.map((t) => t.name), ["build"]);
  assert.ok(warnings.some((w) => w.includes('"main"')));
});

// === deriveTools: descriptions and schema ===

test("deriveTools: description comes from leading # comments, shebang dropped", () => {
  const m = mod(
    [
      "#!/usr/bin/env jaiph",
      "# Builds the target and runs the smoke suite.",
      "# Retries flaky steps once.",
      "export def build(target) {",
      "  log target",
      "}",
    ].join("\n"),
  );
  const { tools } = deriveTools(m, FILE);
  assert.equal(tools[0].description, "Builds the target and runs the smoke suite.\nRetries flaky steps once.");
});

test("deriveTools: fallback description names the workflow and file", () => {
  const m = mod(["export def build() {", '  log "x"', "}"].join("\n"));
  const { tools } = deriveTools(m, FILE);
  assert.match(tools[0].description, /"build"/);
  assert.match(tools[0].description, /deploy-tools\.jh/);
});

test("deriveTools: params map to required string properties", () => {
  const m = mod(["export def build(target, mode) {", "  log target", "}"].join("\n"));
  const { tools } = deriveTools(m, FILE);
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: { target: { type: "string" }, mode: { type: "string" } },
    required: ["target", "mode"],
    additionalProperties: false,
  });
});

test("deriveTools: zero params produce an object schema without required", () => {
  const m = mod(["export def build() {", '  log "x"', "}"].join("\n"));
  const { tools } = deriveTools(m, FILE);
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});
