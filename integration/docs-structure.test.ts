import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const LEGACY_DIR = join(DOCS_DIR, "_legacy");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

const VALID_DIATAXIS = new Set([
  "tutorial",
  "how-to",
  "reference",
  "explanation",
  "contributor",
]);

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
        route = "/" + path.slice(0, -3);
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

test("docs-lint: pages under docs/_legacy/ are exempt from publish-side checks", () => {
  if (!existsSync(LEGACY_DIR)) return;
  const legacy = readdirSync(LEGACY_DIR).filter((e) => e.endsWith(".md"));
  assert.ok(legacy.length > 0, "expected quarantined pages under docs/_legacy/");

  // loadPages() reads docs/ immediate children only, so _legacy entries
  // are never subjected to the diataxis / nav / link checks above.
  const live = new Set(loadPages().map((p) => p.name));
  for (const entry of legacy) {
    assert.ok(
      !live.has(entry),
      `${entry} must live only under docs/_legacy/ — not docs/${entry}`,
    );
  }
});
