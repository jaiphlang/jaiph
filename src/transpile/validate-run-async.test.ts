import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("E_VALIDATE: run async is accepted in workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-async-wf-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "workflow helper() {",
        '  log "hi"',
        "}",
        "workflow default() {",
        "  run async helper()",
        "}",
        "",
      ].join("\n"),
    );
    // Should not throw
    buildScripts(join(root, "m.jh"), join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
