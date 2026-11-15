import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { writeChainKeyFile, readChainKeyFile, CHAIN_KEY_FILE_ENV } from "./chain-key-file";

// The per-run audit-chain key travels to the detached leader through a private
// tmpdir file (chain-key-file.ts), never on a process environment — the same
// off-process hand-off as the `--env` grant values. These guard the round trip
// and the fail-closed reads.

test("chain-key-file: the pointer env var name does not contain JAIPH_CHAIN_KEY", () => {
  // AC: a child reading the leader's exec env must not find `JAIPH_CHAIN_KEY`.
  // The only thing that rides on the leader env is this pointer, so its name
  // must not re-introduce that substring.
  assert.ok(!CHAIN_KEY_FILE_ENV.includes("JAIPH_CHAIN_KEY"), CHAIN_KEY_FILE_ENV);
});

test("chain-key-file: write then read returns the key and removes the file", () => {
  const key = "a".repeat(64);
  const file = writeChainKeyFile(key);
  assert.ok(existsSync(file), "the key file exists after write");
  const read = readChainKeyFile(file);
  assert.equal(read, key, "the exact key is read back");
  assert.ok(!existsSync(file), "the key file is removed on read");
  assert.ok(!existsSync(dirname(file)), "the key file's private dir is removed on read");
});

test("chain-key-file: a missing path yields an empty key (fail-closed, never throws)", () => {
  assert.equal(readChainKeyFile(undefined), "");
  assert.equal(readChainKeyFile("/nonexistent/jaiph-chain/key"), "");
});
