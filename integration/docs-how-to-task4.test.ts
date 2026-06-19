import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Task 4 acceptance: How-to quadrant pages exist as task-oriented recipes, each
// with `diataxis: how-to`, a `/how-to/...` permalink, the right `redirect_from`
// for any retired slug, and a nav entry. The agent-auth recipe additionally
// must name every backend credential and the credential-pre-flight error code
// — that contract comes from src/cli/run/preflight-credentials.ts.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const NAV_LAYOUT = join(DOCS_DIR, "_layouts", "docs.html");

interface HowToPage {
  /** File under docs/ (immediate child). */
  file: string;
  /** Expected `permalink:` value. */
  permalink: string;
  /** Old/retired permalinks that must appear under `redirect_from:` (`[]` if none). */
  redirectFrom: string[];
  /** Nav label substring used to grep the nav entry's anchor. */
  navPermalink: string;
}

const HOW_TO_PAGES: HowToPage[] = [
  {
    file: "setup.md",
    permalink: "/how-to/install",
    redirectFrom: ["/setup"],
    navPermalink: "/how-to/install",
  },
  {
    file: "sandbox-run.md",
    permalink: "/how-to/sandbox-run",
    redirectFrom: [],
    navPermalink: "/how-to/sandbox-run",
  },
  {
    file: "agent-auth.md",
    permalink: "/how-to/agent-auth",
    redirectFrom: [],
    navPermalink: "/how-to/agent-auth",
  },
  {
    file: "configure-backend.md",
    permalink: "/how-to/configure-backend",
    redirectFrom: [],
    navPermalink: "/how-to/configure-backend",
  },
  {
    file: "hooks.md",
    permalink: "/how-to/hooks",
    redirectFrom: ["/hooks"],
    navPermalink: "/how-to/hooks",
  },
  {
    file: "libraries.md",
    permalink: "/how-to/libraries",
    redirectFrom: ["/libraries"],
    navPermalink: "/how-to/libraries",
  },
  {
    file: "artifacts.md",
    permalink: "/how-to/artifacts",
    redirectFrom: ["/artifacts"],
    navPermalink: "/how-to/artifacts",
  },
  {
    file: "testing.md",
    permalink: "/how-to/testing",
    redirectFrom: ["/testing"],
    navPermalink: "/how-to/testing",
  },
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

test("task-4: every how-to page declares 'diataxis: how-to' and the expected permalink", () => {
  for (const page of HOW_TO_PAGES) {
    const fm = frontMatterBlock(readPage(page.file));
    assert.ok(fm, `${page.file}: missing front-matter block`);
    assert.equal(
      frontMatterScalar(fm!, "diataxis"),
      "how-to",
      `${page.file}: must declare 'diataxis: how-to'`,
    );
    assert.equal(
      frontMatterScalar(fm!, "permalink"),
      page.permalink,
      `${page.file}: must declare 'permalink: ${page.permalink}'`,
    );
  }
});

test("task-4: every retired permalink is absorbed by the new how-to page's redirect_from", () => {
  for (const page of HOW_TO_PAGES) {
    if (page.redirectFrom.length === 0) continue;
    const fm = frontMatterBlock(readPage(page.file));
    assert.ok(fm, `${page.file}: missing front-matter block`);
    const declared = frontMatterList(fm!, "redirect_from");
    for (const slug of page.redirectFrom) {
      assert.ok(
        declared.includes(slug),
        `${page.file}: redirect_from must include '${slug}' so the retired permalink keeps resolving (declared: ${declared.join(", ") || "<none>"})`,
      );
    }
  }
});

test("task-4: every how-to page is reachable from the nav exactly once", () => {
  const nav = readFileSync(NAV_LAYOUT, "utf8");
  const linkRe = /<a\s+href="\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}"/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(nav)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const page of HOW_TO_PAGES) {
    const count = counts.get(page.navPermalink) ?? 0;
    assert.equal(
      count,
      1,
      `nav must link to ${page.navPermalink} exactly once (found ${count})`,
    );
  }
});

test("task-4: agent-auth how-to names every backend credential and the pre-flight error code", () => {
  // The pre-flight implementation is src/cli/run/preflight-credentials.ts; the
  // recipe must name every credential it checks plus the stable error code so
  // a user hitting that error can find the page by searching for the literal.
  const body = readPage("agent-auth.md");
  const required = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CURSOR_API_KEY",
    "OPENAI_API_KEY",
    "E_AGENT_CREDENTIALS",
  ];
  for (const literal of required) {
    assert.ok(
      body.includes(literal),
      `agent-auth.md must mention the literal '${literal}' (matches the credential pre-flight in src/cli/run/preflight-credentials.ts)`,
    );
  }
  // Also assert that claude's setup-token instruction is present, since that
  // is the documented path for obtaining a CLAUDE_CODE_OAUTH_TOKEN.
  assert.ok(
    /claude setup-token/.test(body),
    "agent-auth.md must show `claude setup-token` as the way to obtain CLAUDE_CODE_OAUTH_TOKEN",
  );
});

test("task-4: how-to pages stay recipe-shaped (goal → numbered steps → verification)", () => {
  // A recipe is identifiable by numbered steps and a verification section.
  // This is a structural sanity check — fail if a page drifted back into
  // open-ended prose without a verifiable conclusion.
  for (const page of HOW_TO_PAGES) {
    const body = readPage(page.file);
    assert.ok(
      /^##\s+Verification\b/im.test(body) ||
        /^##\s+Verify(\b|ication\b)/im.test(body),
      `${page.file}: how-to recipe must include a 'Verification' (or 'Verify') section`,
    );
    assert.ok(
      /^##\s+\d\.\s+/im.test(body) || /^###\s+\d\.\s+/im.test(body),
      `${page.file}: how-to recipe must include at least one numbered step heading`,
    );
  }
});
