#!/usr/bin/env node
// Run tests and write output to test-output.txt so we can inspect failures.
const { spawnSync } = require("child_process");
const { writeFileSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const result = spawnSync("npm", ["test"], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
  timeout: 120000,
});

const out = [
  "STDOUT:",
  result.stdout || "",
  "",
  "STDERR:",
  result.stderr || "",
  "",
  "status: " + result.status,
  "signal: " + result.signal,
].join("\n");

writeFileSync(join(root, "test-output.txt"), out);
console.log("Wrote test-output.txt");
console.log("status:", result.status);
