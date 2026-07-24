import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachOutputCollector,
  capBytes,
  composeResult,
  TRUNCATION_MARKER,
  type CollectedOutput,
  type OutputCaps,
} from "./call";

const SECRET = "supersecretvalue123";
const ENV: NodeJS.ProcessEnv = { LEAK_API_KEY: SECRET };

const OK = { status: 0, signal: null } as const;
const FAIL = { status: 1, signal: null } as const;

function collected(partial: Partial<CollectedOutput>): CollectedOutput {
  return { logs: [], rawStderr: "", rawStdout: "", ...partial };
}

test("composeResult redacts the credential from every failure part but keeps context", () => {
  const result = composeResult(
    "boom",
    collected({
      failedStep: { name: "script leak", detail: `token is ${SECRET}` },
      rawStderr: `stderr saw ${SECRET}`,
      rawStdout: `stdout saw ${SECRET}`,
      logs: [`log saw ${SECRET}`],
    }),
    FAIL,
    "/runs/x",
    undefined,
    ENV,
  );
  assert.equal(result.isError, true);
  assert.ok(!result.text.includes(SECRET), "failure text must not contain the credential");
  assert.ok(result.text.includes("failed step: script leak"), "step context is retained");
  assert.ok(result.text.includes("token is [REDACTED]"), "step detail keeps context around the marker");
  assert.ok(result.text.includes("stderr saw [REDACTED]"), "raw stderr is redacted");
  assert.ok(result.text.includes("log output:\nlog saw [REDACTED]"), "collected logs are redacted");
  assert.ok(result.text.includes("run dir: /runs/x"), "run dir pointer is retained");
});

test("composeResult redacts raw stdout on failure when it is the only detail", () => {
  const result = composeResult("boom", collected({ rawStdout: `only stdout ${SECRET}` }), FAIL, undefined, undefined, ENV);
  assert.ok(!result.text.includes(SECRET));
  assert.equal(result.text.includes("only stdout [REDACTED]"), true);
});

test("composeResult leaves non-credential env values and short credentials alone", () => {
  const result = composeResult(
    "boom",
    collected({ rawStderr: "greeting hello-world, short abc" }),
    FAIL,
    undefined,
    undefined,
    { GREETING: "hello-world", TINY_API_KEY: "abc" },
  );
  assert.ok(result.text.includes("greeting hello-world, short abc"), "non-credential text is untouched");
});

