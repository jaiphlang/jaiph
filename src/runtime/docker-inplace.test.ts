import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInplaceWarning,
  formatUnsafeWarning,
  UNSAFE_RUN_LOGWARN_MESSAGE,
} from "./docker-inplace";

test("formatInplaceWarning: lean scope copy with workspace path", () => {
  const ws = "/Users/me/projects/jaiph";
  const warning = formatInplaceWarning(ws);
  assert.match(warning, /in the in-place mode/);
  assert.match(warning, new RegExp(`edit files directly in ${ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(warning, /no access to other directories/);
  assert.match(warning, /Docker sandbox/);
  assert.doesNotMatch(warning, /uncommitted changes/);
  assert.doesNotMatch(warning, /git/);
});

test("formatUnsafeWarning: single-line lean copy", () => {
  const warning = formatUnsafeWarning();
  assert.match(warning, /unsafe mode with no sandboxing/);
  assert.match(warning, /full access to your machine/);
  assert.doesNotMatch(warning, /uncommitted changes/);
  assert.doesNotMatch(warning, /git/);
});

test("UNSAFE_RUN_LOGWARN_MESSAGE: present-tense runtime warning", () => {
  assert.match(UNSAFE_RUN_LOGWARN_MESSAGE, /You are running/);
  assert.match(UNSAFE_RUN_LOGWARN_MESSAGE, /unsafe mode with no sandboxing/);
});
