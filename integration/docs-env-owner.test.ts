import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ADR 0003 (design/0003-docs-one-fact-one-owner.md): the `--env` / sterile-
// script / `use`-grant rule has one owner, docs/env-vars.md (#script-env plus
// the reserved-key paragraph). Every other page keeps at most a sentence and a
// link. These guards fail when a page grows the essay back or drops the link,
// so a future grant-rule change is a one-file edit, not an eight-file sweep.

const DOCS_DIR = join(process.cwd(), "docs");

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

test("cli.md --env cell is a short pointer (≤400 chars) that links to env-vars.md", () => {
  const lines = readPage("cli.md").split("\n");
  // The `jaiph run` flags table row is the first line that begins with
  // "| `--env`" (the `jaiph mcp` / `jaiph serve` rows just say "same as run").
  const row = lines.find((l) => l.startsWith("| `--env`"));
  assert.ok(row, "cli.md must have a `--env` table row");
  assert.ok(
    row!.length <= 400,
    `cli.md --env row must be at most 400 characters (was ${row!.length}); it must point at env-vars.md#script-env instead of restating the grant essay`,
  );
  assert.match(
    row!,
    /env-vars\.md/,
    "cli.md --env row must link to env-vars.md",
  );
});

test("why-jaiph.md, language.md, and testing.md link to env-vars.md and do not restate the grant hand-off", () => {
  for (const page of ["why-jaiph.md", "language.md", "testing.md"]) {
    const body = readPage(page);
    assert.match(
      body,
      /\]\([^)]*env-vars\.md[^)]*\)/,
      `${page} must contain a markdown link to env-vars.md`,
    );
    assert.doesNotMatch(
      body,
      /JAIPH_ENV_GRANT_FILE/,
      `${page} must not restate the private grant hand-off (JAIPH_ENV_GRANT_FILE) — that belongs on env-vars.md`,
    );
  }
});

test("env-vars.md still owns the script-env contract and the reserved-key list", () => {
  const body = readPage("env-vars.md");
  assert.match(
    body,
    /\{:\s*#script-env\s*\}|Scripts are \*\*sterile by default\*\*/,
    "env-vars.md must keep the script-env contract (#script-env anchor or the sterile-script paragraph)",
  );
  assert.match(
    body,
    /JAIPH_ENV_GRANT_FILE/,
    "env-vars.md must keep the reserved-key list including JAIPH_ENV_GRANT_FILE",
  );
});
