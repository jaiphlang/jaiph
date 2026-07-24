import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInplaceWarning,
  formatUnsafeWarning,
  UNSAFE_RUN_LOGWARN_MESSAGE,
  confirmUnsafeRun,
  _inplacePrompt,
} from "./docker-inplace";
import { _containerIndicator } from "./docker";

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

test("confirmUnsafeRun: inside a container, proceeds without prompting (non-TTY, no auto-confirm)", async () => {
  const origPresent = _containerIndicator.present;
  const origAsk = _inplacePrompt.ask;
  const origWrite = process.stderr.write.bind(process.stderr);
  let asked = false;
  let notice = "";
  try {
    _containerIndicator.present = () => true;
    _inplacePrompt.ask = async () => {
      asked = true;
      return false;
    };
    (process.stderr as any).write = (chunk: string) => {
      notice += chunk;
      return true;
    };
    // No JAIPH_INPLACE_YES, stdin not a TTY: on a host this would throw
    // E_UNSAFE_NO_CONFIRM. Inside a container it must proceed instead.
    const proceed = await confirmUnsafeRun("/work", {}, false);
    assert.equal(proceed, true, "container run must proceed unattended");
    assert.equal(asked, false, "must not open an interactive prompt in a container");
    assert.match(notice, /the container is the sandbox/);
  } finally {
    _containerIndicator.present = origPresent;
    _inplacePrompt.ask = origAsk;
    (process.stderr as any).write = origWrite;
  }
});

test("confirmUnsafeRun: not in a container + non-TTY + no auto-confirm still throws E_UNSAFE_NO_CONFIRM", async () => {
  const origPresent = _containerIndicator.present;
  try {
    _containerIndicator.present = () => false;
    await assert.rejects(
      () => confirmUnsafeRun("/work", {}, false),
      /E_UNSAFE_NO_CONFIRM/,
      "host non-TTY unsafe run without consent must still abort",
    );
  } finally {
    _containerIndicator.present = origPresent;
  }
});
