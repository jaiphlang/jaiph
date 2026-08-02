import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

const VALID_DIATAXIS = new Set([
  "tutorial",
  "how-to",
  "reference",
  "explanation",
  "contributor",
]);

// Context-budget guard for docs (docs/agent-analyzability.md, "Documentation
// structure"): every published page must be summary-first and small enough for
// an agent to load whole.
//
// Summary-first: the first non-blank body line after the H1 must be a prose
// lead paragraph (the summary) — not a subheading, list, table, blockquote, or
// code fence — and it must appear within the first SUMMARY_WINDOW lines after
// the H1. This is the pattern every current page already follows (a lead
// paragraph directly under the H1; docs/agent-analyzability.md labels its lead
// `**Summary.**`). We enforce that documented pattern rather than mandating the
// literal word "Summary", so no existing page has to be rewritten.
const SUMMARY_WINDOW = 20;

// Body-line cap: keep pages loadable in one shot. 500 body lines (front matter
// excluded) is chosen because the largest current authoritative-reference page
// (contributing.md) is ~481 body lines, so 500 fits every page today while
// still failing a page that grows past a single loadable topic. Splitting a
// page is preferred over merging unrelated topics to dodge the cap. A page that
// legitimately must exceed the cap goes on DOC_SIZE_ALLOWLIST with a one-line
// justification instead of relaxing the number.
const BODY_LINE_CAP = 500;

// filename -> justification. Empty today: every published page fits the cap.
// Add an entry only for a page whose single topic genuinely cannot fit (never
// to merge topics into an oversized file).
const DOC_SIZE_ALLOWLIST: Record<string, string> = {};

interface PageInfo {
  name: string;
  body: string;
  permalink: string | null;
  redirectFrom: string[];
  diataxis: string | null;
  anchors: Set<string>;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Minimal YAML-ish front-matter parser. Supports `key: scalar` lines and
// `key:` followed by `  - value` list items, which is everything our docs
// front-matter uses. Anything more exotic is intentionally out of scope.
function parseFrontMatter(source: string): {
  fm: Record<string, string | string[]>;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fm: {}, body: normalized };
  }
  const lines = normalized.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: normalized };

  const fm: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^-\s+/.test(trimmed) && currentListKey) {
      const value = stripQuotes(trimmed.replace(/^-\s+/, ""));
      (fm[currentListKey] as string[]).push(value);
      continue;
    }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      currentListKey = null;
      continue;
    }
    const key = m[1];
    const value = m[2].trim();
    if (value === "") {
      fm[key] = [];
      currentListKey = key;
    } else {
      fm[key] = stripQuotes(value);
      currentListKey = null;
    }
  }
  return { fm, body: lines.slice(end + 1).join("\n") };
}

