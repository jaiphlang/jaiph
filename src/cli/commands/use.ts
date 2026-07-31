import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasHelpFlag } from "../shared/usage";

const USE_USAGE =
  "Usage: jaiph use <version|nightly>\n\n" +
  "Reinstall the jaiph CLI at a specific version tag, or 'nightly'.\n\n" +
  "  -h, --help      show this help\n\n" +
  "Example:\n" +
  "  jaiph use nightly\n";

function toInstallRef(version: string): string | undefined {
  const trimmed = version.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "nightly") {
    return "nightly";
  }
  return `v${trimmed}`;
}

// Default bootstrap: fetch the install script AND its published sha256, verify,
// then run it — instead of piping `curl … | bash` (finding M-11). A missing or
// mismatched checksum fails closed, so a tampered bootstrap script is rejected.
// JAIPH_SITE overrides the base URL (default https://jaiph.org), matching docs/run.
function runVerifiedInstall(ref: string): number {
  const site = (process.env.JAIPH_SITE ?? "").trim() || "https://jaiph.org";
  const tmp = mkdtempSync(join(tmpdir(), "jaiph-use-"));
  const scriptPath = join(tmp, "install");
  const sumPath = join(tmp, "install.sha256");
  try {
    const dl = (url: string, out: string): boolean =>
      spawnSync("curl", ["-fsSL", url, "-o", out], { stdio: ["ignore", "ignore", "inherit"] }).status === 0;
    if (!dl(`${site}/install`, scriptPath)) {
      process.stderr.write(`Failed to download ${site}/install\n`);
      return 1;
    }
    if (!dl(`${site}/install.sha256`, sumPath)) {
      process.stderr.write(
        `Failed to download ${site}/install.sha256 — refusing to run an unverified install script.\n`,
      );
      return 1;
    }
    const expected = readFileSync(sumPath, "utf8").trim().split(/\s+/)[0] ?? "";
    const actual = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
    if (!expected || expected !== actual) {
      process.stderr.write(
        `Install script integrity check failed (expected ${expected || "<none>"}, got ${actual}).\n` +
          "The bootstrap script does not match its published checksum; aborting.\n",
      );
      return 1;
    }
    process.stdout.write("Install script verified\n");
    const result = spawnSync("bash", [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, JAIPH_REPO_REF: ref },
    });
    if (typeof result.status === "number") {
      return result.status;
    }
    if (result.error) {
      process.stderr.write(`${result.error.message}\n`);
    }
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runUse(rest: string[]): number {
  if (hasHelpFlag(rest)) {
    process.stdout.write(USE_USAGE);
    return 0;
  }
  const version = rest[0];
  if (!version) {
    process.stderr.write("jaiph use requires a version (e.g. X.Y.Z) or 'nightly'\n");
    return 1;
  }
  const ref = toInstallRef(version);
  if (!ref) {
    process.stderr.write("jaiph use requires a non-empty version or 'nightly'\n");
    return 1;
  }
  process.stdout.write(`Reinstalling Jaiph from ref '${ref}'...\n`);

  // An explicit JAIPH_INSTALL_COMMAND is an operator override (forks, offline
  // bundles, local scripts) and runs as-is. The default path verifies the
  // fetched install script before executing it.
  const installCommand = process.env.JAIPH_INSTALL_COMMAND;
  if (!installCommand) {
    return runVerifiedInstall(ref);
  }
  const result = spawnSync("bash", ["-c", installCommand], {
    stdio: "inherit",
    env: { ...process.env, JAIPH_REPO_REF: ref },
  });
  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  return 1;
}
