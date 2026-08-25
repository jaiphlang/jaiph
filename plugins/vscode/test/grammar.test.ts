import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeFixture, hasScope } from "./tmgrammar";

// Each assertion pins a construct that exists in the CURRENT .jh grammar
// (docs/grammar.md + parser sources), so the test breaks if the shipped
// TextMate grammar drifts away from the language.

test("current .jh constructs highlight with the expected scopes", async () => {
  const t = await tokenizeFixture("current.jh");
  const expect: Array<[string, string]> = [
    // Definitions and modifiers
    ["workflow", "storage.type.workflow.jaiph"],
    ["rule", "storage.type.rule.jaiph"],
    ["export", "storage.modifier.jaiph"],
    ["script", "storage.type.script.jaiph"],
    ["channel", "storage.type.channel.jaiph"],
    // Command keywords (including ones the old extension never knew)
    ["run", "keyword.control.command.jaiph"],
    ["ensure", "keyword.control.command.jaiph"],
    ["prompt", "keyword.control.command.jaiph"],
    ["logwarn", "keyword.control.command.jaiph"],
    ["catch", "keyword.control.command.jaiph"],
    ["recover", "keyword.control.command.jaiph"],
    ["fail", "keyword.control.command.jaiph"],
    ["return", "keyword.control.command.jaiph"],
    ["async", "keyword.control.async.jaiph"],
    // Control flow
    ["if", "keyword.control.conditional.jaiph"],
    ["for", "keyword.control.loop.jaiph"],
    ["in", "keyword.control.loop.jaiph"],
    ["match", "keyword.control.match.jaiph"],
    ["=>", "keyword.operator.arrow.jaiph"],
    ["_", "constant.language.wildcard.jaiph"],
    // Channels
    ["<-", "keyword.operator.send.jaiph"],
    ["->", "keyword.operator.route.jaiph"],
    // Current config keys
    ["agent.model", "variable.other.property.jaiph"],
    ["run.recover_limit", "variable.other.property.jaiph"],
    ["module.name", "variable.other.property.jaiph"],
    // Prompt returns schema
    ["returns", "keyword.control.returns.jaiph"],
  ];
  for (const [text, scope] of expect) {
    assert.ok(hasScope(t, text, scope), `expected "${text}" to have scope ${scope}`);
  }
});

test("current *.test.jh test-block keywords highlight", async () => {
  const t = await tokenizeFixture("current.test.jh");
  const expect: Array<[string, string]> = [
    ["test", "storage.type.test.jaiph"],
    ["mock", "keyword.control.test.jaiph"],
    ["allow_failure", "keyword.control.test.jaiph"],
    ["expect_contain", "keyword.other.assertion.jaiph"],
    ["expect_not_contain", "keyword.other.assertion.jaiph"],
    ["expect_equal", "keyword.other.assertion.jaiph"],
  ];
  for (const [text, scope] of expect) {
    assert.ok(hasScope(t, text, scope), `expected "${text}" to have scope ${scope}`);
  }
});

test("stale surface from the old extension is not highlighted", async () => {
  // Regression: keys/keywords the old extension assumed no longer exist. If the
  // grammar re-adds any of them, these fail.
  const t = await tokenizeFixture("regression.jh");
  // `wait` was removed from the language (E_PARSE).
  assert.ok(
    !hasScope(t, "wait", "keyword.control.command.jaiph"),
    "`wait` must not be scoped as a command keyword",
  );
  // Stale config keys must not be scoped as config properties.
  for (const stale of [
    "agent.default_model",
    "runtime.docker_enabled",
    "runtime.docker_image",
    "runtime.docker_timeout_seconds",
  ]) {
    assert.ok(
      !hasScope(t, stale, "variable.other.property.jaiph"),
      `stale config key ${stale} must not be scoped as a config property`,
    );
  }
});
