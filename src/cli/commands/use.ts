import { spawnSync } from "node:child_process";
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

export function runUse(rest: string[]): number {
  if (hasHelpFlag(rest)) {
    process.stdout.write(USE_USAGE);
    return 0;
  }
  const version = rest[0];
  if (!version) {
    process.stderr.write("jaiph use requires a version (e.g. 0.9.4) or 'nightly'\n");
    return 1;
  }
  const ref = toInstallRef(version);
  if (!ref) {
    process.stderr.write("jaiph use requires a non-empty version or 'nightly'\n");
    return 1;
  }
  const installCommand = process.env.JAIPH_INSTALL_COMMAND ?? "curl -fsSL https://jaiph.org/install | bash";
  process.stdout.write(`Reinstalling Jaiph from ref '${ref}'...\n`);
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
