import test from "node:test";
import assert from "node:assert/strict";
import { parseConfigBlock } from "./metadata";
import { parsejaiph } from "../parser";
import { createTrivia } from "./trivia";

test("parseConfigBlock: parses minimal config with one key", () => {
  const lines = [
    "config {",
    '  agent.model = "gpt-4"',
    "}",
  ];
  const { metadata, nextIndex } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.model, "gpt-4");
  assert.equal(nextIndex, 3);
});

test("parseConfigBlock: parses boolean values", () => {
  const lines = [
    "config {",
    "  run.debug = true",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.run?.debug, true);
});

test("parseConfigBlock: parses integer values", () => {
  const lines = [
    "config {",
    "  runtime.docker_timeout_seconds = 300",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.runtime?.dockerTimeoutSeconds, 300);
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

test("parseConfigBlock: fails on removed run.inbox_parallel key", () => {
  const lines = [
    "config {",
    "  run.inbox_parallel = true",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /unknown config key: run\.inbox_parallel/,
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
    /agent\.backend must be "cursor", "claude", or "codex"/,
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

test("parseConfigBlock: accepts codex as backend", () => {
  const lines = [
    "config {",
    '  agent.backend = "codex"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.backend, "codex");
});

test("parseConfigBlock: fails on unclosed config block", () => {
  const lines = [
    "config {",
    '  agent.model = "gpt-4"',
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
  const trivia = createTrivia();
  const { metadata } = parseConfigBlock("test.jh", lines, 0, trivia);
  assert.equal(metadata.agent?.command, "claude");
  assert.deepEqual(trivia.getNode(metadata)?.configBodySequence, [
    { kind: "comment", text: "# this is a comment" },
    { kind: "assign", key: "agent.command" },
  ]);
});

test("parseConfigBlock: fails on line without = separator", () => {
  const lines = [
    "config {",
    "  agent.model",
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
    "  agent.model = gpt-4",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config value must be a quoted string, bare identifier, or true\/false/,
  );
});

test("parseConfigBlock: bare identifier is sugar for interpolated string", () => {
  const lines = [
    "config {",
    "  agent.model = model",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.model, "${model}");
});

test("parseConfigBlock: quoted string with interpolation is stored literally", () => {
  const lines = [
    "config {",
    '  agent.model = "prefix-${model}-suffix"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.model, "prefix-${model}-suffix");
});

test("parseConfigBlock: interpolated agent.backend is accepted at parse time", () => {
  const lines = [
    "config {",
    "  agent.backend = backend",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.backend, "${backend}");
});

test("parseConfigBlock: unquoted ${name} is sugar for interpolated string", () => {
  const lines = [
    "config {",
    "  agent.model = ${model}",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.model, "${model}");
});

test("parseConfigBlock: unquoted ${name.field} is sugar for interpolated string", () => {
  const lines = [
    "config {",
    "  agent.model = ${config.model}",
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.agent?.model, "${config.model}");
});

test("parseConfigBlock: rejects unclosed ${name interpolation ref", () => {
  const lines = [
    "config {",
    "  agent.model = ${model",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config value must be a quoted string, bare identifier, or true\/false/,
  );
});

test("parseConfigBlock: rejects shell fallback ${model:-x} in bare ref", () => {
  const lines = [
    "config {",
    "  agent.model = ${model:-x}",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /config value must be a quoted string, bare identifier, or true\/false/,
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
// Module manifest keys (module.name, module.version, module.description)
// ---------------------------------------------------------------------------

test("parseConfigBlock: parses module.name, module.version, module.description", () => {
  const lines = [
    "config {",
    '  module.name = "my-workflow"',
    '  module.version = "1.2.3"',
    '  module.description = "A helpful workflow"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.module?.name, "my-workflow");
  assert.equal(metadata.module?.version, "1.2.3");
  assert.equal(metadata.module?.description, "A helpful workflow");
});

test("parseConfigBlock: module keys are optional (partial set)", () => {
  const lines = [
    "config {",
    '  module.name = "only-name"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.module?.name, "only-name");
  assert.equal(metadata.module?.version, undefined);
  assert.equal(metadata.module?.description, undefined);
});

test("parseConfigBlock: module keys coexist with other config keys", () => {
  const lines = [
    "config {",
    '  module.name = "proj"',
    '  agent.backend = "claude"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.equal(metadata.module?.name, "proj");
  assert.equal(metadata.agent?.backend, "claude");
});

test("module keys round-trip through formatter", () => {
  const src = [
    'config {',
    '  module.name = "my-tool"',
    '  module.version = "0.1.0"',
    '  module.description = "Does things"',
    '}',
    '',
    'workflow default() {',
    '  log "ok"',
    '}',
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.metadata?.module?.name, "my-tool");
  assert.equal(mod.metadata?.module?.version, "0.1.0");
  assert.equal(mod.metadata?.module?.description, "Does things");

  // Verify formatter round-trip produces valid source that re-parses identically
  const { emitModule } = require("../format/emit");
  const emitted = emitModule(mod);
  const reparsed = parsejaiph(emitted, "test.jh");
  assert.equal(reparsed.metadata?.module?.name, "my-tool");
  assert.equal(reparsed.metadata?.module?.version, "0.1.0");
  assert.equal(reparsed.metadata?.module?.description, "Does things");
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
  assert.equal(mod.workflows[0].steps[0].type, "say");
});

test("workflow config: allows comments before config", () => {
  const src = [
    "workflow default() {",
    "  # a comment",
    "  config {",
    '    agent.model = "gpt-4"',
    "  }",
    '  log "done"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.equal(mod.workflows[0].metadata?.agent?.model, "gpt-4");
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

test("workflow config: rejects module.* keys", () => {
  const src = [
    "workflow default() {",
    "  config {",
    '    module.name = "nope"',
    "  }",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /module\.\* keys are not allowed in workflow-level config/,
  );
});

test("workflow config: rejects runtime.* keys", () => {
  const src = [
    "workflow default() {",
    "  config {",
    "    runtime.docker_timeout_seconds = 300",
    "  }",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    /runtime\.\* keys are not allowed in workflow-level config/,
  );
});

// ---------------------------------------------------------------------------
// trusted_envs (declarative host-secret forwarding for trusted run steps)
// ---------------------------------------------------------------------------

test("parseConfigBlock: parses trusted_envs into a key list", () => {
  const lines = [
    "config {",
    '  trusted_envs = "GITHUB_TOKEN NPM_TOKEN"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.deepEqual(metadata.trustedEnvs, ["GITHUB_TOKEN", "NPM_TOKEN"]);
});

test("parseConfigBlock: trusted_envs with a single key", () => {
  const lines = [
    "config {",
    '  trusted_envs = "GITHUB_TOKEN"',
    "}",
  ];
  const { metadata } = parseConfigBlock("test.jh", lines, 0);
  assert.deepEqual(metadata.trustedEnvs, ["GITHUB_TOKEN"]);
});

test("parseConfigBlock: trusted_envs rejects an invalid env var name", () => {
  const lines = [
    "config {",
    '  trusted_envs = "GITHUB_TOKEN 1BAD"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /trusted_envs key "1BAD" is not a valid environment variable name/,
  );
});

test("parseConfigBlock: trusted_envs rejects reserved keys (same rule as --env)", () => {
  const lines = [
    "config {",
    '  trusted_envs = "JAIPH_WORKSPACE"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /trusted_envs cannot declare reserved key "JAIPH_WORKSPACE".*E_ENV_RESERVED/,
  );
});

test("parseConfigBlock: trusted_envs rejects JAIPH_DOCKER_* keys", () => {
  const lines = [
    "config {",
    '  trusted_envs = "JAIPH_DOCKER_ENABLED"',
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /trusted_envs cannot declare reserved key "JAIPH_DOCKER_ENABLED"/,
  );
});

test("parseConfigBlock: trusted_envs must be a string", () => {
  const lines = [
    "config {",
    "  trusted_envs = true",
    "}",
  ];
  assert.throws(
    () => parseConfigBlock("test.jh", lines, 0),
    /trusted_envs must be a string/,
  );
});

test("workflow config: trusted_envs is accepted at workflow level", () => {
  const src = [
    "workflow default() {",
    "  config {",
    '    trusted_envs = "GITHUB_TOKEN"',
    "  }",
    '  log "hello"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  assert.deepEqual(mod.workflows[0].metadata?.trustedEnvs, ["GITHUB_TOKEN"]);
});

test("trusted_envs round-trips through formatter", () => {
  const src = [
    "config {",
    '  trusted_envs = "GITHUB_TOKEN NPM_TOKEN"',
    "}",
    "",
    "workflow default() {",
    "  config {",
    '    trusted_envs = "EXTRA_KEY"',
    "  }",
    '  log "ok"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const { emitModule } = require("../format/emit");
  const emitted = emitModule(mod);
  const reparsed = parsejaiph(emitted, "test.jh");
  assert.deepEqual(reparsed.metadata?.trustedEnvs, ["GITHUB_TOKEN", "NPM_TOKEN"]);
  assert.deepEqual(reparsed.workflows[0].metadata?.trustedEnvs, ["EXTRA_KEY"]);
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
