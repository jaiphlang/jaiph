import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeResult, type CollectedOutput } from "./call";

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
