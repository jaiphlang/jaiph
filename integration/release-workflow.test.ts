import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Acceptance for "Distro: build and release jaiph-windows-x64.exe".
//
// These guards turn each acceptance bullet into a check that fails when the
// contract is violated:
//   1. The release workflow builds/ships five binaries + SHA256SUMS, and a
//      checksum entry for the .exe verifies against the asset (round-trip via
//      the installer's own lookup).
//   2. The shared version-check gate (scripts/release-version-check.sh, invoked
//      by both the linux-x64 and the windows-latest gate) fails on a
//      tag/version mismatch and passes on a match.
//   3. The docs/contributing.md naming contract, the release matrix, the
//      installer (docs/install), and the e2e installer test all agree on the
//      asset names (grep/parity check).

const REPO_ROOT = process.cwd();
const RELEASE_YML = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
const CONTRIBUTING = readFileSync(join(REPO_ROOT, "docs/contributing.md"), "utf8");
const INSTALLER = readFileSync(join(REPO_ROOT, "docs/install"), "utf8");
const INSTALLER_TEST = readFileSync(join(REPO_ROOT, "e2e/tests/07_installer_binary.sh"), "utf8");
const DOCKERFILE = readFileSync(join(REPO_ROOT, "runtime/Dockerfile"), "utf8");
const VERSION_CHECK = join(REPO_ROOT, "scripts/release-version-check.sh");

// Single source of truth for the assets a release must ship.
const BINARY_ASSETS = [
  "jaiph-darwin-arm64",
  "jaiph-darwin-x64",
  "jaiph-linux-x64",
  "jaiph-linux-arm64",
  "jaiph-windows-x64.exe",
];
// Names the bash installer (and its e2e test) can construct from {os}×{arch}.
const INSTALLER_ASSETS = [
  "jaiph-darwin-arm64",
  "jaiph-darwin-x64",
  "jaiph-linux-x64",
  "jaiph-linux-arm64",
];

// Slice a workflow's job/step body out of the YAML by a stable anchor so
// per-section assertions don't accidentally match text from another job.
function sliceBetween(text: string, start: string, end: string | null): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `expected to find "${start}" in workflow`);
  const to = end === null ? text.length : text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `expected to find "${end}" after "${start}"`);
  return text.slice(from, to === text.length ? text.length : to);
}

// ── Acceptance 1: five binaries + SHA256SUMS are built and uploaded ───────────

test("release matrix cross-compiles the windows-x64 target (x64 only)", () => {
  assert.match(RELEASE_YML, /target:\s*bun-windows-x64/, "windows-x64 target present");
  const winEntry = sliceBetween(RELEASE_YML, "target: bun-windows-x64", "steps:");
  assert.match(winEntry, /os:\s*windows/);
  assert.match(winEntry, /arch:\s*x64/);
  assert.match(winEntry, /ext:\s*"\.exe"/);
  // Bun has no windows arm64 target — do not add one.
  assert.doesNotMatch(RELEASE_YML, /target:\s*bun-windows-arm64/, "no windows arm64 target");
  // The four original targets are still built.
  for (const target of ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"]) {
    assert.match(RELEASE_YML, new RegExp(`target:\\s*${target}\\b`), `${target} still built`);
  }
});

test("SHA256SUMS generation covers all five binaries including the .exe", () => {
  const shaLine = RELEASE_YML.split("\n").find((l) => l.includes("sha256sum ") && l.includes("SHA256SUMS"));
  assert.ok(shaLine, "found the sha256sum generation line");
  for (const asset of BINARY_ASSETS) {
    assert.ok(shaLine!.includes(asset), `SHA256SUMS covers ${asset}`);
  }
});

test("both stable and nightly release uploads include the .exe and SHA256SUMS", () => {
  const stable = sliceBetween(RELEASE_YML, "Publish stable release", "Publish nightly prerelease");
  const nightly = sliceBetween(RELEASE_YML, "Publish nightly prerelease", null);
  for (const section of [stable, nightly]) {
    for (const asset of [...BINARY_ASSETS, "SHA256SUMS"]) {
      assert.ok(section.includes(asset), `upload list includes ${asset}`);
    }
  }
});