function slugify(headingText: string): string {
  // kramdown / GFM heading slug: drop code-span ticks, drop emphasis marks,
  // lowercase, keep [a-z0-9-], collapse whitespace to dashes.
  return headingText
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function extractAnchors(body: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // ATX heading: # ... [{#explicit-id} | {:#explicit-id} | {: #explicit-id}]
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const text = h[2].trim();
      const explicit = text.match(/\{:?\s*#([a-zA-Z0-9_-]+)\}\s*$/);
      if (explicit) {
        anchors.add(explicit[1]);
        anchors.add(slugify(text.replace(/\{:?\s*#[^}]+\}\s*$/, "")));
      } else {
        anchors.add(slugify(text));
      }
    }
    // kramdown Inline Attribute List attached to any preceding block:
    //   {:#anchor}  /  {: #anchor}  on its own line.
    const ial = line.match(/^\s*\{:\s*#([a-zA-Z0-9_-]+)\s*\}\s*$/);
    if (ial) anchors.add(ial[1]);
  }
  return anchors;
}

function loadPages(): PageInfo[] {
  const pages: PageInfo[] = [];
  for (const entry of readdirSync(DOCS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const source = readFileSync(join(DOCS_DIR, entry), "utf8");
    const { fm, body } = parseFrontMatter(source);
    pages.push({
      name: entry,
      body,
      permalink: typeof fm.permalink === "string" ? fm.permalink : null,
      redirectFrom: Array.isArray(fm.redirect_from) ? fm.redirect_from : [],
      diataxis: typeof fm.diataxis === "string" ? fm.diataxis : null,
      anchors: extractAnchors(body),
    });
  }
  return pages;
}

function bodyContentLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").split("\n");
}

// Index of the page H1 (`# Title`), skipping any `# ...` that is a shell
// comment inside a fenced code block. -1 if the body has no H1.
function findH1Index(lines: string[]): number {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#\s+/.test(lines[i])) return i;
  }
  return -1;
}

// First non-blank body line after the H1, with its distance (in lines) from the
// H1. null if the body ends right after the H1.
function leadLineAfterH1(
  lines: string[],
  h1: number,
): { text: string; offset: number } | null {
  for (let i = h1 + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    return { text: lines[i], offset: i - h1 };
  }
  return null;
}

// A summary lead is prose: not a subheading, list item, table row, blockquote,
// code fence, or HTML comment. `**Summary.**`-style bold leads count as prose
// (a bold run `**` is not a `* ` bullet).
function isProseLead(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (/^#{1,6}\s/.test(t)) return false; // heading / subheading
  if (/^[-*+]\s/.test(t)) return false; // bullet list
  if (/^\d+[.)]\s/.test(t)) return false; // ordered list
  if (/^\|/.test(t)) return false; // table row
  if (/^>/.test(t)) return false; // blockquote
  if (/^```/.test(t)) return false; // code fence
  if (/^<!--/.test(t)) return false; // HTML comment
  return true;
}

// Returns an error string if the page is not summary-first, else null.
function summaryFirstError(name: string, body: string): string | null {
  const lines = bodyContentLines(body);
  const h1 = findH1Index(lines);
  if (h1 === -1) return `${name}: no H1 heading found`;
  const lead = leadLineAfterH1(lines, h1);
  if (!lead) return `${name}: no body content after the H1`;
  if (lead.offset > SUMMARY_WINDOW) {
    return `${name}: summary must start within ${SUMMARY_WINDOW} lines after the H1 (found at +${lead.offset})`;
  }
  if (!isProseLead(lead.text)) {
    return `${name}: first body block after the H1 must be a prose summary paragraph, not "${lead.text.trim().slice(0, 40)}…"`;
  }
  return null;
}

// Body-line count, excluding front matter (already stripped) and leading/
// trailing blank lines so a single trailing newline does not inflate the count.
function countBodyLines(body: string): number {
  const lines = bodyContentLines(body);
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length;
}

// Returns an error string if the page exceeds the cap and is not allowlisted.
function bodySizeError(
  name: string,
  body: string,
  cap: number,
  allowlist: Record<string, string>,
): string | null {
  const n = countBodyLines(body);
  if (n <= cap) return null;
  if (name in allowlist) return null;
  return `${name}: body has ${n} lines, over the ${cap}-line cap — split the page or add it to DOC_SIZE_ALLOWLIST with a justification`;
}

function extractNavPermalinks(navHtml: string): string[] {
  // Counts every <a href="{{ '/foo' | relative_url }}"> as exactly one nav entry.
  const linkPattern = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(navHtml)) !== null) {
    links.push(m[1]);
  }
  return links;
}

function pageByPermalink(pages: PageInfo[]): Map<string, PageInfo> {
  const map = new Map<string, PageInfo>();
  for (const p of pages) {
    if (p.permalink) map.set(p.permalink, p);
  }
  return map;
}

function allKnownRoutes(pages: PageInfo[]): Set<string> {
  const routes = new Set<string>(["/"]);
  for (const p of pages) {
    if (p.permalink) routes.add(p.permalink);
    for (const r of p.redirectFrom) routes.add(r);
  }
  return routes;
}

function collectHistoricalNavPermalinks(): Set<string> | null {
  const proc = spawnSync(
    "git",
    ["log", "-p", "--all", "--", "docs/_layouts/docs.html"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.status !== 0) return null;
  const set = new Set<string>();
  const re = /'(\/[a-zA-Z0-9_-][a-zA-Z0-9_/-]*)'\s*\|\s*relative_url/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(proc.stdout)) !== null) {
    set.add(m[1]);
  }
  return set;
}

test("docs-lint: every published docs/*.md has a valid 'diataxis:' front-matter value", () => {
  const pages = loadPages();
  assert.ok(pages.length > 0, "expected at least one published doc under docs/");
  for (const p of pages) {
    assert.notEqual(
      p.diataxis,
      null,
      `${p.name}: missing 'diataxis:' front-matter (allowed: ${[...VALID_DIATAXIS].join(", ")})`,
    );
    assert.ok(
      VALID_DIATAXIS.has(p.diataxis!),
      `${p.name}: invalid 'diataxis: ${p.diataxis}' (allowed: ${[...VALID_DIATAXIS].join(", ")})`,
    );
  }
});

test("docs-lint: every nav permalink corresponds to a published page", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const links = extractNavPermalinks(nav);
  const pages = loadPages();
  const byPermalink = pageByPermalink(pages);

  for (const link of links) {
    if (link === "/" || link === "") continue;
    assert.ok(
      byPermalink.has(link),
      `nav link ${link} has no matching published page (no docs/*.md declares 'permalink: ${link}')`,
    );
  }
});

test("docs-lint: every published page is linked from nav exactly once", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const links = extractNavPermalinks(nav);
  const pages = loadPages();
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link, (counts.get(link) ?? 0) + 1);

  for (const p of pages) {
    assert.ok(
      p.permalink,
      `${p.name}: published page must declare a 'permalink:' so nav can target it exactly once`,
    );
    const count = counts.get(p.permalink!) ?? 0;
    assert.equal(
      count,
      1,
      `${p.name}: expected exactly one nav entry for ${p.permalink} but found ${count}`,
    );
  }
});

test("docs-lint: every internal markdown link / permalink / redirect_from resolves", () => {
  const pages = loadPages();
  const routes = allKnownRoutes(pages);
  const byPermalink = pageByPermalink(pages);
  const byName = new Map(pages.map((p) => [p.name, p]));

  // [label](href) but not images (![label](href))
  const mdLinkRe = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g;

  for (const p of pages) {
    let m: RegExpExecArray | null;
    while ((m = mdLinkRe.exec(p.body)) !== null) {
      const label = m[1];
      const href = m[2];
      if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
      let path = href;
      let anchor: string | null = null;
      const hashIdx = path.indexOf("#");
      if (hashIdx >= 0) {
        anchor = path.slice(hashIdx + 1);
        path = path.slice(0, hashIdx);
      }

      if (!path) {
        // in-page anchor link
        assert.ok(
          anchor !== null && p.anchors.has(anchor),
          `${p.name}: in-page link [${label}](${href}) has no matching heading`,
        );
        continue;
      }

      let route: string;
      if (path.startsWith("/")) {
        route = path.replace(/\/$/, "") || "/";
      } else if (path.endsWith(".md")) {
        // Relative file link. jekyll-relative-links rewrites it to the target
        // page's permalink, so resolve by the target FILE's declared permalink
        // (basename -> page -> permalink), not a naive "/basename" — pages may
        // live at nested permalinks (e.g. /tutorials/first-workflow).
        const targetName = path.split("/").pop()!;
        const target = byName.get(targetName);
        assert.ok(
          target && target.permalink,
          `${p.name}: link [${label}](${href}) — no published page file '${targetName}'`,
        );
        route = target!.permalink!;
      } else {
        route = "/" + path.replace(/\/$/, "");
      }

      assert.ok(
        routes.has(route),
        `${p.name}: link [${label}](${href}) — route '${route}' does not resolve to any published page or redirect_from`,
      );

      // Only verify anchor when the route resolves to a real live page.
      // If it resolves only via a redirect_from, the target page is a redirect
      // landing and almost never carries the original section anchor; future
      // Diátaxis pages will own those anchors.
      if (anchor) {
        const target = byPermalink.get(route);
        if (target) {
          assert.ok(
            target.anchors.has(anchor),
            `${p.name}: link [${label}](${href}) — anchor '#${anchor}' not found in ${target.name}`,
          );
        }
      }
    }

    // redirect_from must not collide with another page's permalink
    for (const r of p.redirectFrom) {
      const owner = byPermalink.get(r);
      assert.ok(
        !owner || owner === p,
        `${p.name}: redirect_from '${r}' collides with permalink of ${owner?.name}`,
      );
    }
  }
});

test("docs-lint: every historical nav permalink still resolves (via page or redirect_from)", () => {
  const historical = collectHistoricalNavPermalinks();
  if (historical === null) {
    // git unavailable in this sandbox — historical coverage cannot be checked.
    return;
  }
  const pages = loadPages();
  const routes = allKnownRoutes(pages);
  for (const link of historical) {
    if (link === "/" || link === "") continue;
    assert.ok(
      routes.has(link),
      `historical nav permalink '${link}' no longer resolves: add it under 'redirect_from:' on a live page (architecture.md or jaiph-skill.md)`,
    );
  }
});

test("docs-lint: docs/_legacy/ no longer exists (post-redesign cleanup)", () => {
  const legacy = join(DOCS_DIR, "_legacy");
  assert.ok(
    !readdirSync(DOCS_DIR).includes("_legacy"),
    `docs/_legacy/ must be removed after the Diátaxis redesign; found ${legacy}`,
  );
});

test("docs-lint: every published docs/*.md opens with a summary-first lead paragraph", () => {
  const pages = loadPages();
  assert.ok(pages.length > 0, "expected at least one published doc under docs/");
  for (const p of pages) {
    const err = summaryFirstError(p.name, p.body);
    assert.equal(err, null, err ?? "");
  }
});

test("docs-lint: no non-allowlisted published doc exceeds the body-line cap", () => {
  const pages = loadPages();
  for (const p of pages) {
    const err = bodySizeError(p.name, p.body, BODY_LINE_CAP, DOC_SIZE_ALLOWLIST);
    assert.equal(err, null, err ?? "");
  }
  // Every allowlist entry must carry a non-empty justification.
  for (const [name, why] of Object.entries(DOC_SIZE_ALLOWLIST)) {
    assert.ok(
      typeof why === "string" && why.trim().length > 0,
      `DOC_SIZE_ALLOWLIST['${name}'] must include a one-line justification`,
    );
  }
});

// docs/agent-analyzability.md is the page that defines the context-budget
// convention, so AC pins both of its guarantees directly: it stays in nav and
// it keeps its explicit **Summary** lead.
test("docs-lint: agent-analyzability.md stays in nav and keeps its Summary lead", () => {
  const pages = loadPages();
  const page = pages.find((p) => p.name === "agent-analyzability.md");
  assert.ok(page, "docs/agent-analyzability.md must remain a published page");

  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const links = extractNavPermalinks(nav);
  assert.ok(
    page!.permalink && links.includes(page!.permalink!),
    "docs/agent-analyzability.md must stay linked from the docs nav",
  );

  const lines = bodyContentLines(page!.body);
  const lead = leadLineAfterH1(lines, findH1Index(lines));
  assert.ok(
    lead && /^\*\*Summary\b/.test(lead.text.trim()),
    "docs/agent-analyzability.md must keep its explicit **Summary** lead paragraph",
  );
});

// Contract self-tests: prove the guards actually fail on a violating page,
// independent of whether the real docs happen to comply today.
test("docs-lint: summary-first guard rejects a page whose first block is a heading", () => {
  const bad = "# Title\n\n## Section\n\nbody text\n";
  assert.notEqual(summaryFirstError("bad.md", bad), null);

  const badList = "# Title\n\n- item one\n- item two\n";
  assert.notEqual(summaryFirstError("bad-list.md", badList), null);

  const good = "# Title\n\n**Summary.** A prose lead.\n\n## Section\n";
  assert.equal(summaryFirstError("good.md", good), null);

  const goodPlain = "# Title\n\nA plain prose lead paragraph.\n\n## Section\n";
  assert.equal(summaryFirstError("good-plain.md", goodPlain), null);
});

test("docs-lint: body-line cap guard fails an over-cap page unless allowlisted", () => {
  const big = Array.from({ length: BODY_LINE_CAP + 1 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  assert.ok(countBodyLines(big) > BODY_LINE_CAP);
  assert.notEqual(bodySizeError("big.md", big, BODY_LINE_CAP, {}), null);
  assert.equal(
    bodySizeError("big.md", big, BODY_LINE_CAP, { "big.md": "justified" }),
    null,
  );

  const small = "line 1\nline 2\n";
  assert.equal(bodySizeError("small.md", small, BODY_LINE_CAP, {}), null);
});
