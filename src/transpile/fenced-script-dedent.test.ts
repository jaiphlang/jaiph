import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitScriptsForModule } from "../transpiler";

test("emit: dedented fenced script preserves heredoc delimiter at column 0", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-fenced-dedent-"));
  try {
    const input = join(root, "heredoc.jh");
    const source = [
      "script write_queue = ```",
      "  tmp_dir=\"$1\"",
      "  cat > \"$tmp_dir/QUEUE.md\" <<'EOF'",
      "  # Queue",
      "  roundtrip-ok",
      "  EOF",
      "```",
      "",
      "workflow default(tmp_dir) {",
      "  run write_queue(tmp_dir)",
      "}",
      "",
    ].join("\n");
    writeFileSync(input, source, "utf8");

    const scripts = emitScriptsForModule(input, root);
    const artifact = scripts.find((s) => s.name === "write_queue");
    assert.ok(artifact, "write_queue script artifact missing");
    assert.match(artifact.content, /cat > "\$tmp_dir\/QUEUE\.md" <<'EOF'\n# Queue\nroundtrip-ok\nEOF/);
    assert.doesNotMatch(artifact.content, /  EOF/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
