import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHeartbeatLine } from "../src/cli/run/display";

test("formatHeartbeatLine matches step-end label shape", () => {
  const indent = "  · ";
  const line = formatHeartbeatLine(indent, "prompt", "prompt", 60, false);
  assert.equal(line, "  \u00b7 prompt prompt (running 60s)");
});

test("ACCEPTANCE: non-TTY long step emits gray heartbeat before completion", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nontty-hb-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const workflowPath = join(root, "hb.jh");

  writeFileSync(
    workflowPath,
    [
      "workflow inner {",
      "  sleep 3",
      "}",
      "",
      "workflow default {",
      "  run inner",
      "}",
    ].join("\n"),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "run", workflowPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC: "1",
          JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS: "500",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr ?? "");
    const out = result.stdout ?? "";
    assert.match(
      out,
      /\s\u00b7 workflow inner \(running [0-9]+s\)/,
      "expected heartbeat line before completion",
    );
    const hbIdx = out.search(/\s\u00b7 workflow inner \(running /);
    const okIdx = out.indexOf("\u2713 workflow inner");
    assert.ok(hbIdx !== -1 && okIdx !== -1 && hbIdx < okIdx, "heartbeat should precede completion line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