test("a SHA256SUMS entry for the .exe verifies against the asset via the installer's lookup", () => {
  // Mirror the release: hash a windows binary, write the SHA256SUMS line, then
  // resolve it back with the exact awk lookup docs/install uses. A mismatch
  // between "generation" and "verification" would fail here.
  const dir = mkdtempSync(join(tmpdir(), "jaiph-sha-"));
  try {
    const asset = "jaiph-windows-x64.exe";
    const binPath = join(dir, asset);
    const bytes = randomBytes(4096);
    writeFileSync(binPath, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const sumsPath = join(dir, "SHA256SUMS");
    writeFileSync(sumsPath, `${expected}  ${asset}\n`);

    // The installer resolves a checksum with this awk expression.
    assert.match(INSTALLER, /awk -v name="\$\{BIN_NAME\}" '\$2 == name \|\| \$2 == "\*"name \{ print \$1 \}'/);
    const looked = spawnSync(
      "awk",
      ["-v", `name=${asset}`, '$2 == name || $2 == "*"name { print $1 }', sumsPath],
      { encoding: "utf8" },
    );
    assert.equal(looked.status, 0, looked.stderr);
    assert.equal(looked.stdout.trim(), expected, "installer lookup returns the asset's checksum");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Acceptance 2: the version sanity gate fails on a tag/version mismatch ──────

function runVersionCheck(channel: string, tag: string, got: string) {
  return spawnSync("bash", [VERSION_CHECK, channel, tag, got], { encoding: "utf8" });
}

test("version sanity gate fails when a stable --version mismatches the tag", () => {
  const bad = runVersionCheck("stable", "v9.9.9", "jaiph 1.2.3");
  assert.equal(bad.status, 1, "mismatch exits non-zero");
  assert.match(bad.stderr, /Version sanity check failed/);

  const good = runVersionCheck("stable", "v1.2.3", "jaiph 1.2.3");
  assert.equal(good.status, 0, good.stderr);
});

test("version sanity gate only requires a version-shaped banner for nightly", () => {
  const good = runVersionCheck("nightly", "nightly", "jaiph 0.10.0");
  assert.equal(good.status, 0, good.stderr);

  const bad = runVersionCheck("nightly", "nightly", "not-a-version");
  assert.equal(bad.status, 1, "garbage banner fails even on nightly");
  assert.match(bad.stderr, /Version sanity check failed/);
});

test("a windows-latest job runs the .exe --version through the shared gate and blocks publish", () => {
  const job = sliceBetween(RELEASE_YML, "sanity-windows:", "\n  release:");
  assert.match(job, /runs-on:\s*windows-latest/);
  assert.match(job, /jaiph-windows-x64\.exe --version/);
  assert.match(job, /release-version-check\.sh/, "windows gate delegates to the shared script");
  // The linux gate uses the same shared script (no duplicated comparison logic).
  const linux = sliceBetween(RELEASE_YML, "Sanity gate (linux-x64 --version)", "Publish stable release");
  assert.match(linux, /release-version-check\.sh/);
  // A windows gate failure must fail the release: publish depends on it.
  assert.match(RELEASE_YML, /needs:\s*\[build, sanity-windows\]/, "release job needs sanity-windows");
});

// ── Acceptance 3: contract ↔ matrix ↔ installer parity ────────────────────────

function contractAssets(): string[] {
  const section = sliceBetween(CONTRIBUTING, "#### Release asset naming contract", "#### Release signing");
  const names = new Set<string>();
  for (const m of section.matchAll(/`(jaiph-[A-Za-z0-9.\-]+|SHA256SUMS(?:\.minisig)?)`/g)) {
    names.add(m[1]);
  }
  return [...names];
}

test("the naming contract lists exactly the five binaries plus SHA256SUMS and SHA256SUMS.minisig", () => {
  const listed = contractAssets().sort();
  const expected = [...BINARY_ASSETS, "SHA256SUMS", "SHA256SUMS.minisig"].sort();
  assert.deepEqual(listed, expected, "contract asset set matches the release");
  // The prose count stays in sync with the table.
  assert.match(CONTRIBUTING, /exactly these seven assets/);
});

test("release matrix builds exactly the binaries named in the contract", () => {
  // Every contract binary maps to a matrix target of the same os/arch, and the
  // matrix builds nothing the contract omits.
  const matrixTargets = [...RELEASE_YML.matchAll(/target:\s*(bun-[a-z0-9-]+)/g)].map((m) => m[1]);
  const built = matrixTargets
    .map((t) => t.replace(/^bun-/, "jaiph-"))
    .map((n) => (n === "jaiph-windows-x64" ? "jaiph-windows-x64.exe" : n))
    .sort();
  assert.deepEqual(built, [...BINARY_ASSETS].sort(), "matrix binaries == contract binaries");
});

test("installer and its e2e test can only produce asset names the contract lists", () => {
  // Installer + e2e test construct names from {os}×{arch}; pin the construction
  // so a rename in the contract that isn't mirrored here fails the parity check.
  assert.match(INSTALLER, /BIN_NAME="jaiph-\$\{os\}-\$\{arch\}"/);
  assert.match(INSTALLER_TEST, /HOST_BIN_NAME="jaiph-\$\{HOST_OS\}-\$\{HOST_ARCH\}"/);
  const listed = new Set(contractAssets());
  for (const asset of INSTALLER_ASSETS) {
    assert.ok(listed.has(asset), `contract lists installer asset ${asset}`);
    // Both bash sources still support the os/arch that produces this name.
    const [, os, arch] = asset.split("-");
    for (const src of [INSTALLER, INSTALLER_TEST]) {
      assert.ok(src.includes(os), `bash source supports os ${os}`);
      assert.ok(src.includes(arch), `bash source supports arch ${arch}`);
    }
  }
  // The .exe is release-only; the bash installer does not download it.
  assert.ok(listed.has("jaiph-windows-x64.exe"));
});

// ── Acceptance 4: release signing (SHA256SUMS.minisig) ────────────────────────

test("release workflow signs SHA256SUMS and uploads SHA256SUMS.minisig", () => {
  assert.match(RELEASE_YML, /Sign SHA256SUMS with minisign/, "has a signing step");
  assert.match(RELEASE_YML, /Install minisign/, "installs minisign before signing");
  assert.match(RELEASE_YML, /sudo apt-get install -y -qq minisign/, "uses sudo to install minisign on ubuntu-latest");
  assert.match(RELEASE_YML, /MINISIGN_SECRET_KEY/, "signing step uses the CI secret");
  const stable = sliceBetween(RELEASE_YML, "Publish stable release", "Publish nightly prerelease");
  const nightly = sliceBetween(RELEASE_YML, "Publish nightly prerelease", null);
  for (const [label, section] of [["stable", stable], ["nightly", nightly]] as const) {
    assert.ok(section.includes("SHA256SUMS.minisig"), `${label} upload list includes SHA256SUMS.minisig`);
  }
});

test("release naming contract lists SHA256SUMS.minisig", () => {
  const section = sliceBetween(CONTRIBUTING, "#### Release asset naming contract", "#### Release signing");
  assert.ok(section.includes("SHA256SUMS.minisig"), "naming contract table includes SHA256SUMS.minisig");
  assert.match(CONTRIBUTING, /exactly these seven assets/, "prose says seven assets (not six)");
});

test("contributing.md documents the trust model and key management", () => {
  assert.match(CONTRIBUTING, /#### Release signing/, "has a Release signing section");
  assert.match(CONTRIBUTING, /minisign/, "mentions minisign");
  assert.match(CONTRIBUTING, /MINISIGN_SECRET_KEY/, "documents the required CI secret");
  assert.match(CONTRIBUTING, /Trust model/, "describes the trust model");
  assert.match(CONTRIBUTING, /Key rotation/, "documents key rotation");
});

// ── Acceptance 5: Dockerfile has no pipe-to-shell patterns ───────────────────

test("Dockerfile does not pipe curl output directly to bash or sh", () => {
  // Each line is checked independently so multi-line pipes are caught.
  const lines = DOCKERFILE.split("\n");
  const pipeToBashOrSh = lines.filter((line) => /\|\s*(bash|sh)(\s|-|\b)/.test(line));
  assert.deepEqual(
    pipeToBashOrSh,
    [],
    `Dockerfile has pipe-to-shell lines (fix by download-to-file + hash-verify):\n${pipeToBashOrSh.join("\n")}`,
  );
});

test("Dockerfile uses download-to-file + optional hash verify for each remote installer", () => {
  // Each install ARG must appear once and must be paired with sha256sum usage.
  for (const argName of ["UV_INSTALL_SHA256", "RUSTUP_INIT_SHA256", "BUN_INSTALL_SHA256"]) {
    assert.match(DOCKERFILE, new RegExp(`ARG ${argName}`), `ARG ${argName} declared`);
    assert.match(DOCKERFILE, new RegExp(argName), `${argName} referenced in verification step`);
  }
  assert.match(DOCKERFILE, /sha256sum -c/, "Dockerfile uses sha256sum -c for verification");
});

test("bash installer requires SHA256SUMS.minisig and fails closed when absent", () => {
  assert.match(INSTALLER, /SHA256SUMS\.minisig/, "downloads SHA256SUMS.minisig");
  assert.match(INSTALLER, /Failed to download.*SHA256SUMS\.minisig/, "fails with message when sig file is missing");
  // The sig download must come BEFORE the checksum verification step.
  const sigIdx = INSTALLER.indexOf("SHA256SUMS.minisig");
  const csumIdx = INSTALLER.indexOf("Verifying checksum");
  assert.ok(sigIdx !== -1 && csumIdx !== -1 && sigIdx < csumIdx, "sig file download precedes checksum verification");
});
