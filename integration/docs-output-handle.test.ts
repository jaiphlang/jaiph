import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ADR 0003: docs/language.md is the owner of the Value types contract. The
// output-handle model (call result is a handle; `const` / `if` / `${}` slurp;
// `stdin` streams) must be stated in full on that page, so an agent reading only
// Value types plus the skill page can restate the rule.
const LANGUAGE_PATH = join(process.cwd(), "docs", "language.md");

function valueTypesSection(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^## Value types\s*$/.test(l));
  assert.ok(start !== -1, "docs/language.md is missing a `## Value types` section");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("docs/language.md Value types lists the output handle and the force/keep rules", () => {
  const section = valueTypesSection(readFileSync(LANGUAGE_PATH, "utf8"));
  assert.match(section, /output handle/, "Value types must list the output handle type");
  // The force/keep split an agent needs to state the rule.
  assert.match(section, /\*\*Force/, "Value types must document force sites (slurp → string)");
  assert.match(section, /Keep as an output handle/, "Value types must document keep sites");
  assert.match(section, /const x = <call>\(\)/, "force list must include `const x = <call>()`");
  assert.match(section, /stdin <handle> -> script\(\)|stdin <call>\(\) -> script\(\)/, "keep list must include stdin streaming");
});

test("docs/language.md opening no longer claims every value is a string", () => {
  const source = readFileSync(LANGUAGE_PATH, "utf8");
  assert.doesNotMatch(
    source,
    /Every value in a def is either a `string` or a `script`\./,
    "the opening blurb must acknowledge the output handle, not claim only string/script",
  );
});

test("docs/language.md catch/recover binding is an output handle, not a capture path", () => {
  const source = readFileSync(LANGUAGE_PATH, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("## `catch` and `recover`");
  assert.ok(start !== -1, "missing catch/recover section");
  const next = source.indexOf("\n## ", start + 1);
  const section = source.slice(start, next === -1 ? undefined : next);
  assert.match(section, /output handle/, "the binding must be documented as an output handle");
  assert.doesNotMatch(
    section,
    /receives the \*\*absolute path\*\*/,
    "the binding is no longer a run-dir capture path",
  );
});
