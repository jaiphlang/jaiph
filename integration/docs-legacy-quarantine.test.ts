import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const LEGACY_DIR = join(DOCS_DIR, "_legacy");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

const LIVE_PAGES = ["architecture.md", "jaiph-skill.md"];
// Quarantined-only pages: still live exclusively under _legacy/ because their
// Diátaxis replacement hasn't landed yet. Once a page is recreated greenfield
// (e.g. inbox.md in task 3), it leaves this list — the legacy copy stays as a
// reconciliation reference, but a live page now occupies the original path.
const QUARANTINED_PAGES = [
  "contributing.md",
  "getting-started.md",
];
// Recreated-with-legacy-reference: a live docs/<page>.md exists AND the
// pre-redesign body is preserved under docs/_legacy/<page>.md for reconciliation.
const RECREATED_WITH_LEGACY = [
  "artifacts.md",
  "cli.md",
  "configuration.md",
  "grammar.md",
  "hooks.md",
  "inbox.md",
  "language.md",
  "libraries.md",
  "sandboxing.md",
  "setup.md",
  "spec-async-handles.md",
  "testing.md",
];

test("docs: live pages remain at original paths", () => {
  for (const page of LIVE_PAGES) {
    const live = join(DOCS_DIR, page);
    assert.ok(existsSync(live), `expected live page ${live} to exist`);
    const legacy = join(LEGACY_DIR, page);
    assert.ok(!existsSync(legacy), `live page must not be duplicated under _legacy: ${legacy}`);
  }
});

test("docs: quarantined pages moved into _legacy/ and removed from original paths", () => {
  assert.ok(existsSync(LEGACY_DIR), `expected ${LEGACY_DIR} to exist`);
  for (const page of QUARANTINED_PAGES) {
    const original = join(DOCS_DIR, page);
    const legacy = join(LEGACY_DIR, page);
    assert.ok(!existsSync(original), `${page} must no longer live at docs/${page}`);
    assert.ok(existsSync(legacy), `${page} must live at docs/_legacy/${page}`);
  }
});

test("docs: recreated pages exist live alongside their _legacy/ reference copy", () => {
  assert.ok(existsSync(LEGACY_DIR), `expected ${LEGACY_DIR} to exist`);
  for (const page of RECREATED_WITH_LEGACY) {
    const live = join(DOCS_DIR, page);
    const legacy = join(LEGACY_DIR, page);
    assert.ok(existsSync(live), `${page} must live at docs/${page} (greenfield rewrite)`);
    assert.ok(existsSync(legacy), `${page} legacy copy must remain at docs/_legacy/${page}`);
  }
});

test("docs nav: every internal link resolves to a live (non-quarantined) page", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  // Extract permalinks of the form: '/foo' from {{ '/foo' | relative_url }} inside <a href="...">.
  const linkPattern = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const permalinks = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(nav)) !== null) {
    permalinks.add(match[1]);
  }
  assert.ok(permalinks.size > 0, "nav should contain at least one internal link");

  // Collect each docs/*.md front-matter `permalink:` so nav entries with
  // custom permalinks (e.g. how-to pages at docs/<name>.md → /how-to/<slug>)
  // resolve by declared permalink rather than by URL-to-path heuristic.
  const liveDocsFiles = readdirSync(DOCS_DIR).filter((e: string) =>
    e.endsWith(".md"),
  );
  const livePermalinks = new Set<string>();
  for (const entry of liveDocsFiles) {
    const src = readFileSync(join(DOCS_DIR, entry), "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const pl = fm[1].split("\n").find((l) => /^permalink\s*:/.test(l));
    if (!pl) continue;
    const value = pl
      .replace(/^permalink\s*:\s*/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (value) livePermalinks.add(value);
  }

  const quarantinedSlugs = new Set(
    QUARANTINED_PAGES.map((p) => "/" + p.replace(/\.md$/, "")),
  );
  for (const link of permalinks) {
    if (link === "/" || link === "") continue;
    assert.ok(
      !quarantinedSlugs.has(link),
      `nav points at quarantined page ${link} — remove it from docs/_layouts/docs.html`,
    );
    assert.ok(
      livePermalinks.has(link),
      `nav link ${link} has no live docs/*.md whose front-matter declares 'permalink: ${link}'`,
    );
  }
});

function findBundle(): string | null {
  const probes = [
    spawnSync("bundle", ["--version"], { encoding: "utf8" }),
    spawnSync("/opt/homebrew/opt/ruby/bin/bundle", ["--version"], { encoding: "utf8" }),
  ];
  if (probes[0].status === 0) return "bundle";
  if (probes[1].status === 0) return "/opt/homebrew/opt/ruby/bin/bundle";
  return null;
}

test("docs site: jekyll build excludes docs/_legacy/", { timeout: 120_000 }, (t) => {
  const bundleBin = findBundle();
  if (!bundleBin) {
    t.skip("bundle not available — skip jekyll build verification");
    return;
  }
  const destination = mkdtempSync(join(tmpdir(), "jaiph-docs-site-"));
  try {
    const result = spawnSync(
      bundleBin,
      ["exec", "jekyll", "build", "--destination", destination],
      { cwd: DOCS_DIR, encoding: "utf8" },
    );
    if (result.status !== 0) {
      // Bundler is present but the gemset isn't installed (e.g. fresh checkout).
      // Treat that as "cannot verify locally"; CI runs `bundler-cache: true` first.
      const stderr = result.stderr || "";
      if (/Could not find|bundle install/i.test(stderr)) {
        t.skip(`bundler dependencies not installed: ${stderr.split("\n")[0]}`);
        return;
      }
      assert.fail(`jekyll build failed (exit ${result.status}): ${stderr}`);
    }
    assert.ok(
      !existsSync(join(destination, "_legacy")),
      "_site/_legacy/ must not exist — _legacy is excluded from publishing",
    );
    // A still-quarantined slug must not publish its original page body.
    // The docs redesign keeps historical permalinks live as redirect stubs
    // (jekyll-redirect-from) so external links don't 404, but only the small
    // meta-refresh stub is allowed — never the quarantined prose.
    //
    // /hooks, /artifacts, /libraries, /setup, /testing have been recreated as
    // live greenfield how-to pages (task 4), so they are no longer quarantined
    // — their redirect_from still emits a stub, but it points at the new live
    // page rather than masking quarantined prose. /getting-started remains
    // quarantined (its replacement tutorial lands in task 6) and is the
    // canonical probe here.
    const gsProbes = [
      join(destination, "getting-started.html"),
      join(destination, "getting-started", "index.html"),
    ];
    let sawGs = false;
    for (const probe of gsProbes) {
      if (!existsSync(probe)) continue;
      sawGs = true;
      const html = readFileSync(probe, "utf8");
      assert.match(
        html,
        /<meta\s+http-equiv="refresh"/i,
        `${probe}: quarantined slug /getting-started must publish only a redirect stub, not page content`,
      );
      assert.ok(
        !/VS Code extension/i.test(html),
        `${probe}: quarantined getting-started.md content leaked into _site`,
      );
    }
    assert.ok(
      sawGs,
      "expected a redirect stub at /getting-started (jekyll-redirect-from for the quarantined slug)",
    );
    // Sanity: a live page is still built.
    assert.ok(
      existsSync(join(destination, "architecture", "index.html")) ||
        existsSync(join(destination, "architecture.html")) ||
        existsSync(join(destination, "architecture")),
      "live /architecture page should still be built",
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
