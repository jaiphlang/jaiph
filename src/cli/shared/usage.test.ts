import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, printUsage } from "./usage";

function captureStdout(): { restore: () => void; text: () => string } {
  let buf = "";
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => { process.stdout.write = orig; },
    text: () => buf,
  };
}

// ---------------------------------------------------------------------------
// parseArgs: existing behavior (regression)
// ---------------------------------------------------------------------------

test("parseArgs: --target captures next arg and continues parsing", () => {
  const r = parseArgs(["--target", "/tmp/out", "flow.jh", "hello"]);
  assert.equal(r.target, "/tmp/out");
  assert.deepEqual(r.positional, ["flow.jh", "hello"]);
});

test("parseArgs: --target without a value throws", () => {
  assert.throws(() => parseArgs(["--target"]), /--target requires a directory path/);
});

test("parseArgs: --raw sets raw=true", () => {
  const r = parseArgs(["--raw", "flow.jh"]);
  assert.equal(r.raw, true);
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: -- terminates flag parsing and pushes the rest into positional", () => {
  const r = parseArgs(["--raw", "flow.jh", "--", "--raw", "--target", "foo"]);
  assert.equal(r.raw, true);
  assert.deepEqual(r.positional, ["flow.jh", "--raw", "--target", "foo"]);
});

// ---------------------------------------------------------------------------
// parseArgs: new flags
// ---------------------------------------------------------------------------

test("parseArgs: --workspace captures next arg", () => {
  const r = parseArgs(["--workspace", "/tmp/ws", "flow.jh"]);
  assert.equal(r.workspace, "/tmp/ws");
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --workspace without a value throws", () => {
  assert.throws(() => parseArgs(["--workspace"]), /--workspace requires a directory path/);
});

test("parseArgs: -- still terminates parsing after --workspace; post-`--` tokens land in positional unchanged", () => {
  const r = parseArgs(["--workspace", "/tmp/ws", "flow.jh", "--", "--workspace", "--raw"]);
  assert.equal(r.workspace, "/tmp/ws");
  assert.deepEqual(r.positional, ["flow.jh", "--workspace", "--raw"]);
});

test("parseArgs: all flags combined", () => {
  const r = parseArgs([
    "--raw",
    "--target", "/tmp/out",
    "--workspace", "/tmp/ws",
    "flow.jh",
    "arg1",
  ]);
  assert.equal(r.raw, true);
  assert.equal(r.target, "/tmp/out");
  assert.equal(r.workspace, "/tmp/ws");
  assert.deepEqual(r.positional, ["flow.jh", "arg1"]);
});

// ---------------------------------------------------------------------------
// parseArgs: --flag=value form
// ---------------------------------------------------------------------------

test("parseArgs: --workspace=value form captures the value", () => {
  const r = parseArgs(["--workspace=/tmp/ws", "flow.jh"]);
  assert.equal(r.workspace, "/tmp/ws");
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --target=value form captures the value", () => {
  const r = parseArgs(["--target=/tmp/out", "flow.jh", "hello"]);
  assert.equal(r.target, "/tmp/out");
  assert.deepEqual(r.positional, ["flow.jh", "hello"]);
});

test("parseArgs: --flag=value and --flag value forms are equivalent", () => {
  const eq = parseArgs(["--workspace=/tmp/ws", "--target=/tmp/out", "flow.jh"]);
  const sp = parseArgs(["--workspace", "/tmp/ws", "--target", "/tmp/out", "flow.jh"]);
  assert.deepEqual(eq, sp);
});

test("parseArgs: --workspace= splits on the first '=' so values may contain '='", () => {
  const r = parseArgs(["--workspace=/tmp/a=b", "flow.jh"]);
  assert.equal(r.workspace, "/tmp/a=b");
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --workspace= with empty value throws", () => {
  assert.throws(() => parseArgs(["--workspace="]), /--workspace requires a directory path/);
});

test("parseArgs: boolean flag with =value form throws", () => {
  assert.throws(() => parseArgs(["--raw=true", "flow.jh"]), /--raw does not take a value/);
});

test("parseArgs: --flag=value after -- is left untouched in positional", () => {
  const r = parseArgs(["flow.jh", "--", "--workspace=/should/not/parse"]);
  assert.equal(r.workspace, undefined);
  assert.deepEqual(r.positional, ["flow.jh", "--workspace=/should/not/parse"]);
});

