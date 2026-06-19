import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Task 7 acceptance: the docs nav is the Diátaxis spine — every published
// docs/*.md with a `diataxis:` front-matter value must appear under the
// matching section exactly once, the five section headings must appear in
// the documented order, and miscategorisation / duplication / omission is a
// hard failure. The redirect-coverage and clean-jekyll checks live in
// docs-structure.test.ts and docs-legacy-quarantine.test.ts respectively; this
// file owns the section-structure contract alone.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

const SECTIONS: Array<{ heading: string; diataxis: string }> = [
  { heading: "Tutorials", diataxis: "tutorial" },
  { heading: "How-to guides", diataxis: "how-to" },
  { heading: "Reference", diataxis: "reference" },
  { heading: "Explanation", diataxis: "explanation" },
  { heading: "Contributing", diataxis: "contributor" },
];

interface Page {
  file: string;
  permalink: string;
  diataxis: string;
}

function frontMatter(source: string): string | null {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function scalar(fm: string, key: string): string | null {
  const line = fm.split("\n").find((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (!line) return null;
  return line
    .replace(new RegExp(`^${key}\\s*:\\s*`), "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function loadPublishedPages(): Page[] {
  const pages: Page[] = [];
  for (const entry of readdirSync(DOCS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const src = readFileSync(join(DOCS_DIR, entry), "utf8");
    const fm = frontMatter(src);
    if (!fm) continue;
    const diataxis = scalar(fm, "diataxis");
    const permalink = scalar(fm, "permalink");
    if (!diataxis || !permalink) continue;
    pages.push({ file: entry, permalink, diataxis });
  }
  return pages;
}

interface NavParse {
  headings: string[];
  bySection: Map<string, string[]>;
}

function parseNav(): NavParse {
  const html = readFileSync(NAV_LAYOUT, "utf8");
  const itemRe =
    /<li(?:\s+class="docs-nav-group")?\s*>(?:<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"[^>]*>([^<]+)<\/a>|([^<]+))<\/li>/g;
  const headings: string[] = [];
  const bySection = new Map<string, string[]>();
  let currentHeading: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html)) !== null) {
    const isGroup = /class="docs-nav-group"/.test(m[0]);
    if (isGroup) {
      currentHeading = (m[3] ?? "").trim();
      headings.push(currentHeading);
      bySection.set(currentHeading, []);
      continue;
    }
    const permalink = m[1];
    if (!permalink || permalink === "/" || currentHeading === null) continue;
    bySection.get(currentHeading)!.push(permalink);
  }
  return { headings, bySection };
}

test("task-7: nav contains the five Diátaxis section headings in the documented order", () => {
  const { headings } = parseNav();
  const expected = SECTIONS.map((s) => s.heading);
  // Slice to handle the case where the nav adds further <li class="docs-nav-group">
  // headings in the future; the contract is "these five, in this order, before
  // anything else". A simple equality is fine today and tightens the contract.
  assert.deepEqual(
    headings,
    expected,
    `nav section headings must be exactly ${JSON.stringify(expected)} in this order; got ${JSON.stringify(headings)}`,
  );
});

test("task-7: every published diataxis page appears under its section exactly once (no miss / no miscategorisation / no dup)", () => {
  const pages = loadPublishedPages();
  const { bySection } = parseNav();

  for (const section of SECTIONS) {
    const links = bySection.get(section.heading) ?? [];
    const pagesInSection = pages.filter((p) => p.diataxis === section.diataxis);
    const expectedPermalinks = pagesInSection.map((p) => p.permalink).sort();
    const actualPermalinks = [...links].sort();

    assert.deepEqual(
      actualPermalinks,
      expectedPermalinks,
      `section "${section.heading}" (diataxis: ${section.diataxis}) members drifted from the set of published pages with that diataxis.\n  expected: ${JSON.stringify(expectedPermalinks)}\n  actual:   ${JSON.stringify(actualPermalinks)}`,
    );

    // Defensive: assert no duplicate permalinks within the section's own list.
    const counts = new Map<string, number>();
    for (const link of links) counts.set(link, (counts.get(link) ?? 0) + 1);
    for (const [link, n] of counts) {
      assert.equal(
        n,
        1,
        `section "${section.heading}" lists ${link} ${n} times — every page must appear exactly once`,
      );
    }
  }

  // And cross-section: no permalink may appear under more than one section.
  const seen = new Map<string, string>();
  for (const section of SECTIONS) {
    for (const link of bySection.get(section.heading) ?? []) {
      const owner = seen.get(link);
      assert.ok(
        owner === undefined,
        `${link} appears under both "${owner}" and "${section.heading}" — pages may only appear in one section`,
      );
      seen.set(link, section.heading);
    }
  }

  // And every published diataxis page is reachable: nothing landed orphaned
  // between sections because the section's heading was missing.
  for (const p of pages) {
    const section = SECTIONS.find((s) => s.diataxis === p.diataxis);
    assert.ok(
      section,
      `${p.file}: diataxis '${p.diataxis}' has no nav section`,
    );
    const links = bySection.get(section!.heading) ?? [];
    assert.ok(
      links.includes(p.permalink),
      `${p.file}: published page ${p.permalink} (diataxis: ${p.diataxis}) is missing from the "${section!.heading}" section`,
    );
  }
});
