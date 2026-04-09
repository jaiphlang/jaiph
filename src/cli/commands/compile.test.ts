import test from "node:test";
import assert from "node:assert/strict";
import { jaiphError } from "../../errors";
import { diagnosticFromThrown } from "./compile";

test("diagnosticFromThrown parses jaiphError message", () => {
  const err = jaiphError("/path/to/a.jh", 3, 5, "E_VALIDATE", "bad ref");
  const d = diagnosticFromThrown(err);
  assert.ok(d);
  assert.equal(d!.file, "/path/to/a.jh");
  assert.equal(d!.line, 3);
  assert.equal(d!.col, 5);
  assert.equal(d!.code, "E_VALIDATE");
  assert.equal(d!.message, "bad ref");
});

test("diagnosticFromThrown returns null for unrelated errors", () => {
  assert.equal(diagnosticFromThrown(new Error("plain")), null);
  assert.equal(diagnosticFromThrown(null), null);
});
