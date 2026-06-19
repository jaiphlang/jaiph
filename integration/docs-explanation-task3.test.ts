import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Task 3 acceptance: Explanation quadrant pages exist, the sandboxing
// explanation is understanding-oriented (threat model present, enabling
// procedure + config-key table absent), and the four pages are reachable
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

function bodyWithoutFrontMatter(source: string): string {
  const m = source.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? source.slice(m[0].length) : source;
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
  { file: "sandboxing.md", permalink: "/sandboxing", label: "Sandboxing" },
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

test("task-3: sandboxing explanation contains threat-model content", () => {
  const body = bodyWithoutFrontMatter(readPage("sandboxing.md")).toLowerCase();
  // A real threat-model section must call out both halves of the boundary.
  assert.ok(
    /what docker protects against/.test(body),
    "sandboxing.md must explicitly describe what the Docker sandbox protects against",
  );
  assert.ok(
    /what docker does \*\*not\*\* protect against|what docker does not protect against/.test(
      body,
    ),
    "sandboxing.md must explicitly describe what the Docker sandbox does NOT protect against",
  );
  // Each side must mention at least one concrete claim from the source-grounded list.
  assert.ok(
    /cap-drop all|--cap-drop all|capabilities dropped|capability surface/.test(body),
    "sandboxing.md threat-model must mention dropped capabilities",
  );
  assert.ok(
    /allowlist/.test(body),
    "sandboxing.md threat-model must mention the env-var allowlist",
  );
  assert.ok(
    /hooks run on the host|hooks.*host/.test(body),
    "sandboxing.md must call out that hooks run on the host (a deliberate non-protection)",
  );
  assert.ok(
    /network egress/.test(body),
    "sandboxing.md must call out default-on network egress (a deliberate non-protection)",
  );
});

test("task-3: sandboxing explanation has no 'Enabling Docker' procedure heading", () => {
  const body = bodyWithoutFrontMatter(readPage("sandboxing.md"));
  // The enabling procedure was a numbered/step-driven section in the legacy
  // page; it moves to a how-to in task 4 and must not survive in the
  // understanding-oriented explanation.
  const headingRe = /^#{2,4}\s+Enabling Docker\b/im;
  assert.ok(
    !headingRe.test(body),
    "sandboxing.md must not contain an 'Enabling Docker' heading — that procedure belongs in a how-to (task 4)",
  );
  // Same constraint phrased structurally: no numbered list under a heading
  // that includes the word 'enabling' or 'enable'.
  const lines = body.split("\n");
  let inSuspectSection = false;
  for (const line of lines) {
    const h = line.match(/^(#{2,4})\s+(.+)$/);
    if (h) {
      inSuspectSection = /enabl/i.test(h[2]);
      continue;
    }
    if (inSuspectSection && /^\s*1\.\s+/.test(line)) {
      assert.fail(
        "sandboxing.md contains a numbered enabling procedure under an 'enable*' heading — that belongs in a how-to (task 4)",
      );
    }
  }
});

test("task-3: sandboxing explanation has no config-key reference table", () => {
  const body = bodyWithoutFrontMatter(readPage("sandboxing.md"));
  // Reference key tables follow the shape `| Key | Type | Default | …` or list
  // backtick-wrapped `runtime.docker_*` keys in a markdown table row.
  const keyHeaderRe = /^\|\s*Key\s*\|/im;
  assert.ok(
    !keyHeaderRe.test(body),
    "sandboxing.md must not contain a '| Key | …' reference table — config keys belong in the reference (task 5)",
  );
  const runtimeKeyRowRe = /^\|\s*`runtime\.docker_[a-z_]+`\s*\|/im;
  assert.ok(
    !runtimeKeyRowRe.test(body),
    "sandboxing.md must not contain a table row listing `runtime.docker_*` keys — that belongs in the reference (task 5)",
  );
  // A "Configuration keys" or "Failure modes" reference heading is the same
  // kind of bleed and is also out of scope for an explanation page.
  assert.ok(
    !/^#{2,4}\s+Configuration keys\b/im.test(body),
    "sandboxing.md must not contain a 'Configuration keys' section — reference content lives elsewhere (task 5)",
  );
  assert.ok(
    !/^#{2,4}\s+Failure modes\b/im.test(body),
    "sandboxing.md must not contain a 'Failure modes' section — reference content lives elsewhere (task 5)",
  );
});
