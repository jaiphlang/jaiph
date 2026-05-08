import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkjhFiles } from "./build";

describe("walkjhFiles", () => {
  it("ignores generated .jaiph runtime directories", () => {
    const root = mkdtempSync(join(tmpdir(), "jaiph-walk-"));
    try {
      mkdirSync(join(root, ".jaiph", "runs", ".sandbox", "e2e"), { recursive: true });
      mkdirSync(join(root, ".jaiph", "tmp"), { recursive: true });
      mkdirSync(join(root, ".jaiph", "artifacts"), { recursive: true });
      mkdirSync(join(root, ".jaiph", "src"), { recursive: true });

      const source = join(root, ".jaiph", "src", "workflow.jh");
      writeFileSync(source, "workflow default() {\n}\n");
      writeFileSync(join(root, ".jaiph", "runs", ".sandbox", "e2e", "old.jh"), "workflow stale() {\n}\n");
      writeFileSync(join(root, ".jaiph", "tmp", "scratch.jh"), "workflow scratch() {\n}\n");
      writeFileSync(join(root, ".jaiph", "artifacts", "patch.jh"), "workflow patch() {\n}\n");

      assert.deepEqual(walkjhFiles(root), [source]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
