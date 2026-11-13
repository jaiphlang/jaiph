import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGraph } from "./graph";

/** Run `jaiph graph <args>` capturing stdout, stderr, and the exit code. */
function captureGraph(args: string[]): { code: number; stdout: string; stderr: string } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  (process.stdout as NodeJS.WriteStream).write = ((s: string) => {
    stdout += s;
    return true;
  }) as typeof process.stdout.write;
  (process.stderr as NodeJS.WriteStream).write = ((s: string) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = runGraph(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function withFile(name: string, src: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, src, "utf8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID = `export def main() {
  helper()
}
def helper() {
  log "hi"
}
`;

test("graph: default entry is main and emits a flowchart to stdout", () => {
  withFile("flow.jh", VALID, (path) => {
    const r = captureGraph([path]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.startsWith("flowchart TD\n"), r.stdout);
    assert.ok(r.stdout.includes('subgraph sg1 ["def main"]'), r.stdout);
  });
});

test("graph: --def picks a non-exported def", () => {
  withFile("flow.jh", VALID, (path) => {
    const r = captureGraph(["--def", "helper", path]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('subgraph sg1 ["def helper"]'), r.stdout);
  });
});

test("graph: a missing def exits 1 and lists the available defs", () => {
  withFile("flow.jh", VALID, (path) => {
    const r = captureGraph(["--def", "nope", path]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no def "nope"/);
    assert.match(r.stderr, /Available defs: main, helper/);
  });
});

test("graph: a compile error exits 1 with a diagnostic on stderr and empty stdout", () => {
  withFile("bad.jh", `export def main() {\n  missing_def()\n}\n`, (path) => {
    const r = captureGraph([path]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /bad\.jh:2:3 E_VALIDATE/);
  });
});

test("graph: a *.test.jh argument is a usage error", () => {
  withFile("flow.test.jh", `test "t" {\n}\n`, (path) => {
    const r = captureGraph([path]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /cannot graph a \*\.test\.jh file/);
  });
});

test("graph: --help prints usage and exits 0", () => {
  const r = captureGraph(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: jaiph graph/);
});
