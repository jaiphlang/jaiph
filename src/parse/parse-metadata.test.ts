import test from "node:test";
import assert from "node:assert/strict";
import { parseConfigBlock } from "./metadata";
import { parsejaiph } from "../parser";

test("parseConfigBlock: parses minimal config with one key", () => {
  const lines = [
    "config {",
    '  agent.default_model = "gpt-4"',
    "}",
  ];
  const { metadata, nextIndex } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.defaultModel, "gpt-4");
  assert.equal(nextIndex, 3);
});

test("parseConfigBlock: parses boolean values", () => {
  const lines = [
    "config {",
    "  run.debug = true",
    "  runtime.docker_enabled = false",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.run?.debug, true);
  assert.equal(metadata.runtime?.dockerEnabled, false);
});

test("parseConfigBlock: parses integer values", () => {
  const lines = [
    "config {",
    "  runtime.docker_timeout = 300",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.runtime?.dockerTimeout, 300);
});

test("parseConfigBlock: parses multiline array", () => {
  const lines = [
    "config {",
    "  runtime.workspace = [",
    '    "src/"',
    '    "lib/"',
    "  ]",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.deepEqual(metadata.runtime?.workspace, ["src/", "lib/"]);
});

test("parseConfigBlock: fails on unknown config key", () => {
  const lines = [
    "config {",
    '  agent.unknown_key = "value"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /unknown config key/,
  );
});

test("parseConfigBlock: fails on type mismatch (string where boolean expected)", () => {
  const lines = [
    "config {",
    '  run.debug = "yes"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /run\.debug must be true or false/,
  );
});

test("parseConfigBlock: fails on invalid backend value", () => {
  const lines = [
    "config {",
    '  agent.backend = "openai"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /agent\.backend must be "cursor" or "claude"/,
  );
});

test("parseConfigBlock: accepts cursor as backend", () => {
  const lines = [
    "config {",
    '  agent.backend = "cursor"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.backend, "cursor");
});

test("parseConfigBlock: accepts claude as backend", () => {
  const lines = [
    "config {",
    '  agent.backend = "claude"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.backend, "claude");
});

test("parseConfigBlock: fails on unclosed config block", () => {
  const lines = [
    "config {",
    '  agent.default_model = "gpt-4"',
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config block not closed/,
  );
});

test("parseConfigBlock: skips empty lines and comments", () => {
  const lines = [
    "config {",
    "",
    "  # this is a comment",
    '  agent.command = "claude"',
    "",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.command, "claude");
});

test("parseConfigBlock: fails on line without = separator", () => {
  const lines = [
    "config {",
    "  agent.default_model",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config line must be key = value/,
  );
});

test("parseConfigBlock: fails on bare unquoted string value", () => {
  const lines = [
    "config {",
    "  agent.default_model = gpt4",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config value must be a quoted string or true\/false/,
  );
});

test("parseConfigBlock: handles escape sequences in string values", () => {
  const lines = [
    "config {",
    '  agent.cursor_flags = "flag\\nvalue"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.cursorFlags, "flag\nvalue");
});

test("parseConfigBlock: parses empty array", () => {
  const lines = [
    "config {",
    "  runtime.workspace = []",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.deepEqual(metadata.runtime?.workspace, []);
});

test("parseConfigBlock: fails on type mismatch (number where string expected)", () => {
  const lines = [
    "config {",
    "  runtime.docker_image = 123",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /runtime\.docker_image must be a string/,
  );
});

// ---------------------------------------------------------------------------
// Workflow-level config
// ---------------------------------------------------------------------------

test("workflow config: parses config inside workflow", () => {
  const src = [
    "workflow default() {",
    "  config {",
    '    agent.backend = "claude"',
    "  }",
    '  log "hello"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.workflows[0].metadata?.agent?.backend, "claude");
  assert.equal(mod.workflows[0].steps.length, 1);
  assert.equal(mod.workflows[0].steps[0].type, "log");
});

test("workflow config: allows comments before config", () => {
  const src = [
    "workflow default() {",
    "  # a comment",
    "  config {",
    '    agent.default_model = "gpt-4"',
    "  }",
    '  log "done"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.workflows[0].metadata?.agent?.defaultModel, "gpt-4");
});

test("workflow config: rejects duplicate config in same workflow", () => {
  const src = [
    "workflow default() {",
    "  config {",
    '    agent.backend = "claude"',
    "  }",
    "  config {",
    '    agent.backend = "cursor"',
    "  }",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /duplicate config block inside workflow/,
  );
});

test("workflow config: rejects config after steps", () => {
  const src = [
    "workflow default() {",
    '  echo "step"',
    "  config {",
    '    agent.backend = "claude"',
    "  }",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /config block inside workflow must appear before any steps/,
  );
});

test("workflow config: rejects runtime.* keys", () => {
  const src = [
    "workflow default() {",
    "  config {",
    "    runtime.docker_enabled = true",
    "  }",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /runtime\.\* keys are not allowed in workflow-level config/,
  );
});

test("workflow config: coexists with module-level config", () => {
  const src = [
    "config {",
    '  agent.backend = "cursor"',
    "}",
    "workflow a() {",
    "  config {",
    '    agent.backend = "claude"',
    "  }",
    '  echo "a"',
    "}",
    "workflow b() {",
    '  echo "b"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.metadata?.agent?.backend, "cursor");
  assert.equal(mod.workflows[0].metadata?.agent?.backend, "claude");
  assert.equal(mod.workflows[1].metadata, undefined);
});
