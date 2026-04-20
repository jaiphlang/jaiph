import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bug fix: `runWorkflowRaw` must respect a host-provided `JAIPH_META_FILE`
 * env var so that `executeIsolatedRunRef` can read `return_value` back from
 * the inner runtime after the container exits. Without this, the meta file
 * lives in a container-local tmp dir and is lost — which made every async
 * isolated branch resolve to an empty string regardless of what the inner
 * workflow returned.
 */
test("ACCEPTANCE: jaiph run --raw --entry writes meta to JAIPH_META_FILE when set", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-raw-meta-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const workflowPath = join(root, "returns.jh");
  const metaPath = join(root, "host-allocated-meta.txt");
  const targetDir = join(root, "out");

  writeFileSync(
    workflowPath,
    [
      "workflow returns_path() {",
      '  return "hello-from-inner-workflow"',
      "}",
      "",
      "workflow default() {",
      "  log \"unused\"",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "run", "--raw", "--entry", "returns_path", "--target", targetDir, workflowPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          JAIPH_META_FILE: metaPath,
          JAIPH_UNSAFE: "true",
        },
      },
    );
    assert.equal(result.status, 0, `run failed: ${result.stderr ?? ""}`);

    const meta = readFileSync(metaPath, "utf8");
    assert.match(
      meta,
      /^return_value=hello-from-inner-workflow$/m,
      `meta file missing return_value line:\n${meta}`,
    );
    assert.match(meta, /^status=0$/m, `meta file missing status=0 line:\n${meta}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Without JAIPH_META_FILE set, raw mode falls back to its private temp dir
 * (and cleans it up). The CLI still exits cleanly. This pins the contract
 * so a future "always use env" refactor doesn't accidentally break the
 * standalone behavior.
 */
test("ACCEPTANCE: jaiph run --raw --entry without JAIPH_META_FILE still succeeds", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-raw-no-meta-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const workflowPath = join(root, "returns.jh");
  const targetDir = join(root, "out");

  writeFileSync(
    workflowPath,
    [
      "workflow returns_path() {",
      '  return "ok"',
      "}",
      "",
      "workflow default() { log \"unused\" }",
      "",
    ].join("\n"),
  );

  const env: NodeJS.ProcessEnv = { ...process.env, JAIPH_UNSAFE: "true" };
  delete env.JAIPH_META_FILE;

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "run", "--raw", "--entry", "returns_path", "--target", targetDir, workflowPath],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, `run failed: ${result.stderr ?? ""}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
