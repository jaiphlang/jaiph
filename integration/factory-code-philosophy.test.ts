import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Acceptance: the overnight engineer factory (`.jaiph/engineer.jh`) embeds a
// `code_philosophy` string that implementers follow. It must stay in sync with
// the agent-analyzability ADR (`docs/agent-analyzability.md`) so implementers
// see the import-graph rules and run the CI arch gate. This test fails if the
// embedded philosophy stops pointing at the ADR or the `arch:check` script, and
// if AGENT.md stops pointing at the ADR.

const REPO_ROOT = process.cwd();
const ENGINEER = join(REPO_ROOT, ".jaiph", "engineer.jh");
const AGENT_MD = join(REPO_ROOT, "AGENT.md");

// Extract the `const code_philosophy = """ ... """` block so the assertions
// bind to the philosophy an implementer actually reads, not to any incidental
// mention elsewhere in the workflow file.
function readCodePhilosophy(): string {
  const source = readFileSync(ENGINEER, "utf8");
  const m = source.match(/const code_philosophy = """([\s\S]*?)"""/);
  assert.ok(
    m,
    `.jaiph/engineer.jh must define a triple-quoted 'code_philosophy' string`,
  );
  return m![1];
}

test("engineer factory code_philosophy points at the agent-analyzability ADR", () => {
  const philosophy = readCodePhilosophy();
  assert.match(
    philosophy,
    /agent-analyzability/,
    "code_philosophy must reference docs/agent-analyzability.md so implementers read the import-graph rules",
  );
});

test("engineer factory code_philosophy requires the arch:check gate", () => {
  const philosophy = readCodePhilosophy();
  assert.match(
    philosophy,
    /arch:check/,
    "code_philosophy must tell implementers to run npm run arch:check alongside build/test",
  );
});

test("AGENT.md still points at the agent-analyzability ADR", () => {
  const agent = readFileSync(AGENT_MD, "utf8");
  assert.match(
    agent,
    /docs\/agent-analyzability\.md/,
    "AGENT.md must link docs/agent-analyzability.md as the import-graph source of truth",
  );
});
