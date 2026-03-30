import test from "node:test";
import assert from "node:assert/strict";
import {
  forEachCommandSubstitution,
  validateSubstitutionInner,
  validateNoJaiphCommandSubstitution,
  validateManagedWorkflowShell,
  type SubstitutionValidateEnv,
} from "./validate-substitution";

function makeEnv(overrides?: Partial<SubstitutionValidateEnv>): SubstitutionValidateEnv {
  return {
    filePath: "test.jh",
    loc: { line: 1, col: 1 },
    localRules: new Set<string>(),
    localWorkflows: new Set<string>(),
    localScripts: new Set<string>(),
    importsByAlias: new Map<string, string>(),
    lookupImported: () => undefined,
    ...overrides,
  };
}

// --- forEachCommandSubstitution ---

test("forEachCommandSubstitution: finds simple $(cmd)", () => {
  const found: string[] = [];
  forEachCommandSubstitution("echo $(date)", (inner) => found.push(inner));
  assert.deepStrictEqual(found, ["date"]);
});

test("forEachCommandSubstitution: finds multiple substitutions", () => {
  const found: string[] = [];
  forEachCommandSubstitution("$(foo) and $(bar)", (inner) => found.push(inner));
  assert.deepStrictEqual(found, ["foo", "bar"]);
});

test("forEachCommandSubstitution: skips arithmetic $(( ... ))", () => {
  const found: string[] = [];
  forEachCommandSubstitution("echo $((1+2))", (inner) => found.push(inner));
  assert.deepStrictEqual(found, []);
});

test("forEachCommandSubstitution: skips $(...) inside single quotes", () => {
  const found: string[] = [];
  forEachCommandSubstitution("echo '$(cmd)'", (inner) => found.push(inner));
  assert.deepStrictEqual(found, []);
});

test("forEachCommandSubstitution: finds $(...) inside double quotes", () => {
  const found: string[] = [];
  forEachCommandSubstitution('echo "$(cmd)"', (inner) => found.push(inner));
  assert.deepStrictEqual(found, ["cmd"]);
});

test("forEachCommandSubstitution: handles nested substitutions", () => {
  const found: string[] = [];
  forEachCommandSubstitution("$(echo $(inner))", (inner) => found.push(inner));
  assert.deepStrictEqual(found, ["echo $(inner)"]);
});

test("forEachCommandSubstitution: no substitutions in plain text", () => {
  const found: string[] = [];
  forEachCommandSubstitution("echo hello world", (inner) => found.push(inner));
  assert.deepStrictEqual(found, []);
});

// --- validateSubstitutionInner ---

test("validateSubstitutionInner: allows plain shell commands", () => {
  validateSubstitutionInner("echo hello", makeEnv());
  validateSubstitutionInner("date +%s", makeEnv());
});

test("validateSubstitutionInner: rejects 'run' keyword", () => {
  assert.throws(
    () => validateSubstitutionInner("run deploy", makeEnv()),
    /cannot use Jaiph keywords "run" or "ensure"/,
  );
});

test("validateSubstitutionInner: rejects 'ensure' keyword", () => {
  assert.throws(
    () => validateSubstitutionInner("ensure check", makeEnv()),
    /cannot use Jaiph keywords "run" or "ensure"/,
  );
});

test("validateSubstitutionInner: rejects local rule", () => {
  const env = makeEnv({ localRules: new Set(["my_rule"]) });
  assert.throws(
    () => validateSubstitutionInner("my_rule arg", env),
    /cannot invoke rule "my_rule"/,
  );
});

// --- validateNoJaiphCommandSubstitution ---

test("validateNoJaiphCommandSubstitution: allows text without substitutions", () => {
  validateNoJaiphCommandSubstitution("echo hello", makeEnv());
});

test("validateNoJaiphCommandSubstitution: allows plain shell in $()", () => {
  validateNoJaiphCommandSubstitution("echo $(date)", makeEnv());
});

test("validateNoJaiphCommandSubstitution: rejects Jaiph keyword in $()", () => {
  assert.throws(
    () => validateNoJaiphCommandSubstitution("x=$(run deploy)", makeEnv()),
    /cannot use Jaiph keywords "run" or "ensure"/,
  );
});

test("validateNoJaiphCommandSubstitution: rejects rule in $()", () => {
  const env = makeEnv({ localRules: new Set(["check"]) });
  assert.throws(
    () => validateNoJaiphCommandSubstitution("x=$(check arg)", env),
    /cannot invoke rule "check"/,
  );
});

// --- validateManagedWorkflowShell ---

test("validateManagedWorkflowShell: allows plain shell", () => {
  validateManagedWorkflowShell("echo hello", makeEnv());
});

test("validateManagedWorkflowShell: rejects rule as leading command", () => {
  const env = makeEnv({ localRules: new Set(["my_rule"]) });
  assert.throws(
    () => validateManagedWorkflowShell("my_rule arg", env),
    /rule "my_rule" must be called with ensure/,
  );
});

test("validateManagedWorkflowShell: rejects Jaiph keyword in $() inside managed shell", () => {
  assert.throws(
    () => validateManagedWorkflowShell("echo $(run deploy)", makeEnv()),
    /cannot use Jaiph keywords "run" or "ensure"/,
  );
});

test("validateManagedWorkflowShell: rejects workflow as leading command", () => {
  const env = makeEnv({ localWorkflows: new Set(["deploy"]) });
  assert.throws(
    () => validateManagedWorkflowShell("deploy arg", env),
    /workflow "deploy" must be called with run/,
  );
});
