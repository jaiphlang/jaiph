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

test("parseArgs: --inplace sets inplace=true", () => {
  const r = parseArgs(["--inplace", "flow.jh"]);
  assert.equal(r.inplace, true);
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --unsafe sets unsafe=true", () => {
  const r = parseArgs(["--unsafe", "flow.jh"]);
  assert.equal(r.unsafe, true);
  assert.deepEqual(r.positional, ["flow.jh"]);
});

test("parseArgs: --yes sets yes=true", () => {
  const r = parseArgs(["--yes", "flow.jh"]);
  assert.equal(r.yes, true);
});

test("parseArgs: -y short form sets yes=true", () => {
  const r = parseArgs(["-y", "flow.jh"]);
  assert.equal(r.yes, true);
});

test("parseArgs: -- still terminates parsing after new flags; post-`--` tokens land in positional unchanged", () => {
  const r = parseArgs(["--inplace", "flow.jh", "--", "--inplace", "--unsafe", "--yes"]);
  assert.equal(r.inplace, true);
  assert.equal(r.unsafe, undefined);
  assert.equal(r.yes, undefined);
  assert.deepEqual(r.positional, ["flow.jh", "--inplace", "--unsafe", "--yes"]);
});

test("parseArgs: all new flags combined with existing flags", () => {
  const r = parseArgs([
    "--raw",
    "--target", "/tmp/out",
    "--workspace", "/tmp/ws",
    "--inplace",
    "--yes",
    "flow.jh",
    "arg1",
  ]);
  assert.equal(r.raw, true);
  assert.equal(r.target, "/tmp/out");
  assert.equal(r.workspace, "/tmp/ws");
  assert.equal(r.inplace, true);
  assert.equal(r.yes, true);
  assert.equal(r.unsafe, undefined);
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
  assert.throws(() => parseArgs(["--inplace=true", "flow.jh"]), /--inplace does not take a value/);
});

test("parseArgs: --flag=value after -- is left untouched in positional", () => {
  const r = parseArgs(["flow.jh", "--", "--workspace=/should/not/parse"]);
  assert.equal(r.workspace, undefined);
  assert.deepEqual(r.positional, ["flow.jh", "--workspace=/should/not/parse"]);
});

// ---------------------------------------------------------------------------
// printUsage: lists the new flags under `jaiph run`
// ---------------------------------------------------------------------------

test("printUsage: lists --workspace, --inplace, --unsafe, --yes under jaiph run", () => {
  const cap = captureStdout();
  try {
    printUsage();
  } finally {
    cap.restore();
  }
  const text = cap.text();
  const runSection = text.slice(text.indexOf("jaiph run:"));
  assert.ok(runSection.includes("--workspace"), "jaiph run section mentions --workspace");
  assert.ok(runSection.includes("--inplace"), "jaiph run section mentions --inplace");
  assert.ok(runSection.includes("--unsafe"), "jaiph run section mentions --unsafe");
  assert.ok(runSection.includes("--yes"), "jaiph run section mentions --yes");
});

test("printUsage: example shows --inplace + --workspace combo", () => {
  const cap = captureStdout();
  try {
    printUsage();
  } finally {
    cap.restore();
  }
  assert.ok(
    cap.text().includes("jaiph run --inplace --workspace"),
    "examples block has the documented --inplace + --workspace combo",
  );
});
