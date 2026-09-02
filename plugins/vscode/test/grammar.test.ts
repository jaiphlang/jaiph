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
    ["def", "storage.type.def.jaiph"],
    ["export", "storage.modifier.jaiph"],
    ["script", "storage.type.script.jaiph"],
    ["channel", "storage.type.channel.jaiph"],
    ["use", "keyword.control.use.jaiph"],
    ["GITHUB_TOKEN", "variable.other.env.jaiph"],
    ["NPM_TOKEN", "variable.other.env.jaiph"],
    ["analyze", "entity.name.function.prompt.jaiph"],
    ["describe", "entity.name.function.prompt.jaiph"],
    ["helper", "entity.name.function.def.jaiph"],
    ["prompt", "storage.type.prompt.jaiph"],
    ["gh", "entity.name.namespace.jaiph"],
    // Command keywords (including ones the old extension never knew)
    ["run", "keyword.control.command.jaiph"],
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
    ["send", "keyword.control.command.jaiph"],
    ["->", "keyword.operator.send.jaiph"],
    ["->", "keyword.operator.route.jaiph"],
    ["handler", "entity.name.function.def.jaiph"],
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
  for (const stale of ["wait", "local", "rule", "workflow", "ensure", "inbox"]) {
    assert.ok(
      !hasScope(t, stale, "keyword.control.command.jaiph"),
      `\`${stale}\` must not be scoped as a command keyword`,
    );
    assert.ok(
      !hasScope(t, stale, "storage.type.def.jaiph"),
      `\`${stale}\` must not be scoped as a def keyword`,
    );
    assert.ok(
      !hasScope(t, stale, "storage.modifier.jaiph"),
      `\`${stale}\` must not be scoped as a modifier`,
    );
  }
  assert.ok(
    !hasScope(t, "inbox", "keyword.control.inbox.jaiph"),
    "`inbox` is a channel name, not a send keyword",
  );
  assert.ok(
    hasScope(t, "inbox", "variable.other.channel.jaiph"),
    "`send … -> inbox` should highlight inbox as a channel",
  );
  // Stale config keys must not be scoped as config properties.
  for (const stale of [
    "agent.default_model",
    "runtime.docker_enabled",
    "runtime.docker_image",
    "runtime.docker_timeout_seconds",
    "trusted_envs",
  ]) {
    assert.ok(
      !hasScope(t, stale, "variable.other.property.jaiph"),
      `stale config key ${stale} must not be scoped as a config property`,
    );
  }
});
