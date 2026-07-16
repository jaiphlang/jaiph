import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Acceptance for "Distro: PowerShell installer at jaiph.org/install.ps1".
//
// The Pester-equivalent runtime behaviour (happy path / checksum mismatch /
// unsupported arch) is exercised on windows-latest by
// e2e/tests/installer_powershell.ps1. These host-portable guards cover the
// contract that must hold everywhere and fail when it is violated:
//   1. docs/install.ps1 exists and implements the download → verify → install
//      contract with the documented overrides and unsupported-arch message.
//   2. The bash installer keeps rejecting Windows and points at the PowerShell
//      one; both installers pin the same release ref (prepare_release keeps
//      them in lockstep).
//   3. docs/setup.md and the main page reference the PowerShell one-liner
//      (docs parity).

const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const PS_INSTALLER = read("docs/install.ps1");
const BASH_INSTALLER = read("docs/install");
const SETUP = read("docs/setup.md");
const INDEX = read("docs/index.html");
const PREPARE_RELEASE = read(".jaiph/prepare_release.jh");

const ONE_LINER = "irm https://jaiph.org/install.ps1 | iex";

// ── Acceptance 1: install.ps1 implements the contract ─────────────────────────

test("docs/install.ps1 exists", () => {
  assert.ok(existsSync(join(REPO_ROOT, "docs/install.ps1")), "docs/install.ps1 present");
});

test("install.ps1 downloads the windows-x64 asset and SHA256SUMS", () => {
  assert.match(PS_INSTALLER, /jaiph-windows-x64\.exe/, "downloads the .exe asset");
  assert.match(PS_INSTALLER, /SHA256SUMS/, "downloads SHA256SUMS");
});

test("install.ps1 verifies the checksum with Get-FileHash and aborts on mismatch", () => {
  assert.match(PS_INSTALLER, /Get-FileHash\s+-Algorithm\s+SHA256/, "hashes with Get-FileHash SHA256");
  assert.match(PS_INSTALLER, /Checksum mismatch/, "reports a checksum mismatch");
  // The install copy must come after the verify (nothing installed on mismatch):
  // the mismatch branch exits before the "Installing binary" step.
  const mismatchIdx = PS_INSTALLER.indexOf("Checksum mismatch");
  const installIdx = PS_INSTALLER.indexOf("Installing binary to");
  assert.ok(mismatchIdx !== -1 && installIdx !== -1 && mismatchIdx < installIdx, "verify precedes install");
});

test("install.ps1 installs to %LOCALAPPDATA%\\jaiph\\bin\\jaiph.exe, overridable via JAIPH_BIN_DIR", () => {
  assert.match(PS_INSTALLER, /LOCALAPPDATA/, "defaults under LOCALAPPDATA");
  assert.match(PS_INSTALLER, /jaiph\\bin/, "installs into jaiph\\bin");
  assert.match(PS_INSTALLER, /jaiph\.exe/, "target is jaiph.exe");
  assert.match(PS_INSTALLER, /env:JAIPH_BIN_DIR/, "JAIPH_BIN_DIR override honoured");
});

test("install.ps1 supports JAIPH_REPO_REF / first-arg override and a base-url override", () => {
  assert.match(PS_INSTALLER, /param\(\[string\]\$RepoRef\)/, "accepts a ref as the first argument");
  assert.match(PS_INSTALLER, /env:JAIPH_REPO_REF/, "JAIPH_REPO_REF override honoured");
  assert.match(PS_INSTALLER, /env:JAIPH_RELEASE_BASE_URL/, "release base URL is overridable (for tests)");
});

test("install.ps1 adds the install dir to the user PATH and prints the try-it hints", () => {
  assert.match(PS_INSTALLER, /SetEnvironmentVariable\("Path",\s*\$newPath,\s*"User"\)/, "updates the user PATH");
  assert.match(PS_INSTALLER, /jaiph --version/, "prints try-it hint: --version");
  assert.match(PS_INSTALLER, /jaiph --help/, "prints try-it hint: --help");
});

