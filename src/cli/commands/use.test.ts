import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Verified default path (finding M-11): with no JAIPH_INSTALL_COMMAND override,
 * `jaiph use` downloads the install script and its published sha256 from
 * JAIPH_SITE, verifies the two match, and only then executes the script. A
 * local file:// "site" keeps these tests network-free.
 */
function makeSite(scriptBody: string, opts?: { tamper?: boolean; noSha?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-use-site-"));
  const scriptPath = join(dir, "install");
  writeFileSync(scriptPath, scriptBody);
  chmodSync(scriptPath, 0o755);
  const sha = createHash("sha256").update(scriptBody).digest("hex");
  if (!opts?.noSha) {
    writeFileSync(join(dir, "install.sha256"), `${sha}  install\n`);
  }
  if (opts?.tamper) {
    // Publish the checksum, then change the script so it no longer matches.
    writeFileSync(scriptPath, `${scriptBody}\necho tampered\n`);
    chmodSync(scriptPath, 0o755);
  }
  return dir;
}

function withVerifiedInstallEnv(site: string, fn: () => void): void {
  const prevCmd = process.env.JAIPH_INSTALL_COMMAND;
  const prevSite = process.env.JAIPH_SITE;
  delete process.env.JAIPH_INSTALL_COMMAND; // force the verified default path
  process.env.JAIPH_SITE = `file://${site}`;
  try {
    fn();
  } finally {
    if (prevCmd === undefined) delete process.env.JAIPH_INSTALL_COMMAND;
    else process.env.JAIPH_INSTALL_COMMAND = prevCmd;
    if (prevSite === undefined) delete process.env.JAIPH_SITE;
    else process.env.JAIPH_SITE = prevSite;
  }
}

test("runUse: verified default path accepts a matching install script", () => {
  const site = makeSite("#!/usr/bin/env bash\nexit 0\n");
  const cap = captureStreams();
  withVerifiedInstallEnv(site, () => {
    try {
      assert.equal(runUse(["nightly"]), 0);
      assert.match(cap.stdout(), /Install script verified/);
    } finally {
      cap.restore();
    }
  });
});

test("runUse: verified default path rejects a tampered install script", () => {
  const site = makeSite("#!/usr/bin/env bash\nexit 0\n", { tamper: true });
  const cap = captureStreams();
  withVerifiedInstallEnv(site, () => {
    try {
      assert.equal(runUse(["nightly"]), 1);
      assert.match(cap.stderr(), /integrity check failed/);
    } finally {
      cap.restore();
    }
  });
});

test("runUse: verified default path fails closed when install.sha256 is missing", () => {
  const site = makeSite("#!/usr/bin/env bash\nexit 0\n", { noSha: true });
  const cap = captureStreams();
  withVerifiedInstallEnv(site, () => {
    try {
      assert.equal(runUse(["nightly"]), 1);
      assert.match(cap.stderr(), /unverified install script/);
    } finally {
      cap.restore();
    }
  });
});
