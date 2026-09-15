import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ADR 0003 (design/0003-docs-one-fact-one-owner.md) remediation: the server and
// auth how-tos had grown into inventories that restate facts owned by cli.md,
// env-vars.md, and configuration.md. A how-to is numbered steps plus links, so
// each of these pages has a tight body-line cap. The caps are below today's
// body sizes on purpose, so a page that regrows an inventory fails this test.
//
// Body line = a line after the front-matter block, with leading/trailing blank
// lines trimmed (the same accounting integration/docs-structure.test.ts uses).

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");

interface Cap {
  file: string;
  max: number;
  // A markdown link to at least one of these owner pages must appear in the
  // body, so the recipe points at the inventory owner instead of restating it.
  owners: string[];
}

const CAPS: Cap[] = [
  { file: "mcp.md", max: 80, owners: ["cli.md", "env-vars.md"] },
  { file: "serve.md", max: 90, owners: ["cli.md", "env-vars.md"] },
  { file: "observability.md", max: 100, owners: ["env-vars.md"] },
  { file: "agent-auth.md", max: 100, owners: ["cli.md", "env-vars.md"] },
];

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

// Strip a leading `--- ... ---` front-matter block and return the remaining
// body. Mirrors integration/docs-structure.test.ts's parser.
function stripFrontMatter(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const lines = normalized.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return normalized;
}

function countBodyLines(body: string): number {
  const lines = body.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length;
}

test("how-to caps: each server/auth recipe body stays under its line cap", () => {
  for (const cap of CAPS) {
    const body = stripFrontMatter(readPage(cap.file));
    const n = countBodyLines(body);
    assert.ok(
      n <= cap.max,
      `${cap.file}: body has ${n} lines, over the ${cap.max}-line cap — cut restated inventories and link to the owner (ADR 0003)`,
    );
  }
});

test("how-to caps: each recipe keeps numbered steps and a Verification heading", () => {
  for (const cap of CAPS) {
    const body = stripFrontMatter(readPage(cap.file));
    assert.ok(
      /^##\s+\d\.\s+/im.test(body) || /^###\s+\d\.\s+/im.test(body),
      `${cap.file}: must keep at least one numbered step heading (## N. or ### N.)`,
    );
    assert.ok(
      /^##\s+Verification\b/im.test(body) || /^##\s+Verify(\b|ication\b)/im.test(body),
      `${cap.file}: must keep a '## Verification' (or '## Verify') heading`,
    );
  }
});

test("how-to caps: each recipe links to its inventory owner", () => {
  for (const cap of CAPS) {
    const body = stripFrontMatter(readPage(cap.file));
    const linked = cap.owners.some((owner) =>
      new RegExp(`\\]\\([^)]*${owner.replace(".", "\\.")}[^)]*\\)`).test(body),
    );
    assert.ok(
      linked,
      `${cap.file}: must contain a markdown link to one of its owners (${cap.owners.join(", ")})`,
    );
  }
});