test("composeResult returns a successful return value verbatim (intentional API output)", () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-call-rv-"));
  try {
    writeFileSync(join(runDir, "return_value.txt"), `deploy key ${SECRET}\n`);
    const result = composeResult("ok", collected({}), OK, runDir, undefined, ENV);
    assert.equal(result.isError, false);
    assert.equal(result.text, `deploy key ${SECRET}`, "return values are not diagnostic capture");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("composeResult redacts the log-fallback success text (diagnostic capture)", () => {
  const result = composeResult("ok", collected({ logs: [`log saw ${SECRET}`] }), OK, undefined, undefined, ENV);
  assert.equal(result.isError, false);
  assert.equal(result.text, "log saw [REDACTED]");
});

// === output byte caps (bounded memory) ===

const SMALL_CAPS: OutputCaps = { stdout: 64, stderr: 64, logs: 32, resultText: 128 };

test("capBytes returns short input verbatim and marks truncation on overflow", () => {
  assert.equal(capBytes("hello", 128), "hello");
  const capped = capBytes("x".repeat(10_000), 100);
  assert.ok(Buffer.byteLength(capped) <= 100 + Buffer.byteLength(TRUNCATION_MARKER), "bounded to cap + marker");
  assert.ok(capped.endsWith(TRUNCATION_MARKER), "marker appended");
  assert.equal(capped.slice(0, 100), "x".repeat(100), "head preserved up to the cap");
});

test("capBytes does not split a trailing multibyte char (no U+FFFD)", () => {
  // "€" is 3 UTF-8 bytes; a cap landing mid-char must drop the partial char.
  const capped = capBytes("€€€€", 4);
  assert.ok(!capped.includes("�"), "no replacement char leaks into the head");
  assert.equal(capped, "€" + TRUNCATION_MARKER);
});

test("composeResult caps result_text on a runaway failure and returns a deterministic marker", () => {
  const huge = "z".repeat(5 * 1024 * 1024); // 5 MiB of stdout from a hostile run
  const result = composeResult("boom", collected({ rawStdout: huge }), FAIL, undefined, undefined, ENV, SMALL_CAPS);
  assert.equal(result.isError, true);
  assert.ok(
    Buffer.byteLength(result.text) <= SMALL_CAPS.resultText + Buffer.byteLength(TRUNCATION_MARKER),
    `result_text stays within the cap (was ${Buffer.byteLength(result.text)} bytes)`,
  );
  assert.ok(result.text.endsWith(TRUNCATION_MARKER), "truncation marker is deterministic and present");
});

test("composeResult caps a runaway successful return value", () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-call-cap-"));
  try {
    writeFileSync(join(runDir, "return_value.txt"), "y".repeat(1024));
    const result = composeResult("ok", collected({}), OK, runDir, undefined, ENV, SMALL_CAPS);
    assert.equal(result.isError, false);
    assert.ok(Buffer.byteLength(result.text) <= SMALL_CAPS.resultText + Buffer.byteLength(TRUNCATION_MARKER));
    assert.ok(result.text.endsWith(TRUNCATION_MARKER));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

function fakeChild(): { child: ChildProcess; stdout: FakeStream; stderr: FakeStream } {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  return { child: { stdout, stderr } as unknown as ChildProcess, stdout, stderr };
}

test("attachOutputCollector bounds stdout, stderr, and logs, each with a marker", () => {
  const { child, stdout, stderr } = fakeChild();
  const { data, drain } = attachOutputCollector(child, undefined, SMALL_CAPS);

  // stdout: two 50-byte chunks — the second overflows the 64-byte cap.
  stdout.emit("data", "a".repeat(50));
  stdout.emit("data", "b".repeat(50));
  stdout.emit("data", "c".repeat(50)); // ignored once cut
  assert.ok(
    Buffer.byteLength(data.rawStdout) <= SMALL_CAPS.stdout + Buffer.byteLength(TRUNCATION_MARKER),
    "rawStdout bounded",
  );
  assert.ok(data.rawStdout.startsWith("a".repeat(50)));
  assert.ok(data.rawStdout.endsWith(TRUNCATION_MARKER));
  assert.ok(!data.rawStdout.includes("cccc"), "post-cut chunks are dropped");

  // stderr raw (non-event) lines: two 50-byte lines overflow the 64-byte cap.
  stderr.emit("data", `${"p".repeat(50)}\n${"q".repeat(50)}\n`);
  assert.ok(
    Buffer.byteLength(data.rawStderr) <= SMALL_CAPS.stderr + Buffer.byteLength(TRUNCATION_MARKER),
    "rawStderr bounded",
  );
  assert.ok(data.rawStderr.endsWith(TRUNCATION_MARKER));

  // logs: several event lines whose messages exceed the 32-byte logs cap.
  for (let i = 0; i < 5; i += 1) {
    stderr.emit("data", `__JAIPH_EVENT__ ${JSON.stringify({ type: "LOG", message: "m".repeat(20) })}\n`);
  }
  const logsBytes = data.logs.reduce((n, m) => n + Buffer.byteLength(m), 0);
  assert.ok(logsBytes <= SMALL_CAPS.logs + Buffer.byteLength(TRUNCATION_MARKER.trim()), "logs bounded");
  assert.equal(data.logs[data.logs.length - 1], TRUNCATION_MARKER.trim(), "logs truncation marker recorded once");
  assert.equal(data.logs.filter((m) => m === TRUNCATION_MARKER.trim()).length, 1, "marker pushed exactly once");
  drain();
});
