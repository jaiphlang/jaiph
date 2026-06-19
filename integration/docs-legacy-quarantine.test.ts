import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const LEGACY_DIR = join(DOCS_DIR, "_legacy");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

const LIVE_PAGES = ["architecture.md", "jaiph-skill.md"];
const QUARANTINED_PAGES = [
  "artifacts.md",
  "cli.md",
  "configuration.md",
  "contributing.md",
  "getting-started.md",
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

  const quarantinedSlugs = new Set(QUARANTINED_PAGES.map((p) => "/" + p.replace(/\.md$/, "")));
  for (const link of permalinks) {
    if (link === "/" || link === "") continue;
    assert.ok(
      !quarantinedSlugs.has(link),
      `nav points at quarantined page ${link} — remove it from docs/_layouts/docs.html`,
    );
    // Resolve to an on-disk source page that still lives under docs/ (not _legacy).
    const slug = link.replace(/^\//, "");
    const candidates = [
      join(DOCS_DIR, `${slug}.md`),
      join(DOCS_DIR, `${slug}.html`),
      join(DOCS_DIR, slug, "index.md"),
      join(DOCS_DIR, slug, "index.html"),
    ];
    assert.ok(
      candidates.some((p) => existsSync(p)),
      `nav link ${link} has no live source page in docs/ (tried ${candidates.join(", ")})`,
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
    // A quarantined permalink (sandboxing was /sandboxing) must not be generated.
    assert.ok(
      !existsSync(join(destination, "sandboxing")) &&
        !existsSync(join(destination, "sandboxing.html")) &&
        !existsSync(join(destination, "sandboxing", "index.html")),
      "quarantined page /sandboxing must not appear in built _site",
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
