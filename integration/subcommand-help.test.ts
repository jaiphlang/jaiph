import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI_PATH = join(process.cwd(), "dist/src/cli.js");

const SUBCOMMANDS = ["run", "test", "compile", "format", "init", "install", "use"];

for (const cmd of SUBCOMMANDS) {
  for (const helpFlag of ["--help", "-h"]) {
    test(`jaiph ${cmd} ${helpFlag} prints usage to stdout and exits 0`, () => {
      const result = spawnSync("node", [CLI_PATH, cmd, helpFlag], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("Usage"),
        `stdout should contain "Usage": ${JSON.stringify(result.stdout)}`,
      );
      assert.ok(
        result.stdout.includes(cmd),
        `stdout should contain subcommand "${cmd}": ${JSON.stringify(result.stdout)}`,
      );
    });
  }
}

test("jaiph run --help does not attempt to resolve --help as a file", () => {
  const result = spawnSync("node", [CLI_PATH, "run", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0);
  // Filename resolution would emit ENOENT / "no such file" via the thrown error path.
  assert.ok(!result.stderr.includes("ENOENT"));
  assert.ok(!result.stderr.includes("no such file"));
  assert.ok(!result.stderr.includes("requires a .jh file"));
});
