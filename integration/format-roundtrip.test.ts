import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitModule } from "../src/format";
import { parsejaiphWithTrivia } from "../src/parser";

// Formatter property test over every Jaiph source in the repo. For each source
// that parses, `jaiph format` must (1) produce output that parses, (2) be
// idempotent, and (3) not change the program: the re-parsed AST equals the
// original AST, ignoring only source positions. This catches the formatter
// guessing a source form from the AST (re-escaping strings, rewriting quoted
// values to bare ones) and dropping nodes (catch / recover on inline scripts).
//
// Sources: tracked *.jh files, compiler-txtar valid inputs, e2e heredocs
// (`e2e::file "x.jh" <<'EOF'`), and ```jaiph / ```jh blocks in docs. Snippets
// that do not parse on their own (error examples, fragments) are skipped.

const REPO_ROOT = process.cwd();

function gitFiles(...patterns: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...patterns], { cwd: REPO_ROOT }).toString().trim();
  return out ? out.split("\n") : [];
}

function collectSources(): Array<[string, string]> {
  const sources: Array<[string, string]> = [];
  const read = (f: string): string => readFileSync(join(REPO_ROOT, f), "utf8");

  for (const f of gitFiles("*.jh")) sources.push([f, read(f)]);

  const txtar = read("test-fixtures/compiler-txtar/valid.txt");
  for (const block of txtar.split(/^=== /m).slice(1)) {
    const name = block.split("\n")[0];
    for (const fileBlock of block.split(/^--- /m).slice(1)) {
      const fileName = fileBlock.split("\n")[0].trim();
      if (fileName.endsWith(".jh")) {
        sources.push([`valid.txt: ${name}: ${fileName}`, fileBlock.slice(fileBlock.indexOf("\n") + 1)]);
      }
    }
  }

  const heredoc = /e2e::file\s+"([^"]+\.jh)"\s+<<'?(\w+)'?\n([\s\S]*?)\n\2\n/g;
  for (const f of gitFiles("e2e/tests/*.sh")) {
    for (const m of read(f).matchAll(heredoc)) sources.push([`${f}: ${m[1]}`, `${m[3]}\n`]);
  }

  const fenced = /```(?:jaiph|jh)\n([\s\S]*?)```/g;
  for (const f of gitFiles("docs/*.md", "README.md")) {
    let n = 0;
    for (const m of read(f).matchAll(fenced)) sources.push([`${f} block ${++n}`, m[1]]);
  }
  return sources;
}

/** AST with source positions removed, so only program meaning is compared. */
function shape(ast: unknown): string {
  return JSON.stringify(ast, (key, value) => (key === "loc" || key === "filePath" ? undefined : value));
}

function format(source: string, filePath: string): { text: string; ast: unknown } {
  const { ast, trivia } = parsejaiphWithTrivia(source, filePath);
  return { text: emitModule(ast, trivia), ast };
}

test("jaiph format round-trips every Jaiph source in the repo without changing the program", () => {
  const sources = collectSources();
  assert.ok(sources.length > 300, `expected a broad corpus, found ${sources.length} sources`);

  const failures: string[] = [];
  let checked = 0;
  for (const [name, source] of sources) {
    const filePath = name.includes(".test.jh") ? "x.test.jh" : "x.jh";
    let first: { text: string; ast: unknown };
    try {
      first = format(source, filePath);
    } catch {
      continue; // not a standalone program (error example or fragment)
    }
    checked += 1;
    let second: { text: string; ast: unknown };
    try {
      second = format(first.text, filePath);
    } catch (err) {
      failures.push(`${name}: formatted output does not parse: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    if (second.text !== first.text) {
      failures.push(`${name}: not idempotent`);
    } else if (shape(second.ast) !== shape(first.ast)) {
      failures.push(`${name}: formatting changed the program (AST differs)`);
    }
  }
  assert.ok(checked > 300, `expected most sources to parse, only ${checked} did`);
  assert.deepEqual(failures, [], `formatter round-trip failures:\n${failures.join("\n")}`);
});