// ---------------------------------------------------------------------------
// parseArgs: --env passthrough
// ---------------------------------------------------------------------------

test("parseArgs: repeatable --env collected in flag order", () => {
  const r = parseArgs(["--env", "A=1", "--env", "B=2", "--env", "C=3", "flow.jh"]);
  assert.deepEqual(r.env, [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
    { key: "C", value: "3" },
  ]);
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --env KEY=VALUE captures the explicit value", () => {
  const r = parseArgs(["--env", "GREETING=hi", "flow.jh"]);
  assert.deepEqual(r.env, [{ key: "GREETING", value: "hi" }]);
});

test("parseArgs: bare --env KEY defers to a spawn-time host lookup (no value recorded)", () => {
  const r = parseArgs(["--env", "GITHUB_TOKEN", "flow.jh"]);
  assert.deepEqual(r.env, [{ key: "GITHUB_TOKEN" }]);
  assert.equal(r.env[0].value, undefined);
});

test("parseArgs: --env value preserves '=' after the first split", () => {
  const r = parseArgs(["--env", "URL=https://x.test/a=b&c=d", "flow.jh"]);
  assert.deepEqual(r.env, [{ key: "URL", value: "https://x.test/a=b&c=d" }]);
});

test("parseArgs: --env KEY= allows an empty value", () => {
  const r = parseArgs(["--env", "EMPTY=", "flow.jh"]);
  assert.deepEqual(r.env, [{ key: "EMPTY", value: "" }]);
});

test("parseArgs: --env=KEY=VALUE inline form is equivalent to the spaced form", () => {
  const inline = parseArgs(["--env=GREETING=hi", "flow.jh"]);
  const spaced = parseArgs(["--env", "GREETING=hi", "flow.jh"]);
  assert.deepEqual(inline.env, spaced.env);
});

test("parseArgs: --env with an invalid name is rejected (E_ENV_INVALID)", () => {
  assert.throws(() => parseArgs(["--env", "1BAD=x", "flow.jh"]), /E_ENV_INVALID/);
  assert.throws(() => parseArgs(["--env", "has-dash=x", "flow.jh"]), /E_ENV_INVALID/);
});

test("parseArgs: --env with no argument at all throws", () => {
  assert.throws(() => parseArgs(["flow.jh", "--env"]), /--env requires a KEY or KEY=VALUE argument/);
});

test("parseArgs: --env after -- is not parsed (lands in positional)", () => {
  const r = parseArgs(["flow.jh", "--", "--env", "A=1"]);
  assert.deepEqual(r.env, []);
  assert.deepEqual(r.positional, ["flow.jh", "--env", "A=1"]);
});

// Reserved-key rejection (E_ENV_RESERVED), per category and both flag forms.

test("parseArgs: --env rejects a runtime-managed key (E_ENV_RESERVED), KEY=VALUE form", () => {
  assert.throws(() => parseArgs(["--env", "JAIPH_WORKSPACE=/x", "flow.jh"]), /E_ENV_RESERVED/);
});

test("parseArgs: --env rejects a runtime-managed key (E_ENV_RESERVED), bare KEY form", () => {
  assert.throws(() => parseArgs(["--env", "JAIPH_RUNS_DIR", "flow.jh"]), /E_ENV_RESERVED/);
});

// ---------------------------------------------------------------------------
// parseArgs: per-command flag scoping — shared execution-policy set everywhere,
// command-specific flags rejected elsewhere, unknown flags never positionals
// ---------------------------------------------------------------------------

test("parseArgs: shared flags parse identically for run, serve, and mcp", () => {
  for (const command of ["run", "serve", "mcp"] as const) {
    const r = parseArgs(
      ["--workspace", "/tmp/ws", "--env", "A=1", "flow.jh"],
      command,
    );
    assert.equal(r.workspace, "/tmp/ws", `${command}: --workspace`);
    assert.deepEqual(r.env, [{ key: "A", value: "1" }], `${command}: --env`);
    assert.deepEqual(r.positional, ["flow.jh"], `${command}: positional`);
  }
});

