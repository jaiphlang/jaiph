import { spawnSync } from "node:child_process";

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
  const version = rest[0];
  if (!version) {
    process.stderr.write("jaiph use requires a version (e.g. 0.9.2) or 'nightly'\n");
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
