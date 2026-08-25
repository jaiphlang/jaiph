import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Task 3 acceptance: Explanation quadrant pages exist and are reachable
// from the nav. These guards fail when the contract is violated — they
// are independent of the broader docs-lint harness in task 2.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

function frontMatterDiataxis(source: string): string | null {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const dl = m[1].split("\n").find((l) => /^diataxis\s*:/.test(l));
  if (!dl) return null;
  return dl.replace(/^diataxis\s*:\s*/, "").trim().replace(/^['"]|['"]$/g, "");
}

function frontMatterPermalink(source: string): string | null {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const pl = m[1].split("\n").find((l) => /^permalink\s*:/.test(l));
  if (!pl) return null;
  return pl.replace(/^permalink\s*:\s*/, "").trim().replace(/^['"]|['"]$/g, "");
}

const EXPLANATION_PAGES: Array<{
  file: string;
  permalink: string;
  label: string;
}> = [
  { file: "why-jaiph.md", permalink: "/why-jaiph", label: "Why Jaiph" },
  { file: "inbox.md", permalink: "/inbox", label: "Inbox" },
  {
    file: "spec-async-handles.md",
    permalink: "/spec-async-handles",
    label: "Async Handles",
  },
];

test("task-3: each new explanation page declares 'diataxis: explanation' and the expected permalink", () => {
  for (const page of EXPLANATION_PAGES) {
    const src = readPage(page.file);
    assert.equal(
      frontMatterDiataxis(src),
      "explanation",
      `${page.file} must declare 'diataxis: explanation'`,
    );
    assert.equal(
      frontMatterPermalink(src),
      page.permalink,
      `${page.file} must declare 'permalink: ${page.permalink}'`,
    );
  }
});

test("task-3: every new explanation page is reachable from the nav exactly once", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const linkRe = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(nav)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const page of EXPLANATION_PAGES) {
    assert.equal(
      counts.get(page.permalink) ?? 0,
      1,
      `nav must link to ${page.permalink} exactly once (found ${counts.get(page.permalink) ?? 0})`,
    );
  }
});