test("parseArgs: --allow-anonymous is a serve-only boolean flag", () => {
  const r = parseArgs(["--allow-anonymous", "flow.jh"], "serve");
  assert.equal(r.allowAnonymous, true);
  assert.deepEqual(r.positional, ["flow.jh"]);
  // Not accepted by run or mcp, and it takes no value.
  assert.throws(() => parseArgs(["--allow-anonymous", "flow.jh"], "run"), /--allow-anonymous is not a jaiph run flag.*jaiph serve/);
  assert.throws(() => parseArgs(["--allow-anonymous", "flow.jh"], "mcp"), /--allow-anonymous is not a jaiph mcp flag.*jaiph serve/);
  assert.throws(() => parseArgs(["--allow-anonymous=1", "flow.jh"], "serve"), /--allow-anonymous does not take a value/);
});

test("parseArgs: run rejects serve's transport flags, naming the owning command", () => {
  assert.throws(() => parseArgs(["--host", "0.0.0.0", "flow.jh"], "run"), /--host is not a jaiph run flag.*jaiph serve/);
  assert.throws(() => parseArgs(["--port", "8080", "flow.jh"], "run"), /--port is not a jaiph run flag.*jaiph serve/);
});

test("parseArgs: serve rejects run-only flags as usage errors", () => {
  assert.throws(() => parseArgs(["--target", "/tmp/out", "flow.jh"], "serve"), /--target is not a jaiph serve flag.*jaiph run/);
  assert.throws(() => parseArgs(["--raw", "flow.jh"], "serve"), /--raw is not a jaiph serve flag.*jaiph run/);
});

test("parseArgs: mcp rejects run-only and serve-only flags as usage errors", () => {
  assert.throws(() => parseArgs(["--raw", "flow.jh"], "mcp"), /--raw is not a jaiph mcp flag.*jaiph run/);
  assert.throws(() => parseArgs(["--target", "/tmp", "flow.jh"], "mcp"), /--target is not a jaiph mcp flag.*jaiph run/);
  assert.throws(() => parseArgs(["--host", "::1", "flow.jh"], "mcp"), /--host is not a jaiph mcp flag.*jaiph serve/);
  assert.throws(() => parseArgs(["--port", "1", "flow.jh"], "mcp"), /--port is not a jaiph mcp flag.*jaiph serve/);
});

test("parseArgs: an unknown flag is a usage error, not a positional", () => {
  assert.throws(() => parseArgs(["--bogus", "flow.jh"], "run"), /unknown flag --bogus for jaiph run/);
  assert.throws(() => parseArgs(["-x", "flow.jh"], "serve"), /unknown flag -x for jaiph serve/);
  assert.throws(() => parseArgs(["--bogus=1", "flow.jh"], "mcp"), /unknown flag --bogus for jaiph mcp/);
});

test("parseArgs: jaiph run's unknown-flag error points at -- for dash-leading workflow args", () => {
  assert.throws(() => parseArgs(["flow.jh", "-v5"], "run"), /Use `--` before workflow arguments/);
});

test("parseArgs: rejected flags are still fine after -- (workflow args untouched)", () => {
  const r = parseArgs(["flow.jh", "--", "--host", "--bogus", "-x"], "mcp");
  assert.deepEqual(r.positional, ["flow.jh", "--host", "--bogus", "-x"]);
});

test("parseArgs: a bare '-' stays positional", () => {
  const r = parseArgs(["-", "flow.jh"], "run");
  assert.deepEqual(r.positional, ["-", "flow.jh"]);
});

// ---------------------------------------------------------------------------
// printUsage: lists the new flags under `jaiph run`
// ---------------------------------------------------------------------------

test("printUsage: lists --workspace and --env under jaiph run", () => {
  const cap = captureStdout();
  try {
    printUsage();
  } finally {
    cap.restore();
  }
  const text = cap.text();
  const runSection = text.slice(text.indexOf("jaiph run:"));
  assert.ok(runSection.includes("--workspace"), "jaiph run section mentions --workspace");
  assert.ok(runSection.includes("--env"), "jaiph run section mentions --env");
});

test("printUsage: documents --env under jaiph mcp too", () => {
  const cap = captureStdout();
  try {
    printUsage();
  } finally {
    cap.restore();
  }
  const text = cap.text();
  const mcpSection = text.slice(text.indexOf("jaiph mcp:"));
  assert.ok(mcpSection.includes("--env"), "jaiph mcp section mentions --env");
});

test("printUsage: example shows --workspace", () => {
  const cap = captureStdout();
  try {
    printUsage();
  } finally {
    cap.restore();
  }
  assert.ok(
    cap.text().includes("jaiph run --workspace"),
    "examples block has the documented --workspace combo",
  );
});
