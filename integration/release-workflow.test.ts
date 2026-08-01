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
const INSTALLER_PS = readFileSync(join(REPO_ROOT, "docs/install.ps1"), "utf8");
const ENV_VARS = readFileSync(join(REPO_ROOT, "docs/env-vars.md"), "utf8");
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
  assert.match(RELEASE_YML, /public key/, "rejects jaiph.pub pasted as the signing secret");
  assert.match(RELEASE_YML, /encrypted secret key/, "handles -W keys that still use encrypted header");
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
  assert.match(CONTRIBUTING, /rotate/, "documents key rotation");
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

test("Dockerfile pins every toolchain fetch through fetch-verify.sh with a required checksum", () => {
  // Every toolchain checksum ARG must default to a non-empty 64-hex sha256, so a
  // plain `docker build` cannot degrade to an unverified fetch (finding M-11).
  const ARGS = [
    "UV_INSTALL_SHA256",
    "RUSTUP_INIT_SHA256",
    "BUN_INSTALL_SHA256",
    "CURSOR_INSTALL_SHA256",
    "GO_SHA256_AMD64",
    "GO_SHA256_ARM64",
    "YQ_SHA256_AMD64",
    "YQ_SHA256_ARM64",
    "KUBECTL_SHA256_AMD64",
    "KUBECTL_SHA256_ARM64",
    "AWSCLI_SHA256_X86_64",
    "AWSCLI_SHA256_AARCH64",
    "TASK_SHA256_AMD64",
    "TASK_SHA256_ARM64",
  ];
  for (const argName of ARGS) {
    assert.match(
      DOCKERFILE,
      new RegExp(`^ARG ${argName}=[0-9a-f]{64}$`, "m"),
      `ARG ${argName} defaults to a non-empty 64-hex sha256`,
    );
  }

  // No toolchain may be fetched with a bare curl/wget download; each goes
  // through the shared verify seam.
  const stray = DOCKERFILE.split("\n").filter((l) =>
    /^\s*(curl|wget)[^|]*(astral\.sh|rustup|bun\.sh|cursor\.com|go\.dev\/dl|mikefarah\/yq|dl\.k8s\.io|awscli\.amazonaws\.com|go-task\/task)/.test(
      l,
    ),
  );
  assert.deepEqual(stray, [], `unverified toolchain fetch(es) in Dockerfile:\n${stray.join("\n")}`);
  assert.match(DOCKERFILE, /fetch-verify\.sh/, "Dockerfile calls the fetch-verify.sh seam");

  // The seam itself fails closed on an empty checksum and verifies the download.
  const HELPER = readFileSync(join(REPO_ROOT, "runtime/fetch-verify.sh"), "utf8");
  assert.match(HELPER, /checksum is required/, "fetch-verify refuses an empty checksum");
  assert.match(HELPER, /sha256sum|shasum/, "fetch-verify computes a sha256 of the download");
  assert.match(HELPER, /sha256 mismatch/, "fetch-verify aborts on a checksum mismatch");
});

test("Dockerfile pins every base image by digest (no bare mutable tags)", () => {
  // Every FROM must reference an image by @sha256: digest so the built runtime
  // image is reproducible and its registry-sourced layers are attested
  // (finding L-4). A bare `FROM node:22-bookworm-slim` would fail here.
  const fromLines = DOCKERFILE.split("\n").filter((l) => /^FROM\s/.test(l));
  assert.ok(fromLines.length >= 2, "expected at least the builder and runtime FROM stages");
  const unpinned = fromLines.filter((l) => !/@sha256:[0-9a-f]{64}\b/.test(l));
  assert.deepEqual(unpinned, [], `FROM line(s) without an @sha256: digest pin:\n${unpinned.join("\n")}`);
});

