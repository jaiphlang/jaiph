import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The workflows under .jaiph/ carry prompts that tell agents where code and
// tests live. A stale path sends an agent to create a tree nothing runs
// (for example `test/` or `compiler-tests/`). These tests pin the prompt text
// to the repository layout and to docs/architecture.md.

const REPO_ROOT = process.cwd();
const WORKFLOW_DIR = join(REPO_ROOT, ".jaiph");
const ROOTS = "src|integration|e2e|docs|test-fixtures|test-infra|design|scripts|tools|test|compiler-tests";
const PATH_RE = new RegExp(`(?<![A-Za-z0-9_./-])(?:${ROOTS})/[A-Za-z0-9_./*<>-]*`, "g");

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".jh"))
    .map((name) => join(WORKFLOW_DIR, name));
}

/** Workflow sources only: `*.test.jh` files pass made-up paths as test inputs. */
function workflowSources(): string[] {
  return workflowFiles().filter((file) => !file.endsWith(".test.jh"));
}

/** The part of a path before any glob or placeholder, without a trailing dot or slash. */
function concretePrefix(path: string): string {
  const cut = path.search(/[*<]/);
  const head = cut === -1 ? path : path.slice(0, path.lastIndexOf("/", cut) + 1);
  return head.replace(/[./]+$/, "");
}

test("repo paths named in .jaiph workflows exist", () => {
  const missing: string[] = [];
  for (const file of workflowSources()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.match(PATH_RE) ?? []) {
      const prefix = concretePrefix(match);
      if (!existsSync(join(REPO_ROOT, prefix))) {
        missing.push(`${file.slice(REPO_ROOT.length + 1)}: ${match}`);
      }
    }
  }
  assert.deepEqual(missing, [], "these paths do not exist in the repository");
});

test("no workflow or docs page says Jaiph transpiles to Bash", () => {
  const offenders: string[] = [];
  const docs = readdirSync(join(REPO_ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(REPO_ROOT, "docs", name));
  for (const file of [...workflowFiles(), ...docs]) {
    if (/transpiles to bash/i.test(readFileSync(file, "utf8"))) {
      offenders.push(file.slice(REPO_ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], "the kernel interprets the AST; see docs/architecture.md");
});
