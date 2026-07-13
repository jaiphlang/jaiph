import test from "node:test";
import assert from "node:assert/strict";
import { resolveInterpreterFromShebang } from "./script-bash";

test("resolveInterpreterFromShebang: #!/usr/bin/env bash resolves to bash", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env bash"), {
    command: "bash",
    prefixArgs: [],
  });
});

test("resolveInterpreterFromShebang: #!/usr/bin/env node resolves to node", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env node"), {
    command: "node",
    prefixArgs: [],
  });
});

test("resolveInterpreterFromShebang: #!/usr/bin/env python3 resolves to python3", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env python3"), {
    command: "python3",
    prefixArgs: [],
  });
});

test("resolveInterpreterFromShebang: absolute-path shebang spawns that path", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/bin/bash"), {
    command: "/bin/bash",
    prefixArgs: [],
  });
});

test("resolveInterpreterFromShebang: custom interpreter shebang resolves to the named interpreter", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env my-lang"), {
    command: "my-lang",
    prefixArgs: [],
  });
  assert.deepEqual(resolveInterpreterFromShebang("#!/opt/tools/customlang"), {
    command: "/opt/tools/customlang",
    prefixArgs: [],
  });
});

test("resolveInterpreterFromShebang: interpreter flags after the interpreter are preserved", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env node --experimental-vm-modules"), {
    command: "node",
    prefixArgs: ["--experimental-vm-modules"],
  });
});

test("resolveInterpreterFromShebang: env -S split flag is skipped", () => {
  assert.deepEqual(resolveInterpreterFromShebang("#!/usr/bin/env -S deno run"), {
    command: "deno",
    prefixArgs: ["run"],
  });
});

test("resolveInterpreterFromShebang: non-shebang line returns null", () => {
  assert.equal(resolveInterpreterFromShebang("echo hi"), null);
  assert.equal(resolveInterpreterFromShebang(""), null);
  assert.equal(resolveInterpreterFromShebang("#!"), null);
});
