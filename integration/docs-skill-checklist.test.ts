import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ADR 0003 (design/0003-docs-one-fact-one-owner.md): docs/jaiph-skill.md is an
// agent checklist, not a third language book. It ships inside the binary
// (src/runtime/embedded-assets.ts) and is read by external projects, so every
// restated rule is paid by every `jaiph init` and standalone build. These
// guards keep it a checklist: a hard body-line cap, the required anchors, and
// a ban on owner-owned strings that only belong on their owner pages.
// Owner links must be absolute https://jaiph.org/… URLs — this file is
// published independently of the Jaiph repo.

const REPO_ROOT = process.cwd();
const SKILL_PATH = join(REPO_ROOT, "docs", "jaiph-skill.md");

// Same front-matter strip + body-line count as integration/docs-structure.ts:
// drop the `---`-delimited front matter, then trim leading/trailing blank
// lines so a single trailing newline does not inflate the count.
function bodyLines(source: string): string[] {
  const normalized = source.replace(/\r\n/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        body = lines.slice(i + 1).join("\n");
        break;
      }
    }
  }
  const lines = body.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

const BODY_LINE_CAP = 120;

const OWNER_URLS = [
  "https://jaiph.org/reference/language",
  "https://jaiph.org/reference/grammar",
  "https://jaiph.org/reference/cli",
  "https://jaiph.org/reference/env-vars",
  "https://jaiph.org/how-to/testing",
  "https://jaiph.org/reference/configuration",
];

test("jaiph-skill.md body is at most 120 lines (checklist, not a language book)", () => {
  const n = bodyLines(readFileSync(SKILL_PATH, "utf8")).length;
  assert.ok(
    n <= BODY_LINE_CAP,
    `docs/jaiph-skill.md body has ${n} lines, over the ${BODY_LINE_CAP}-line checklist cap — cut restated inventories and link to the owner page instead`,
  );
});

test("jaiph-skill.md keeps the H1, a jaiph example with export def main, and owner links", () => {
  const body = bodyLines(readFileSync(SKILL_PATH, "utf8")).join("\n");
  assert.match(body, /^# Jaiph Skill \(for Agents\)$/m, "missing H1");
  assert.match(
    body,
    /```jaiph[\s\S]*export def main[\s\S]*```/,
    "missing fenced jaiph example containing `export def main`",
  );
  for (const url of OWNER_URLS) {
    assert.ok(body.includes(url), `missing absolute owner URL ${url}`);
  }
  assert.doesNotMatch(
    body,
    /\]\((?:\.\.\/)?(?:docs\/)?(?:language|grammar|cli|env-vars|testing|configuration)\.md/,
    "owner links must be https://jaiph.org/… URLs, not repo-relative paths (this skill is published independently)",
  );
  assert.doesNotMatch(
    body,
    /\]\(\/(?:reference|how-to)\//,
    "owner links must include the https://jaiph.org host, not a site-root-relative href",
  );
});

test("jaiph-skill.md does not restate owner-owned strings", () => {
  const body = bodyLines(readFileSync(SKILL_PATH, "utf8")).join("\n");
  for (const owned of ["E_ENV_RESERVED", "JAIPH_NON_TTY_HEARTBEAT", "StepDef", "Handle<T>"]) {
    assert.ok(
      !body.includes(owned),
      `docs/jaiph-skill.md restates '${owned}' — state it on its owner page and link instead (ADR 0003)`,
    );
  }
});
