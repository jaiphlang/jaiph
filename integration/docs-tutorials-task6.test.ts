import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Task 6 acceptance: Tutorials quadrant pages exist, are wired into nav,
// retire `/getting-started` via redirect_from, and the first-workflow
// tutorial's `.jh` snippet is *executable* — extracting the first ```jh
// fenced block and running it with `JAIPH_UNSAFE=true` produces the
// documented output. This guards against tutorials drifting into
// aspirational prose where the copy-pasted commands no longer work.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");
const JAIPH_BIN = join(REPO_ROOT, "dist", "src", "cli.js");

const TUTORIAL_PAGES: Array<{ file: string; permalink: string }> = [
  { file: "first-workflow.md", permalink: "/tutorials/first-workflow" },
  { file: "first-agent-run.md", permalink: "/tutorials/first-agent-run" },
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

function frontMatterList(fm: string, key: string): string[] {
  const lines = fm.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^${key}\\s*:\\s*$`).test(l));
  if (startIdx === -1) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+(.+)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

function extractFencedBlocks(body: string, lang: string): string[] {
  // CommonMark: a fenced block opens with ```<lang> on its own line and
  // closes on the next line that is exactly ``` (allowing trailing space).
  // The tutorial deliberately uses single-backtick script bodies so no
  // nested ``` appears inside ```jh blocks — keep this extractor simple.
  const lines = body.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^```(\w[\w-]*)\s*$/);
    if (!open) {
      i++;
      continue;
    }
    const openLang = open[1];
    i++;
    const start = i;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) i++;
    if (openLang === lang) {
      blocks.push(lines.slice(start, i).join("\n"));
    }
    i++; // skip the closing fence
  }
  return blocks;
}

function normalizeRunTimings(out: string): string {
  // Strip per-step and total elapsed times so output comparison is stable.
  // Matches "(0s)", "(0.2s)", "(123ms)", "(1.5s)".
  return out.replace(/\(\d+(\.\d+)?(s|ms)\)/g, "(<time>)");
}

test("task-6: every tutorial page declares 'diataxis: tutorial' and the expected permalink", () => {
  for (const page of TUTORIAL_PAGES) {
    const fm = frontMatterBlock(readPage(page.file));
    assert.ok(fm, `${page.file}: missing front-matter block`);
    assert.equal(
      frontMatterScalar(fm!, "diataxis"),
      "tutorial",
      `${page.file}: must declare 'diataxis: tutorial'`,
    );
    assert.equal(
      frontMatterScalar(fm!, "permalink"),
      page.permalink,
      `${page.file}: must declare 'permalink: ${page.permalink}'`,
    );
  }
});

test("task-6: every tutorial is reachable from the nav exactly once", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const linkRe = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(nav)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const page of TUTORIAL_PAGES) {
    const count = counts.get(page.permalink) ?? 0;
    assert.equal(
      count,
      1,
      `nav must link to ${page.permalink} exactly once (found ${count})`,
    );
  }
  // The nav must surface a "Tutorials" group label so the two pages render
  // as a learning quadrant rather than dangling next to How-to / Reference.
  assert.match(
    nav,
    /<li class="docs-nav-group">Tutorials<\/li>/,
    "nav must include a 'Tutorials' group heading",
  );
});

test("task-6: '/getting-started' is absorbed by the first-workflow tutorial's redirect_from", () => {
  // The retired permalink must be claimed by exactly one live page (the new
  // tutorial). Any other live page declaring 'permalink: /getting-started'
  // or duplicating the redirect_from would conflict with jekyll-redirect-from.
  const fm = frontMatterBlock(readPage("first-workflow.md"));
  assert.ok(fm, "first-workflow.md: missing front-matter block");
  const declared = frontMatterList(fm!, "redirect_from");
  assert.ok(
    declared.includes("/getting-started"),
    `first-workflow.md: redirect_from must include '/getting-started' (declared: ${declared.join(", ") || "<none>"})`,
  );
  // Defensive: architecture.md previously claimed /getting-started while no
  // tutorial existed. Once this tutorial owns the slug, the older entry must
  // be gone so jekyll-redirect-from does not emit two competing stubs.
  const archFm = frontMatterBlock(readPage("architecture.md"));
  assert.ok(archFm, "architecture.md: missing front-matter block");
  const archRedirects = frontMatterList(archFm!, "redirect_from");
  assert.ok(
    !archRedirects.includes("/getting-started"),
    "architecture.md must no longer claim '/getting-started' under redirect_from — the tutorial owns it now",
  );
});

test("task-6: first-workflow tutorial's `.jh` snippet runs end-to-end and matches the documented output", () => {
  const page = readPage("first-workflow.md");
  const jhBlocks = extractFencedBlocks(page, "jh");
  assert.ok(
    jhBlocks.length >= 1,
    "first-workflow.md: expected at least one ```jh fenced code block",
  );
  const textBlocks = extractFencedBlocks(page, "text");
  assert.ok(
    textBlocks.length >= 1,
    "first-workflow.md: expected at least one ```text fenced block (documented output)",
  );

  const snippet = jhBlocks[0];
  const expectedOutput = textBlocks[0];

  // The snippet is parameterised with `who`. The tutorial copy-paste invokes
  // it with "Adam"; pinning the same argument here keeps the contract honest.
  const args = ["Adam"];

  const tmp = mkdtempSync(join(tmpdir(), "jaiph-tutorial-"));
  try {
    const entry = join(tmp, "hello.jh");
    writeFileSync(entry, snippet);

    assert.ok(
      existsSync(JAIPH_BIN),
      `${JAIPH_BIN} not found — run \`npm run build\` first`,
    );

    const env = {
      // Clean env: PATH for child shell + script execve, HOME for any
      // tooling that touches it, JAIPH_UNSAFE so Docker is bypassed in CI,
      // and TERM so the runtime does not try to render TTY escapes.
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: tmp,
      JAIPH_UNSAFE: "true",
      TERM: "dumb",
      NO_COLOR: "1",
    };

    const result = spawnSync(
      process.execPath,
      [JAIPH_BIN, "run", entry, ...args],
      { env, encoding: "utf8", cwd: tmp, timeout: 60_000 },
    );

    assert.equal(
      result.status,
      0,
      `tutorial snippet should exit 0; got status=${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );

    const got = normalizeRunTimings(result.stdout.trim());
    const want = normalizeRunTimings(expectedOutput.trim());
    assert.equal(
      got,
      want,
      `tutorial documented output drifted from actual run.\n--- got ---\n${got}\n--- want ---\n${want}`,
    );

    // The artifacts the tutorial points at must exist on disk after a run.
    const runRoot = join(tmp, ".jaiph", "runs");
    assert.ok(existsSync(runRoot), ".jaiph/runs/ must exist after a successful run");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
