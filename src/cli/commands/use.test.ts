import test from "node:test";
import assert from "node:assert/strict";
import { runUse } from "./use";

/**
 * `jaiph use` shells out to a network installer on the happy path, so these
 * tests exercise the arg-guard branches (which return before any spawn) and
 * the spawn-status passthrough via a harmless `JAIPH_INSTALL_COMMAND` override
 * — no network access.
 */
function captureStreams(): { restore: () => void; stderr: () => string; stdout: () => string } {
  let err = "";
  let out = "";
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    },
    stderr: () => err,
    stdout: () => out,
  };
}

test("runUse: missing version returns 1 with guidance", () => {
  const cap = captureStreams();
  try {
    assert.equal(runUse([]), 1);
    assert.match(cap.stderr(), /requires a version/);
  } finally {
    cap.restore();
  }
});

test("runUse: whitespace-only version is rejected as empty", () => {
  const cap = captureStreams();
  try {
    assert.equal(runUse(["   "]), 1);
    assert.match(cap.stderr(), /non-empty version/);
  } finally {
    cap.restore();
  }
});

test("runUse: --help prints usage and returns 0", () => {
  const cap = captureStreams();
  try {
    assert.equal(runUse(["--help"]), 0);
    assert.match(cap.stdout(), /Usage: jaiph use/);
  } finally {
    cap.restore();
  }
});

test("runUse: propagates the install command exit status (nightly)", () => {
  const prev = process.env.JAIPH_INSTALL_COMMAND;
  process.env.JAIPH_INSTALL_COMMAND = "exit 0";
  const cap = captureStreams();
  try {
    assert.equal(runUse(["nightly"]), 0);
    assert.match(cap.stdout(), /Reinstalling Jaiph from ref 'nightly'/);
  } finally {
    cap.restore();
    if (prev === undefined) delete process.env.JAIPH_INSTALL_COMMAND;
    else process.env.JAIPH_INSTALL_COMMAND = prev;
  }
});

test("runUse: non-zero install status is returned to the caller", () => {
  const prev = process.env.JAIPH_INSTALL_COMMAND;
  process.env.JAIPH_INSTALL_COMMAND = "exit 7";
  const cap = captureStreams();
  try {
    assert.equal(runUse(["1.2.3"]), 7);
    // a bare X.Y.Z version is normalized to a v-prefixed ref
    assert.match(cap.stdout(), /Reinstalling Jaiph from ref 'v1\.2\.3'/);
  } finally {
    cap.restore();
    if (prev === undefined) delete process.env.JAIPH_INSTALL_COMMAND;
    else process.env.JAIPH_INSTALL_COMMAND = prev;
  }
});