test("install.ps1 rejects non-x64 Windows with a documented unsupported message", () => {
  assert.match(PS_INSTALLER, /PROCESSOR_ARCHITECTURE/, "detects the arch");
  assert.match(PS_INSTALLER, /Unsupported platform: windows/, "documented unsupported-platform message");
  assert.match(PS_INSTALLER, /contributing#installing-from-source/, "points at the from-source instructions");
  // x64 is accepted; there is no windows-arm64 asset to install.
  assert.match(PS_INSTALLER, /"AMD64"|"X64"/, "x64 is the supported arch");
});

// ── Acceptance 2: bash installer rejects Windows and refs stay in lockstep ────

test("bash installer rejects Windows and points at the PowerShell installer", () => {
  assert.match(BASH_INSTALLER, /MINGW\*\|MSYS\*\|CYGWIN\*\|Windows_NT/, "detects Windows-like uname");
  assert.match(BASH_INSTALLER, /irm https:\/\/jaiph\.org\/install\.ps1 \| iex/, "points at the PowerShell one-liner");
  // The generic unsupported message (AIX etc.) is preserved for the e2e test.
  assert.match(BASH_INSTALLER, /Unsupported platform: \$\{uname_s\} \$\{uname_m\}/);
});

test("bash installer verifies the staging binary and replaces the target atomically", () => {
  assert.match(BASH_INSTALLER, /install_jaiph_binary/, "uses atomic install helper");
  assert.match(BASH_INSTALLER, /assert_safe_install_target/, "validates install paths before rm");
  assert.match(BASH_INSTALLER, /assert_install_paths/, "validates JAIPH_BIN_DIR before build");
  assert.match(BASH_INSTALLER, /Refusing to install into system directory/, "blocks system bin dirs");
  assert.match(BASH_INSTALLER, /Refusing to replace directory/, "blocks replacing a directory target");
  assert.match(BASH_INSTALLER, /rm -f "\$\{TARGET\}"/, "removes the old install path before mv");
  assert.match(BASH_INSTALLER, /Binary verification failed/, "hard-fails when staging --version fails");
  assert.doesNotMatch(BASH_INSTALLER, /2>\/dev\/null \|\| echo "jaiph \(local\)"/, "does not swallow --version failure");
});

test("both installers pin the same release ref", () => {
  const bashRef = BASH_INSTALLER.match(/JAIPH_REPO_REF:-(v\d+\.\d+\.\d+)/);
  const psRef = PS_INSTALLER.match(/else\s*\{\s*"(v\d+\.\d+\.\d+)"\s*\}/);
  assert.ok(bashRef, "bash installer pins a vX.Y.Z ref");
  assert.ok(psRef, "PowerShell installer pins a vX.Y.Z ref");
  assert.equal(psRef![1], bashRef![1], "PowerShell ref matches the bash ref");
});

test("prepare_release refreshes both installers' pinned ref in lockstep", () => {
  // The release-prep workflow must rewrite the ref in both files, or the
  // PowerShell installer would drift to a stale release on the next bump.
  assert.match(PREPARE_RELEASE, /"docs\/install",\s*"docs\/install\.ps1"/, "ref refresh covers both files");
});

// ── Acceptance 3: docs reference the PowerShell one-liner ─────────────────────

test("docs/setup.md references the PowerShell one-liner and Windows install path", () => {
  assert.ok(SETUP.includes(ONE_LINER), "setup.md includes the irm | iex one-liner");
  assert.match(SETUP, /%LOCALAPPDATA%\\jaiph\\bin/, "setup.md documents the Windows install path");
});

test("the main page references the PowerShell one-liner", () => {
  assert.ok(INDEX.includes(ONE_LINER), "index.html includes the irm | iex one-liner");
});
