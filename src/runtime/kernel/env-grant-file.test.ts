// The off-process `--env` grant transport: values are written to a private
// tmpdir file (never on the runner env) and read back by the detached leader,
// which removes the file on read.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { writeEnvGrantFile, readEnvGrantFile } from "./env-grant-file";

test("writeEnvGrantFile + readEnvGrantFile: round-trips the value map and removes the file on read", () => {
  const file = writeEnvGrantFile({ GITHUB_TOKEN: "ghs_test", OTHER: "" });
  assert.ok(existsSync(file), "the grant file exists after write");
  const values = readEnvGrantFile(file);
  assert.deepEqual(values, { GITHUB_TOKEN: "ghs_test", OTHER: "" });
  assert.ok(!existsSync(file), "read removes the grant file");
  assert.ok(!existsSync(dirname(file)), "read removes the grant dir");
});

test("readEnvGrantFile: undefined path yields an empty map (fail-closed)", () => {
  assert.deepEqual(readEnvGrantFile(undefined), {});
});

test("readEnvGrantFile: a missing file yields an empty map without throwing", () => {
  assert.deepEqual(readEnvGrantFile("/nonexistent/jaiph-grant/grant.json"), {});
});
