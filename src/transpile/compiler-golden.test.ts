import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScripts, emitScriptsForModule } from "../transpiler";
import { parsejaiph } from "../parser";

test("compiler: extracts script bodies for a simple module", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-scripts-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'script f_ok = `echo ok`',
        "",
        "rule ok() {",
        "  run f_ok()",
        "}",
        "",
        "workflow default() {",
        "  ensure ok()",
        "  log \"done\"",
        "}",
        "",
      ].join("\n"),
    );
    const scripts = emitScriptsForModule(input, root);
    const fOk = scripts.find((s) => s.name === "f_ok");
    assert.ok(fOk);
    assert.match(fOk.content, /set -euo pipefail/);
    assert.doesNotMatch(fOk.content, /set \+u/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("compiler golden: parser error message is deterministic", () => {
  assert.throws(
    () => parsejaiph('script 123bad = `echo x`\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE invalid script declaration/,
  );
});

test("compiler golden: prompt substitution guard reports E_PARSE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-parse-guard-"));
  try {
    const input = join(root, "bad_prompt.jh");
    writeFileSync(
      input,
      [
        "workflow default() {",
        '  prompt "Show host $(uname)"',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildScripts(input, join(root, "out")),
      new RegExp(`${input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:\\d+ E_PARSE prompt cannot contain command substitution`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler corpus: fixtures compile", () => {
  const outA = mkdtempSync(join(tmpdir(), "jaiph-corpus-a-"));
  try {
    buildScripts(join(process.cwd(), "test/fixtures"), outA);
  } finally {
    rmSync(outA, { recursive: true, force: true });
  }
});

test("compiler corpus: representative e2e workflows compile", () => {
  const outB = mkdtempSync(join(tmpdir(), "jaiph-corpus-b-"));
  try {
    const e2eFiles = [
      join(process.cwd(), "e2e/say_hello.jh"),
      join(process.cwd(), "e2e/assign_capture.jh"),
      join(process.cwd(), "e2e/prompt_returns_run_capture.jh"),
    ];
    for (const file of e2eFiles) {
      buildScripts(file, outB);
    }
  } finally {
    rmSync(outB, { recursive: true, force: true });
  }
});

test("parser: assignment capture parses for ensure, run, and const run capture", () => {
  const source = [
    'script say_hello = `echo hello`',
    "",
    "rule tests_pass() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  response = ensure tests_pass()",
    "  const out = run say_hello()",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows.length, 1);
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 2);
  assert.equal(steps[0].type, "ensure");
  assert.equal((steps[0] as { type: "ensure"; captureName?: string }).captureName, "response");
  assert.equal(steps[1].type, "const");
  const c1 = steps[1] as { type: "const"; name: string; value: { kind: string } };
  assert.equal(c1.name, "out");
  assert.equal(c1.value.kind, "run_capture");
});

test("parser: config block parses and populates mod.metadata", () => {
  const source = [
    "config {",
    '  agent.default_model = "gpt-4"',
    '  run.logs_dir = ".jaiph/runs"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.equal(mod.metadata!.agent?.defaultModel, "gpt-4");
  assert.equal(mod.metadata!.run?.logsDir, ".jaiph/runs");
});

test("parser: config agent.backend parses cursor and claude", () => {
  const sourceCursor = [
    "config {",
    '  agent.backend = "cursor"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const modCursor = parsejaiph(sourceCursor, "/fake/entry.jh");
  assert.equal(modCursor.metadata?.agent?.backend, "cursor");

  const sourceClaude = [
    "config {",
    '  agent.backend = "claude"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const modClaude = parsejaiph(sourceClaude, "/fake/entry.jh");
  assert.equal(modClaude.metadata?.agent?.backend, "claude");
});

test("parser: config agent.trusted_workspace parses string", () => {
  const source = [
    "config {",
    '  agent.trusted_workspace = ".jaiph/.."',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.metadata?.agent?.trustedWorkspace, ".jaiph/..");
});

test("parser: config backend flag strings parse", () => {
  const source = [
    "config {",
    '  agent.cursor_flags = "--force --sandbox enabled"',
    '  agent.claude_flags = "--model sonnet-4"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.metadata?.agent?.cursorFlags, "--force --sandbox enabled");
  assert.equal(mod.metadata?.agent?.claudeFlags, "--model sonnet-4");
});

test("parser: invalid agent.backend value throws E_PARSE", () => {
  const source = [
    "config {",
    '  agent.backend = "foo"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /agent\.backend must be "cursor", "claude", or "codex"/,
  );
});

test("parser: unknown config key throws E_PARSE with file location", () => {
  const source = [
    "config {",
    '  unknown.key = "x"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:2:.* E_PARSE unknown config key/,
  );
});

test("parser: invalid config value throws E_PARSE", () => {
  const source = [
    "config {",
    "  run.debug = yes",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:2:.* E_PARSE.*config value must be a quoted string or true\/false/,
  );
});

test("parser: duplicate config block throws E_PARSE", () => {
  const source = [
    "config {",
    '  run.logs_dir = "x"',
    "}",
    "config {",
    '  run.logs_dir = "y"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:4:1 E_PARSE duplicate config block/,
  );
});

test("parser: config integer value parses as number", () => {
  const source = [
    "config {",
    "  runtime.docker_timeout = 300",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.strictEqual(mod.metadata!.runtime?.dockerTimeout, 300);
  assert.strictEqual(typeof mod.metadata!.runtime?.dockerTimeout, "number");
});

test("parser: config integer key rejects string value with E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.docker_timeout = "fast"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /runtime\.docker_timeout must be an integer/,
  );
});

test("parser: config array value parses multi-line array", () => {
  const source = [
    "config {",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw",',
    '    "config:config:ro"',
    "  ]",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, [
    ".:/jaiph/workspace:rw",
    "config:config:ro",
  ]);
});

test("parser: config empty array parses as empty string[]", () => {
  const source = [
    "config {",
    "  runtime.workspace = []",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, []);
});

test("parser: config array with trailing commas and comments", () => {
  const source = [
    "config {",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw",  # main workspace',
    '    "config:config:ro",',
    "    # another comment",
    "  ]",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, [
    ".:/jaiph/workspace:rw",
    "config:config:ro",
  ]);
});

test("parser: config array key rejects non-array value with E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.workspace = "not-an-array"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /runtime\.workspace must be an array of strings/,
  );
});

test("parser: all runtime config keys are accepted", () => {
  const source = [
    "config {",
    "  runtime.docker_enabled = true",
    '  runtime.docker_image = "ubuntu:24.04"',
    '  runtime.docker_network = "host"',
    "  runtime.docker_timeout = 600",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw"',
    "  ]",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata?.runtime);
  assert.strictEqual(mod.metadata!.runtime!.dockerEnabled, true);
  assert.strictEqual(mod.metadata!.runtime!.dockerImage, "ubuntu:24.04");
  assert.strictEqual(mod.metadata!.runtime!.dockerNetwork, "host");
  assert.strictEqual(mod.metadata!.runtime!.dockerTimeout, 600);
  assert.deepStrictEqual(mod.metadata!.runtime!.workspace, [".:/jaiph/workspace:rw"]);
});

test("parser: unknown runtime key throws E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.unknown_key = "x"',
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /unknown config key: runtime\.unknown_key/,
  );
});

test("parser: positive if ensure parses into if step", () => {
  const source = [
    "rule ready() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  if ensure ready() {",
    "    log \"success\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "if");
  const step = steps[0] as { type: "if"; negated: boolean; condition: { kind: "ensure"; ref: { value: string } }; thenSteps: unknown[] };
  assert.equal(step.negated, false);
  assert.equal(step.condition.kind, "ensure");
  assert.equal(step.condition.ref.value, "ready");
  assert.equal(step.thenSteps.length, 1);
});

test("parser: positive if ensure with args parses correctly", () => {
  const source = [
    "rule check() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  if ensure check(foo=bar baz) {",
    "    log \"ok\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if";
    negated: boolean;
    condition: { kind: "ensure"; ref: { value: string }; args?: string };
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, false);
  assert.equal(step.condition.ref.value, "check");
  assert.equal(step.condition.args, "foo=bar baz");
});

test("parser: negated if ensure with args parses correctly", () => {
  const source = [
    "rule check() {",
    "  return \"ok\"",
    "}",
    "workflow fix() {",
    "  log \"fix\"",
    "}",
    "workflow default() {",
    "  if not ensure check(foo=bar) {",
    "    run fix()",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[1].steps[0] as {
    type: "if";
    negated: boolean;
    condition: { kind: "ensure"; ref: { value: string }; args?: string };
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
  assert.equal(step.condition.args, "foo=bar");
});

test("parser: if ensure with else branch parses correctly", () => {
  const source = [
    "rule ready() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  if ensure ready() {",
    "    log \"yes\"",
    "  } else {",
    "    log \"no\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if";
    negated: boolean;
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, false);
  assert.equal(step.thenSteps.length, 1);
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("parser: negated if ensure with else branch parses correctly", () => {
  const source = [
    "rule ready() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  if not ensure ready() {",
    "    log \"fail\"",
    "  } else {",
    "    log \"pass\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if";
    negated: boolean;
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
  assert.equal(step.thenSteps.length, 1);
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("parser: malformed if ensure emits E_PARSE", () => {
  const source = [
    "workflow default() {",
    "  if ensure; then",
    "    log \"x\"",
    "  fi",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /then\/fi syntax is not supported/,
  );
});

test("parser: fail step parses quoted message", () => {
  const source = [
    "workflow default() {",
    '  fail "expected reason"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as { type: string; message: string };
  assert.equal(step.type, "fail");
  assert.equal(step.message, '"expected reason"');
});

test("parser: const string expr and const run capture parse", () => {
  const source = [
    'script noop = `:`',
    "workflow default() {",
    '  const msg = "hi"',
    "  const out = run noop()",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 2);
  const c0 = steps[0] as { type: string; name: string; value: { kind: string; bashRhs?: string } };
  const c1 = steps[1] as { type: string; name: string; value: { kind: string } };
  assert.equal(c0.type, "const");
  assert.equal(c0.name, "msg");
  assert.equal(c0.value.kind, "expr");
  assert.equal(c0.value.bashRhs, '"hi"');
  assert.equal(c1.type, "const");
  assert.equal(c1.name, "out");
  assert.equal(c1.value.kind, "run_capture");
});

test("parser: const rejects bare call-like rhs without run", () => {
  const source = [
    'script some_script = `echo "$1"`',
    "workflow default() {",
    '  const x = some_script("${arg}")',
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /Script calls in const assignments must use run/,
  );
});

test("parser: const allows run-wrapped script call with args", () => {
  const source = [
    'script some_script = `echo "$1"`',
    "workflow default() {",
    '  const x = run some_script(arg1)',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    name: string;
    value: { kind: string; ref?: { value: string }; args?: string };
  };
  assert.equal(step.type, "const");
  assert.equal(step.name, "x");
  assert.equal(step.value.kind, "run_capture");
  assert.equal(step.value.ref?.value, "some_script");
  assert.equal(step.value.args, '${arg1}');
});

test("parser: const prompt capture parses", () => {
  const source = [
    "workflow default() {",
    '  const ans = prompt "type here"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    name: string;
    value: { kind: string };
  };
  assert.equal(step.type, "const");
  assert.equal(step.name, "ans");
  assert.equal(step.value.kind, "prompt_capture");
});

test("parser: wait parses as workflow step (not shell)", () => {
  const source = [
    "workflow default() {",
    "  wait",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps[0].type, "wait");
});

test("parser: brace-style if parses not, else if, and else", () => {
  const source = [
    "rule ok() {",
    "  return \"ok\"",
    "}",
    "rule bad() {",
    "  fail \"no\"",
    "}",
    'script check = `true`',
    "workflow default() {",
    "  if not ensure bad() {",
    "    log \"neg\"",
    "  }",
    "  else if run check() {",
    "    log \"elif\"",
    "  }",
    "  else {",
    "    log \"final\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    negated: boolean;
    elseIfBranches?: Array<{ negated: boolean; condition: { kind: string } }>;
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
  assert.ok(step.elseIfBranches);
  assert.equal(step.elseIfBranches!.length, 1);
  assert.equal(step.elseIfBranches![0].negated, false);
  assert.equal(step.elseIfBranches![0].condition.kind, "run");
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("parser: send operator parses channel <- \"literal\"", () => {
  const source = [
    "workflow default() {",
    `  findings <- "hello"`,
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  if (step.type !== "send") throw new Error("expected send");
  assert.equal(step.rhs.kind, "literal");
  assert.equal(step.rhs.token, `"hello"`);
  assert.equal(step.channel, "findings");
});

test("parser: top-level channel declarations parse and are stored", () => {
  const source = [
    "channel findings",
    "channel report -> analyst",
    "workflow analyst() {",
    "  log \"ok\"",
    "}",
    "workflow default() {",
    `  findings <- "hi"`,
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.deepStrictEqual(mod.channels.map((c) => c.name), ["findings", "report"]);
  const reportCh = mod.channels.find((c) => c.name === "report")!;
  assert.ok(reportCh.routes);
  assert.equal(reportCh.routes!.length, 1);
  assert.equal(reportCh.routes![0].value, "analyst");
  const defaultWf = mod.workflows.find((w) => w.name === "default")!;
  assert.equal(defaultWf.steps.length, 1);
  assert.equal(defaultWf.steps[0].type, "send");
});

test("parser: channel declaration must be single per line", () => {
  const source = [
    "channel findings, report",
    "workflow default() {",
    `  findings <- "hi"`,
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /invalid channel declaration/,
  );
});

test("validator: unknown local channel fails with required message", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-channel-local-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow analyst() {",
        "  log \"ok\"",
        "}",
        "workflow default() {",
        `  typo <- "x"`,
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => emitScriptsForModule(input, root),
      /E_VALIDATE Channel "typo" is not defined/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validator: missing channel import fails with required message", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-channel-import-"));
  try {
    const shared = join(root, "shared.jh");
    writeFileSync(
      shared,
      [
        "channel findings",
        "workflow analyst() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'import "shared.jh" as shared',
        "workflow default() {",
        `  shared.typo <- "x"`,
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => emitScriptsForModule(input, root),
      /E_VALIDATE Channel "shared\.typo" is not defined/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser: standalone channel <- forwards $1", () => {
  const source = [
    "workflow default() {",
    "  findings <-",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  assert.equal(step.type === "send" && step.rhs.kind, "forward");
  assert.equal((step as { type: "send"; channel: string }).channel, "findings");
});

test("parser: <- inside quotes is not a send", () => {
  const source = [
    "workflow default() {",
    '  log "a <- b"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  assert.equal(mod.workflows[0].steps[0].type, "log");
});

test("parser: channel route declaration parses into ChannelDef.routes", () => {
  const source = [
    "channel findings -> analyst",
    "workflow analyst() {",
    "  log \"ok\"",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const ch = mod.channels.find((c) => c.name === "findings")!;
  assert.ok(ch.routes);
  assert.equal(ch.routes!.length, 1);
  assert.equal(ch.routes![0].value, "analyst");
});

test("parser: channel route with multiple targets", () => {
  const source = [
    "channel findings -> a, b",
    "workflow a() {",
    "  log \"ok\"",
    "}",
    "workflow b() {",
    "  log \"ok\"",
    "}",
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const ch = mod.channels.find((c) => c.name === "findings")!;
  assert.ok(ch.routes);
  assert.equal(ch.routes!.length, 2);
  assert.equal(ch.routes![0].value, "a");
  assert.equal(ch.routes![1].value, "b");
});

test("parser: route inside workflow body is a hard parse error", () => {
  const source = [
    "workflow default() {",
    "  findings -> analyst",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /route declarations belong at the top level/,
  );
});

test("parser: capture + send is E_PARSE", () => {
  const source = [
    "workflow default() {",
    `  name = channel <- "hello"`,
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /capture and send cannot be combined/,
  );
});

// === Top-level const (env declaration) tests ===

test("parser: top-level const declaration parses single-line string", () => {
  const source = [
    'const greeting = "hello world"',
    "workflow default() {",
    "  log \"${greeting}\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "greeting");
  assert.equal(mod.envDecls![0].value, "hello world");
});

test("parser: top-level const declaration parses multi-line string", () => {
  const source = [
    'const role = """',
    "You are an expert.",
    "    1. You write clearly",
    "    2. You are concise",
    '"""',
    "workflow default() {",
    "  log \"${role}\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "role");
  assert.ok(mod.envDecls![0].value.includes("You are an expert."));
  assert.ok(mod.envDecls![0].value.includes("You are concise"));
});

test("parser: top-level const declaration parses bare value", () => {
  const source = [
    "const count = 42",
    "workflow default() {",
    "  log \"${count}\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls![0].name, "count");
  assert.equal(mod.envDecls![0].value, "42");
});

test("parser: top-level local keyword is rejected", () => {
  const source = [
    'local greeting = "hello world"',
    "workflow default() {",
    "  log \"${greeting}\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /unknown top-level keyword "local" — use const NAME = VALUE/,
  );
});

test("parser: top-level const name collision with rule is E_PARSE", () => {
  const source = [
    'const foo = "bar"',
    "rule foo() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  ensure foo()",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "foo".*variable name collides with rule/,
  );
});

test("parser: top-level const name collision with workflow is E_PARSE", () => {
  const source = [
    'const default = "val"',
    "workflow default() {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "default".*variable name collides with workflow/,
  );
});

test("parser: top-level const name collision with script is E_PARSE", () => {
  const source = [
    'const helper = "val"',
    'script helper = `echo ok`',
    "workflow default() {",
    "  run helper()",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "helper".*variable name collides with script/,
  );
});


// === script isolation golden tests ===

test("compiler golden: standalone script file has no env shims (isolation)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-script-iso-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'const greeting = "hello world"',
        "",
        'script helper = `echo $greeting`',
        "",
        "workflow default() {",
        "  run helper()",
        "}",
        "",
      ].join("\n"),
    );

    const scripts = emitScriptsForModule(input, root);
    assert.equal(scripts.length, 1);
    const scriptContent = scripts[0].content;
    // Script file must NOT contain env shim lines
    assert.ok(!/local greeting="\$entry__greeting"/.test(scriptContent), "script file should not contain env shim for greeting");
    assert.ok(!/entry__/.test(scriptContent), "script file should not reference prefixed module variables");
    // Script file should still contain the body
    assert.ok(scriptContent.includes("echo $greeting"), "script body preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: multiline double-quoted strings are not corrupted by emit indent", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-script-multiline-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "script multiline_str = ```",
        'local x="a',
        'b"',
        "```",
        "",
        "workflow default() {",
        "  run multiline_str()",
        "}",
        "",
      ].join("\n"),
    );

    const scripts = emitScriptsForModule(input, root);
    assert.equal(scripts.length, 1);
    const scriptContent = scripts[0].content;
    assert.ok(
      /local x="a\nb"/.test(scriptContent),
      "multiline string must stay a\\nb without injected spaces on continuation lines",
    );
    assert.ok(!scriptContent.includes("a\n  b"), "emit must not prefix continuation lines inside strings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: script bodies are opaque bash (cross-script name compiles)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-cross-script-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'script helper = `echo ok`',
        "",
        'script caller = `helper`',
        "",
        "workflow default() {",
        "  run caller()",
        "}",
        "",
      ].join("\n"),
    );
    const scripts = emitScriptsForModule(input, root);
    const caller = scripts.find((s) => s.name === "caller");
    assert.ok(caller, "caller script emitted");
    assert.ok(caller!.content.includes("helper"), "opaque body preserves shell line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: script calling itself is allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-script-self-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'script recurse = `recurse`',
        "",
        "workflow default() {",
        "  run recurse()",
        "}",
        "",
      ].join("\n"),
    );
    // Self-reference should not throw (a script calling itself is recursion, not cross-script)
    const scripts = emitScriptsForModule(input, root);
    assert.equal(scripts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
