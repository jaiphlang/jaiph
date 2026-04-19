import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyJaiphShellRefToken,
  assertKeywordFirstShellFragment,
  assertNoJaiphLeadCommandWord,
  type SubstitutionValidateEnv,
} from "./shell-jaiph-guard";

function makeEnv(overrides?: Partial<SubstitutionValidateEnv>): SubstitutionValidateEnv {
  return {
    filePath: "test.jh",
    loc: { line: 1, col: 1 },
    localWorkflows: new Set<string>(),
    localScripts: new Set<string>(),
    importsByAlias: new Map<string, string>(),
    lookupImported: () => undefined,
    ...overrides,
  };
}

// --- classifyJaiphShellRefToken ---

test("classifyJaiphShellRefToken: returns 'none' for empty token", () => {
  assert.equal(classifyJaiphShellRefToken("", makeEnv()), "none");
});

test("classifyJaiphShellRefToken: returns 'none' for echo", () => {
  assert.equal(classifyJaiphShellRefToken("echo", makeEnv()), "none");
});

test("classifyJaiphShellRefToken: returns 'none' for printf", () => {
  assert.equal(classifyJaiphShellRefToken("printf", makeEnv()), "none");
});

test("classifyJaiphShellRefToken: returns 'workflow' for local workflow", () => {
  const env = makeEnv({ localWorkflows: new Set(["deploy"]) });
  assert.equal(classifyJaiphShellRefToken("deploy", env), "workflow");
});

test("classifyJaiphShellRefToken: returns 'script' for local script", () => {
  const env = makeEnv({ localScripts: new Set(["build_it"]) });
  assert.equal(classifyJaiphShellRefToken("build_it", env), "script");
});

test("classifyJaiphShellRefToken: returns 'none' for unknown local name", () => {
  assert.equal(classifyJaiphShellRefToken("grep", makeEnv()), "none");
});

test("classifyJaiphShellRefToken: returns kind for imported symbol", () => {
  const env = makeEnv({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    lookupImported: (alias, name) => (alias === "lib" && name === "deploy" ? "workflow" : undefined),
  });
  assert.equal(classifyJaiphShellRefToken("lib.deploy", env), "workflow");
});

test("classifyJaiphShellRefToken: returns 'unknown' for missing imported symbol", () => {
  const env = makeEnv({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    lookupImported: () => undefined,
  });
  assert.equal(classifyJaiphShellRefToken("lib.missing", env), "unknown");
});

test("classifyJaiphShellRefToken: returns 'none' for unknown alias", () => {
  assert.equal(classifyJaiphShellRefToken("unknown.thing", makeEnv()), "none");
});

test("classifyJaiphShellRefToken: returns 'none' for three-part dotted name", () => {
  const env = makeEnv({ importsByAlias: new Map([["a", "a.jh"]]) });
  assert.equal(classifyJaiphShellRefToken("a.b.c", env), "none");
});

// --- assertKeywordFirstShellFragment ---

test("assertKeywordFirstShellFragment: rejects 'run' keyword", () => {
  assert.throws(
    () => assertKeywordFirstShellFragment("run my_wf", makeEnv()),
    /cannot use Jaiph keyword/,
  );
});

test("assertKeywordFirstShellFragment: rejects channel send operator", () => {
  assert.throws(
    () => assertKeywordFirstShellFragment("chan <- value", makeEnv()),
    /cannot contain channel send/,
  );
});

test("assertKeywordFirstShellFragment: allows send operator inside single quotes", () => {
  // '<-' inside single quotes should not be detected
  assertKeywordFirstShellFragment("echo '<-'", makeEnv());
});

test("assertKeywordFirstShellFragment: rejects local workflow as command", () => {
  const env = makeEnv({ localWorkflows: new Set(["deploy"]) });
  assert.throws(
    () => assertKeywordFirstShellFragment("deploy arg1", env),
    /cannot invoke workflow "deploy"/,
  );
});

test("assertKeywordFirstShellFragment: rejects local script as command", () => {
  const env = makeEnv({ localScripts: new Set(["build_it"]) });
  assert.throws(
    () => assertKeywordFirstShellFragment("build_it", env),
    /cannot invoke script "build_it"/,
  );
});

test("assertKeywordFirstShellFragment: rejects unknown imported symbol", () => {
  const env = makeEnv({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    lookupImported: () => undefined,
  });
  assert.throws(
    () => assertKeywordFirstShellFragment("lib.missing", env),
    /unknown imported symbol "lib.missing"/,
  );
});

test("assertKeywordFirstShellFragment: allows plain shell commands", () => {
  assertKeywordFirstShellFragment("echo hello", makeEnv());
  assertKeywordFirstShellFragment("grep -r pattern .", makeEnv());
  assertKeywordFirstShellFragment("cat file.txt | sort", makeEnv());
});

// --- assertNoJaiphLeadCommandWord ---

test("assertNoJaiphLeadCommandWord: rejects 'run' keyword", () => {
  assert.throws(
    () => assertNoJaiphLeadCommandWord("run something", makeEnv()),
    /cannot use Jaiph keyword/,
  );
});

test("assertNoJaiphLeadCommandWord: rejects workflow as leading command", () => {
  const env = makeEnv({ localWorkflows: new Set(["my_wf"]) });
  assert.throws(
    () => assertNoJaiphLeadCommandWord("my_wf arg", env),
    /workflow "my_wf" must be called with run/,
  );
});

test("assertNoJaiphLeadCommandWord: rejects script as leading command", () => {
  const env = makeEnv({ localScripts: new Set(["my_script"]) });
  assert.throws(
    () => assertNoJaiphLeadCommandWord("my_script", env),
    /direct script call "my_script"/,
  );
});

test("assertNoJaiphLeadCommandWord: rejects unknown imported symbol", () => {
  const env = makeEnv({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    lookupImported: () => undefined,
  });
  assert.throws(
    () => assertNoJaiphLeadCommandWord("lib.missing", env),
    /unknown imported symbol "lib.missing"/,
  );
});

test("assertNoJaiphLeadCommandWord: allows ordinary shell commands", () => {
  assertNoJaiphLeadCommandWord("ls -la", makeEnv());
  assertNoJaiphLeadCommandWord("git status", makeEnv());
});
