import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCompile, isMissingBinaryError, missingBinaryMessage } from "../src/compile";

// These tests run the REAL monorepo `jaiph` CLI so they break if the
// `jaiph compile --json` contract (JSON array of {file,line,col,code,message}
// on stdout, non-zero exit on errors) ever changes.
const PLUGIN_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(PLUGIN_ROOT, "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli.js");
const FIXTURES = path.join(PLUGIN_ROOT, "test", "fixtures");

let shim: string;

before(() => {
  assert.ok(
    fs.existsSync(CLI),
    `built CLI not found at ${CLI}; run \`npm run build\` at the repo root first`,
  );
  // A tiny executable that dispatches into the built CLI's runCli(), so the
  // extension's execFile(compilerPath, ["compile", ...]) path is exercised
  // exactly as it runs against a real `jaiph` binary.
  shim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jaiph-shim-")), "jaiph");
  fs.writeFileSync(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(CLI)}).runCli(process.argv);\n`);
  fs.chmodSync(shim, 0o755);
});

test("happy path: a valid .jh file yields zero diagnostics", async () => {
  const result = await runCompile({
    compilerPath: shim,
    filePath: path.join(FIXTURES, "valid.jh"),
    usingDefaultPath: true,
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.diagnostics.length, 0);
});

test("error path: an invalid .jh file yields a diagnostic in the CLI's JSON shape", async () => {
  const result = await runCompile({
    compilerPath: shim,
    filePath: path.join(FIXTURES, "invalid.jh"),
    usingDefaultPath: true,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.ok(result.diagnostics.length >= 1, "expected at least one diagnostic");
  const d = result.diagnostics[0];
  assert.equal(typeof d.file, "string");
  assert.equal(typeof d.line, "number");
  assert.equal(typeof d.col, "number");
  assert.match(d.code, /^E_/);
  assert.equal(typeof d.message, "string");
  assert.ok(d.file.endsWith("invalid.jh"));
});

test("missing binary (default path) reports a clear configuration error", async () => {
  const result = await runCompile({
    compilerPath: "jaiph-does-not-exist-xyz",
    filePath: path.join(FIXTURES, "valid.jh"),
    usingDefaultPath: true,
  });
  assert.equal(result.kind, "config-error");
  if (result.kind === "config-error") {
    assert.match(result.message, /not found on PATH/);
    assert.match(result.message, /jaiph\.compilerPath/);
  }
});

test("missing binary (configured path) names the bad path", async () => {
  const bad = "/nonexistent/bin/jaiph";
  const result = await runCompile({
    compilerPath: bad,
    filePath: path.join(FIXTURES, "valid.jh"),
    usingDefaultPath: false,
  });
  assert.equal(result.kind, "config-error");
  if (result.kind === "config-error") assert.ok(result.message.includes(bad));
});

test("isMissingBinaryError classifies spawn failures, not exit codes", () => {
  assert.equal(isMissingBinaryError({ name: "", message: "", code: "ENOENT" }), true);
  assert.equal(isMissingBinaryError({ name: "", message: "", code: "EACCES" }), true);
  assert.equal(isMissingBinaryError({ name: "", message: "", code: 1 }), false);
  assert.equal(isMissingBinaryError(null), false);
  assert.match(missingBinaryMessage("jaiph", true), /not found on PATH/);
});
