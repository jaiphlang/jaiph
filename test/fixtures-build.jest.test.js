const { mkdirSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const { join, relative } = require("node:path");
const { build } = require("../dist/src/transpiler");

function listSnapshotShFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".sh")) {
        files.push(relative(rootDir, full).replaceAll("\\", "/"));
      }
    }
  }
  files.sort();
  return files;
}

describe("fixture build snapshots", () => {
  const fixturesDir = join(process.cwd(), "test/fixtures");
  const targetDir = join(process.cwd(), ".tmp/jest-build-fixtures");

  afterAll(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("build output matches snapshot", () => {
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });

    const buildResults = build(fixturesDir, targetDir);
    expect(buildResults.length).toBeGreaterThan(0);

    const actualFiles = listSnapshotShFiles(targetDir);
    const outputByFile = {};

    for (const relPath of actualFiles) {
      outputByFile[relPath] = readFileSync(join(targetDir, relPath), "utf8");
    }

    expect({ files: actualFiles, outputByFile }).toMatchSnapshot();
  });
});