test("Dockerfile pins global npm installs to exact versions", () => {
  // The registry-sourced global installs must pin exact versions (finding L-4),
  // declared as bump-in-one-place ARGs.
  for (const argName of ["PNPM_VERSION", "YARN_VERSION", "CLAUDE_CODE_VERSION"]) {
    assert.match(DOCKERFILE, new RegExp(`^ARG ${argName}=\\S+$`, "m"), `ARG ${argName} carries a version default`);
  }

  // A registry package installed with `npm install -g <name>` and no `@version`
  // is a bare, mutable install — the pattern the finding flagged. Local tarball
  // installs (paths like /tmp/jaiph.tgz) are inherently pinned and excluded.
  const bare = DOCKERFILE.split("\n").filter((l) =>
    /npm install -g[^&|]*["\s](pnpm|yarn|@anthropic-ai\/claude-code)(["\s]|$)/.test(l),
  );
  assert.deepEqual(bare, [], `unpinned global npm install(s) in Dockerfile:\n${bare.join("\n")}`);
});

test("bash installer requires SHA256SUMS.minisig and fails closed when absent", () => {
  assert.match(INSTALLER, /SHA256SUMS\.minisig/, "downloads SHA256SUMS.minisig");
  assert.match(INSTALLER, /Failed to download.*SHA256SUMS\.minisig/, "fails with message when sig file is missing");
  // The sig download must come BEFORE the checksum verification step.
  const sigIdx = INSTALLER.indexOf("SHA256SUMS.minisig");
  const csumIdx = INSTALLER.indexOf("Verifying checksum");
  assert.ok(sigIdx !== -1 && csumIdx !== -1 && sigIdx < csumIdx, "sig file download precedes checksum verification");
});

// ── Finding M-5: CI is no longer a checksum-only opt-out ──────────────────────

test("both installers reserve checksum-only for an explicit JAIPH_ALLOW_UNSIGNED opt-in (CI is not an opt-out)", () => {
  // The checksum-only branch must key on JAIPH_ALLOW_UNSIGNED, never on `CI`.
  assert.match(
    INSTALLER,
    /elif \[ "\$\{JAIPH_ALLOW_UNSIGNED:-\}" = "1" \]; then/,
    "bash checksum-only opt-in is JAIPH_ALLOW_UNSIGNED=1",
  );
  assert.match(
    INSTALLER_PS,
    /elseif \(\$env:JAIPH_ALLOW_UNSIGNED -eq "1"\)/,
    "PowerShell checksum-only opt-in is JAIPH_ALLOW_UNSIGNED=1",
  );
  // No CI-based downgrade in the signature gate of either installer.
  const bashGate = INSTALLER.slice(
    INSTALLER.indexOf("if command -v minisign"),
    INSTALLER.indexOf("Verifying checksum"),
  );
  assert.doesNotMatch(bashGate, /\[ -n "\$\{CI:-\}" \]/, "bash: CI is no longer a checksum-only opt-out");
  const psGate = INSTALLER_PS.slice(
    INSTALLER_PS.indexOf("if ($minisignCmd)"),
    INSTALLER_PS.indexOf("Verifying checksum"),
  );
  assert.doesNotMatch(psGate, /\$env:CI/, "PowerShell: CI is no longer a checksum-only opt-out");
});

test("env-vars.md documents JAIPH_ALLOW_UNSIGNED and that CI no longer downgrades to checksum-only (M-5)", () => {
  const row = ENV_VARS.split("\n").find((l) => l.includes("`JAIPH_ALLOW_UNSIGNED`"));
  assert.ok(row, "env-vars.md has a JAIPH_ALLOW_UNSIGNED row");
  assert.match(row!, /CI/, "the row explains the CI behaviour");
  assert.match(row!, /every|no longer/i, "the row states minisign missing aborts even under CI");
});

test("release fails closed instead of publishing unsigned when MINISIGN_SECRET_KEY is unset", () => {
  const signStep = sliceBetween(
    RELEASE_YML,
    "Sign SHA256SUMS with minisign",
    "Sanity gate (linux-x64 --version)",
  );
  assert.match(signStep, /if \[ -z "\$\{MINISIGN_SECRET_KEY\}" \]/, "guards on an unset secret");
  assert.match(signStep, /\n\s*exit 1\n/, "aborts the release job when the secret is unset");
  assert.doesNotMatch(signStep, /skipping detached signature/i, "no silent skip that would publish unsigned");
});
