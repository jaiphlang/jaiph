import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Task 5 acceptance: Reference quadrant pages exist as pure lookup pages, the
// env-var reference is source-parity-pinned against `src/` (drift in either
// direction fails the test), and reference pages contain no tutorial-shaped
// prose. These guards fail when the contract is violated — they are
// independent of the broader docs-lint harness in task 2.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");
const SRC_DIR = join(REPO_ROOT, "src");

const REFERENCE_PAGES: Array<{ file: string; permalink: string }> = [
  { file: "cli.md", permalink: "/reference/cli" },
  { file: "configuration.md", permalink: "/reference/configuration" },
  { file: "grammar.md", permalink: "/reference/grammar" },
  { file: "language.md", permalink: "/reference/language" },
  { file: "env-vars.md", permalink: "/reference/env-vars" },
];

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

function frontMatterBlock(source: string): string | null {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function frontMatterScalar(fm: string, key: string): string | null {
  const line = fm.split("\n").find((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (!line) return null;
  return line.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim().replace(/^['"]|['"]$/g, "");
}

function bodyWithoutFrontMatter(source: string): string {
  const m = source.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? source.slice(m[0].length) : source;
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function collectJaiphEnvNamesFromSource(): Set<string> {
  // Source-parity pattern: greppable `<anyIdentifier>env.JAIPH_X` /
  // `process.env.JAIPH_X` / `process.env["JAIPH_X"]` anywhere under src/.
  // The leading `[a-zA-Z]*` lets the test catch both `env.JAIPH_*` (the
  // host-side runner env in `src/cli/run/env.ts`), `process.env.JAIPH_*`
  // (callers that go through the full Node `process.env` namespace), and
  // `parentEnv.JAIPH_*` (the runtime's metadata-merge lock checks in
  // `src/runtime/kernel/node-workflow-runtime.ts`). All three forms are
  // semantically equivalent reads of the same variable.
  const PATTERNS = [
    /[a-zA-Z]*[Ee]nv\.JAIPH_([A-Z_]+)/g,
    /process\.env\[["']JAIPH_([A-Z_]+)["']\]/g,
  ];
  const names = new Set<string>();
  for (const file of walkSourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        names.add(`JAIPH_${m[1]}`);
      }
    }
  }
  return names;
}

function extractParityNamesFromEnvVarsPage(): Set<string> {
  const body = bodyWithoutFrontMatter(readPage("env-vars.md"));
  // The canonical parity-pinned table is delimited by HTML markers so other
  // sections (installer-only vars, vendor credentials) are not subject to the
  // strict src-drift gate.
  const m = body.match(
    /<!--\s*begin:\s*src-parity\s*-->([\s\S]*?)<!--\s*end:\s*src-parity\s*-->/,
  );
  assert.ok(
    m,
    "env-vars.md must include a `<!-- begin: src-parity -->` / `<!-- end: src-parity -->` block delimiting the source-parity table",
  );
  const block = m![1];
  // Match every backtick-wrapped `JAIPH_NAME` token in the block — every table
  // row's first column wraps the variable name in backticks.
  const names = new Set<string>();
  const tokenRe = /`(JAIPH_[A-Z_]+)`/g;
  let mm: RegExpExecArray | null;
  while ((mm = tokenRe.exec(block)) !== null) {
    names.add(mm[1]);
  }
  return names;
}

test("task-5: every reference page declares 'diataxis: reference' and the expected permalink", () => {
  for (const page of REFERENCE_PAGES) {
    const fm = frontMatterBlock(readPage(page.file));
    assert.ok(fm, `${page.file}: missing front-matter block`);
    assert.equal(
      frontMatterScalar(fm!, "diataxis"),
      "reference",
      `${page.file}: must declare 'diataxis: reference'`,
    );
    assert.equal(
      frontMatterScalar(fm!, "permalink"),
      page.permalink,
      `${page.file}: must declare 'permalink: ${page.permalink}'`,
    );
  }
});

test("task-5: every reference page is reachable from the nav exactly once", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const linkRe = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(nav)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const page of REFERENCE_PAGES) {
    const count = counts.get(page.permalink) ?? 0;
    assert.equal(
      count,
      1,
      `nav must link to ${page.permalink} exactly once (found ${count})`,
    );
  }
});

test("task-5: env-vars reference is source-parity-pinned against src/ (drift in either direction fails)", () => {
  const fromSource = collectJaiphEnvNamesFromSource();
  const fromPage = extractParityNamesFromEnvVarsPage();

  const missingFromPage = [...fromSource].filter((n) => !fromPage.has(n)).sort();
  const missingFromSource = [...fromPage].filter((n) => !fromSource.has(n)).sort();

  assert.deepEqual(
    missingFromPage,
    [],
    `env-vars.md must list every JAIPH_* name read in src/. Missing from page: ${missingFromPage.join(", ") || "<none>"}`,
  );
  assert.deepEqual(
    missingFromSource,
    [],
    `env-vars.md must not list a JAIPH_* name absent from src/. Page rows without a src reference: ${missingFromSource.join(", ") || "<none>"}`,
  );

  // A non-empty intersection is the goal; assert the parity table is not empty
  // so a future "delete every row" regression also trips this guard.
  assert.ok(
    fromPage.size > 30,
    `env-vars.md parity table looks suspiciously short — only ${fromPage.size} rows`,
  );
});

test("task-5: reference pages contain no tutorial-shaped numbered walkthroughs", () => {
  for (const page of REFERENCE_PAGES) {
    const body = bodyWithoutFrontMatter(readPage(page.file));
    // Reject numbered ## / ### section headings (the how-to recipe shape).
    const numberedHeading = /^#{2,4}\s+\d+\.\s+/m;
    assert.ok(
      !numberedHeading.test(body),
      `${page.file}: reference pages must not use numbered '## 1. <step>' / '### 2. <step>' section headings — that shape belongs in a how-to`,
    );
    // Reject the how-to recipe's terminal section.
    assert.ok(
      !/^#{2,4}\s+(Verification|Verify(?:\s|$))/im.test(body),
      `${page.file}: reference pages must not include a 'Verification' / 'Verify' section — that shape belongs in a how-to`,
    );
    // Reject paragraphs that begin with second-person imperative procedure verbs.
    const tutorialLeads = /^(You can now|You will|Now you|Now, you|First,? you|Next,? you|Finally,? you)/im;
    assert.ok(
      !tutorialLeads.test(body),
      `${page.file}: reference pages must avoid second-person tutorial prose ('You will…', 'Now you…', etc.)`,
    );
    // Heuristic upper bound on second-person pronouns. Reference is allowed
    // some 'your run dir' / 'your workflow' phrasing, but a high count is a
    // signal of drifted tutorial content.
    const pronouns = (body.match(/\b(you|your|yourself)\b/gi) ?? []).length;
    assert.ok(
      pronouns <= 12,
      `${page.file}: too many second-person pronouns (${pronouns}); reference pages should describe the system, not address the reader`,
    );
  }
});
