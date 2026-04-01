import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { INTERPRETER_TAGS } from "./scripts";

// === Accepted: script:<tag> syntax ===

test("script:node parses with interpreterTag and correct shebang", () => {
  const mod = parsejaiph("script:node transform {\n  console.log('hi');\n}", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "transform");
  assert.equal(mod.scripts[0].interpreterTag, "node");
  assert.equal(mod.scripts[0].shebang, "#!/usr/bin/env node");
  assert.deepEqual(mod.scripts[0].commands, ["console.log('hi');"]);
});

test("script:python3 parses with interpreterTag and correct shebang", () => {
  const mod = parsejaiph("script:python3 analyze {\n  print('hello')\n}", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "analyze");
  assert.equal(mod.scripts[0].interpreterTag, "python3");
  assert.equal(mod.scripts[0].shebang, "#!/usr/bin/env python3");
  assert.deepEqual(mod.scripts[0].commands, ["print('hello')"]);
});

test("script:bash sets bash shebang via tag", () => {
  const mod = parsejaiph("script:bash setup {\n  echo hello\n}", "test.jh");
  assert.equal(mod.scripts[0].interpreterTag, "bash");
  assert.equal(mod.scripts[0].shebang, "#!/usr/bin/env bash");
});

test("all supported tags produce correct shebangs", () => {
  for (const [tag, shebang] of Object.entries(INTERPRETER_TAGS)) {
    const mod = parsejaiph(`script:${tag} test_${tag} {\n  body\n}`, "test.jh");
    assert.equal(mod.scripts[0].shebang, shebang, `tag ${tag}`);
    assert.equal(mod.scripts[0].interpreterTag, tag);
  }
});

test("plain script without tag has no interpreterTag", () => {
  const mod = parsejaiph("script setup {\n  echo hello\n}", "test.jh");
  assert.equal(mod.scripts[0].interpreterTag, undefined);
  assert.equal(mod.scripts[0].shebang, undefined);
});

test("plain script with manual shebang still works", () => {
  const mod = parsejaiph("script analyze {\n  #!/usr/bin/env python3\n  print('hi')\n}", "test.jh");
  assert.equal(mod.scripts[0].interpreterTag, undefined);
  assert.equal(mod.scripts[0].shebang, "#!/usr/bin/env python3");
});

// === Rejected: unknown tag ===

test("unknown script:foo tag is rejected with actionable error", () => {
  assert.throws(
    () => parsejaiph("script:foo my_script {\n  body\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes('unknown interpreter tag "script:foo"') &&
      err.message.includes("supported tags:"),
  );
});

// === Rejected: script:tag with manual shebang in body ===

test("script:node with manual shebang is rejected", () => {
  assert.throws(
    () => parsejaiph("script:node transform {\n  #!/usr/bin/env node\n  console.log('hi');\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script:node already sets the shebang"),
  );
});

// === Rejected: script:tag with parentheses ===

test("script:node with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph("script:node transform() {", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses"),
  );
});

// === Rejected: script:tag without braces ===

test("script:node without braces is rejected", () => {
  assert.throws(
    () => parsejaiph("script:node transform", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("script declarations require braces"),
  );
});
