import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { buildScriptFiles } from "./emit-script";

test("inline script body is emitted verbatim (\\n is not turned into a newline)", () => {
  const mod = parsejaiph(
    "export def main() {\n  'printf \"%s\" \"x\\ny\"'()\n  '''\n    echo 'lit\\nend'\n  '''()\n}\n",
    "t.jh",
  );
  const files = buildScriptFiles(mod, new Map(), "main");
  const inline = files.filter((f) => f.name.startsWith("__inline_")).map((f) => f.content);
  assert.equal(inline.length, 2);
  assert.ok(inline.some((c) => c.includes('printf "%s" "x\\ny"')), "one-liner keeps backslash-n");
  assert.ok(inline.some((c) => c.includes("echo 'lit\\nend'")), "fenced body keeps backslash-n");
});
