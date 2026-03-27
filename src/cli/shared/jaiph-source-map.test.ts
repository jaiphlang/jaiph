import test from "node:test";
import assert from "node:assert/strict";
import { bashLineToJaiphSource, rewriteJaiphDiagnosticsLine, type SourceMapCache } from "./jaiph-source-map";

test("bashLineToJaiphSource picks nearest mapping at or before bash line", () => {
  const map = {
    version: 1 as const,
    shFile: "/tmp/x.sh",
    mappings: [
      { bashLine: 10, source: "/src/a.jh", line: 2, col: 1 },
      { bashLine: 50, source: "/src/a.jh", line: 8, col: 3 },
    ],
  };
  assert.equal(bashLineToJaiphSource(map, 5), null);
  assert.deepEqual(bashLineToJaiphSource(map, 10), { source: "/src/a.jh", line: 2, col: 1 });
  assert.deepEqual(bashLineToJaiphSource(map, 49), { source: "/src/a.jh", line: 2, col: 1 });
  assert.deepEqual(bashLineToJaiphSource(map, 50), { source: "/src/a.jh", line: 8, col: 3 });
});

test("rewriteJaiphDiagnosticsLine maps bash stderr fragments", () => {
  const cache: SourceMapCache = new Map([
    [
      "/tmp/out/main.sh",
      {
        version: 1,
        shFile: "/tmp/out/main.sh",
        mappings: [{ bashLine: 100, source: "/proj/main.jh", line: 4, col: 1 }],
      },
    ],
  ]);
  const line = "/tmp/out/main.sh: line 105: false: command not found";
  const out = rewriteJaiphDiagnosticsLine(line, cache);
  assert.match(out, /\/proj\/main\.jh:4:1 \(bash \/tmp\/out\/main\.sh:105\)/);
});
