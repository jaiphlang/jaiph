import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
  collectWorkflowChildren,
  buildRunTreeRows,
  styleKeywordLabel,
  styleDim,
  styleYellow,
  styleBold,
} from "./progress";
import type { jaiphModule } from "../../types";

function minimalModule(overrides?: Partial<jaiphModule>): jaiphModule {
  return {
    filePath: "test.jh",
    imports: [],
    channels: [],
    exports: [],
    rules: [],
    scripts: [],
    workflows: [],
    ...overrides,
  };
}

// --- parseLabel ---

test("parseLabel: splits kind and name on first space", () => {
  const { kind, name } = parseLabel("workflow default");
  assert.equal(kind, "workflow");
  assert.equal(name, "default");
});

test("parseLabel: returns 'step' kind when no space", () => {
  const { kind, name } = parseLabel("wait");
  assert.equal(kind, "step");
  assert.equal(name, "wait");
});

test("parseLabel: handles multi-word name", () => {
  const { kind, name } = parseLabel("prompt \"hello world\"");
  assert.equal(kind, "prompt");
  assert.equal(name, "\"hello world\"");
});

// --- formatElapsedDuration ---

test("formatElapsedDuration: formats milliseconds as seconds", () => {
  assert.equal(formatElapsedDuration(1500), "1.5s");
});

test("formatElapsedDuration: drops trailing .0", () => {
  assert.equal(formatElapsedDuration(2000), "2s");
});

test("formatElapsedDuration: formats >= 60s as minutes and seconds", () => {
  assert.equal(formatElapsedDuration(90000), "1m 30s");
});

test("formatElapsedDuration: handles exact minute", () => {
  assert.equal(formatElapsedDuration(120000), "2m 0s");
});

test("formatElapsedDuration: handles sub-second", () => {
  assert.equal(formatElapsedDuration(100), "0.1s");
});

// --- collectWorkflowChildren ---

test("collectWorkflowChildren: returns empty for unknown workflow", () => {
  const mod = minimalModule();
  assert.deepStrictEqual(collectWorkflowChildren(mod, "missing"), []);
});

test("collectWorkflowChildren: collects run steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "deploy", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "workflow deploy");
  assert.equal(items[0].nested, "deploy");
});

test("collectWorkflowChildren: collects async run with prefix", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "bg_task", loc: { line: 2, col: 3 } }, async: true },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "async workflow bg_task");
});

test("collectWorkflowChildren: collects ensure steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "ensure", ref: { value: "check_passes", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "rule check_passes");
});

test("collectWorkflowChildren: collects prompt steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: 'prompt "hello world"', loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.match(items[0].label, /^prompt "hello world"/);
});

test("collectWorkflowChildren: collects log steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "starting", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "ℹ starting");
});

test("collectWorkflowChildren: collects logerr steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "logerr", message: "bad thing", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "! bad thing");
});

test("collectWorkflowChildren: collects send steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "send", channel: "notify", rhs: { kind: "literal", token: "hello" }, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "notify <- send");
});

test("collectWorkflowChildren: collects fail steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "fail", message: "broken", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "fail broken");
});

test("collectWorkflowChildren: collects const steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "const", name: "x", value: { kind: "expr", bashRhs: "1" }, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "const x");
});


test("collectWorkflowChildren: collects return steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "return", value: '"done"', loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, 'return "done"');
});

test("collectWorkflowChildren: collects shell steps with truncation", () => {
  const longCmd = "a".repeat(60);
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "shell", command: longCmd, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.match(items[0].label, /^\$ .{53}\.\.\./);
});

test("collectWorkflowChildren: skips comment steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "comment", text: "# note", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 0);
});

test("collectWorkflowChildren: collects channel-level route declarations", () => {
  const mod = minimalModule({
    channels: [{
      name: "events",
      routes: [
        { value: "handler1", loc: { line: 1, col: 20 } },
        { value: "handler2", loc: { line: 1, col: 30 } },
      ],
      loc: { line: 1, col: 9 },
    }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [],
      loc: { line: 3, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "events -> handler1, handler2");
});

// --- buildRunTreeRows ---

test("buildRunTreeRows: root row is first", () => {
  const mod = minimalModule({
    workflows: [{ name: "default", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const rows = buildRunTreeRows(mod);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[0].isRoot, true);
});

test("buildRunTreeRows: includes nested steps", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          { type: "run", workflow: { value: "sub", loc: { line: 2, col: 3 } } },
        ],
        loc: { line: 1, col: 1 },
      },
      {
        name: "sub",
        comments: [],
        params: [],
        steps: [
          { type: "log", message: "hello", loc: { line: 5, col: 3 } },
        ],
        loc: { line: 4, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "workflow sub");
  assert.equal(rows[2].rawLabel, "ℹ hello");
});

test("buildRunTreeRows: does not re-expand visited workflows", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          { type: "run", workflow: { value: "shared", loc: { line: 2, col: 3 } } },
          { type: "run", workflow: { value: "other", loc: { line: 3, col: 3 } } },
        ],
        loc: { line: 1, col: 1 },
      },
      {
        name: "shared",
        comments: [],
        params: [],
        steps: [
          { type: "log", message: "in shared", loc: { line: 6, col: 3 } },
        ],
        loc: { line: 5, col: 1 },
      },
      {
        name: "other",
        comments: [],
        params: [],
        steps: [
          { type: "run", workflow: { value: "shared", loc: { line: 9, col: 3 } } },
        ],
        loc: { line: 8, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod);
  const sharedRows = rows.filter((r) => r.rawLabel === "workflow shared");
  // "shared" appears twice in the tree (once expanded, once not re-expanded)
  assert.equal(sharedRows.length, 2);
  // But "in shared" log only appears once (not re-expanded from "other")
  const logRows = rows.filter((r) => r.rawLabel === "ℹ in shared");
  assert.equal(logRows.length, 1);
});

// --- formatElapsedDuration (additional) ---

test("formatElapsedDuration: zero milliseconds", () => {
  assert.equal(formatElapsedDuration(0), "0s");
});

test("formatElapsedDuration: sub-second precision", () => {
  assert.equal(formatElapsedDuration(50), "0.1s");
  assert.equal(formatElapsedDuration(999), "1s");
});

// --- formatRunningBottomLine ---

test("formatRunningBottomLine: contains RUNNING and workflow name", () => {
  // In non-TTY test env, style functions return plain text
  const result = formatRunningBottomLine("default", 1.5);
  assert.ok(result.includes("RUNNING"), "should contain RUNNING");
  assert.ok(result.includes("workflow"), "should contain 'workflow'");
  assert.ok(result.includes("default"), "should contain workflow name");
  assert.ok(result.includes("1.5s"), "should contain elapsed time");
});

test("formatRunningBottomLine: formats elapsed with one decimal", () => {
  const result = formatRunningBottomLine("deploy", 10.0);
  assert.ok(result.includes("10.0s"), "should show one decimal place");
});

// --- collectWorkflowChildren: catch blocks ---

test("collectWorkflowChildren: run step with single catch includes recovery items", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "run",
          workflow: { value: "deploy", loc: { line: 2, col: 3 } },
          recover: {
            single: { type: "log", message: "recovering", loc: { line: 3, col: 5 } },
            bindings: { failure: "err" },
          },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "workflow deploy");
  assert.equal(items[1].label, "ℹ recovering");
});

test("collectWorkflowChildren: run step with block catch includes all recovery items", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "run",
          workflow: { value: "deploy", loc: { line: 2, col: 3 } },
          recover: {
            block: [
              { type: "log", message: "retrying", loc: { line: 3, col: 5 } },
              { type: "run", workflow: { value: "fallback", loc: { line: 4, col: 5 } } },
            ],
            bindings: { failure: "err" },
          },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 3);
  assert.equal(items[0].label, "workflow deploy");
  assert.equal(items[1].label, "ℹ retrying");
  assert.equal(items[2].label, "workflow fallback");
});

test("collectWorkflowChildren: ensure step with single catch includes recovery items", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "ensure",
          ref: { value: "check", loc: { line: 2, col: 3 } },
          recover: {
            single: { type: "run", workflow: { value: "fix_it", loc: { line: 3, col: 5 } } },
            bindings: { failure: "err" },
          },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "rule check");
  assert.equal(items[1].label, "workflow fix_it");
});

test("collectWorkflowChildren: ensure step with block catch includes all recovery items", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "ensure",
          ref: { value: "check", loc: { line: 2, col: 3 } },
          recover: {
            block: [
              { type: "log", message: "check failed", loc: { line: 3, col: 5 } },
              { type: "fail", message: "unrecoverable", loc: { line: 4, col: 5 } },
            ],
            bindings: { failure: "err" },
          },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 3);
  assert.equal(items[0].label, "rule check");
  assert.equal(items[1].label, "ℹ check failed");
  assert.equal(items[2].label, "fail unrecoverable");
});

// --- buildRunTreeRows: self-recursive workflows ---

test("buildRunTreeRows: self-recursive workflow expands limited depth", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "iteration", loc: { line: 2, col: 3 } },
        { type: "run", workflow: { value: "default", loc: { line: 3, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  // Should have root + children, with limited recursion (not infinite)
  assert.ok(rows.length >= 3, "should expand self-recursive workflow at least once");
  assert.ok(rows.length < 50, "should not expand infinitely");
  // First row is root
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[0].isRoot, true);
  // Should contain "ℹ iteration" at least once
  const logRows = rows.filter((r) => r.rawLabel === "ℹ iteration");
  assert.ok(logRows.length >= 1, "should show log from recursive workflow");
});

test("buildRunTreeRows: workflow with two self-recursive sites", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "default", loc: { line: 2, col: 3 } } },
        { type: "log", message: "middle", loc: { line: 3, col: 3 } },
        { type: "run", workflow: { value: "default", loc: { line: 4, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  // Should terminate without infinite expansion
  assert.ok(rows.length >= 3, "should produce tree rows");
  assert.ok(rows.length < 100, "should not expand infinitely");
});

// --- collectWorkflowChildren: match_expr with run/ensure arms ---

test("collectWorkflowChildren: const with match_expr containing run arm", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "const",
          name: "result",
          value: {
            kind: "match_expr",
            match: {
              subject: "x",
              arms: [
                { pattern: { kind: "string_literal", value: "a" }, body: 'run deploy("a")' },
                { pattern: { kind: "wildcard" }, body: '"fallback"' },
              ],
              loc: { line: 3, col: 10 },
            },
          },
          loc: { line: 3, col: 3 },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "const result");
  assert.equal(items[1].label, "workflow deploy");
  assert.equal(items[1].nested, "deploy");
});

test("collectWorkflowChildren: const with match_expr containing ensure arm", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "const",
          name: "status",
          value: {
            kind: "match_expr",
            match: {
              subject: "x",
              arms: [
                { pattern: { kind: "string_literal", value: "check" }, body: 'ensure gate()' },
                { pattern: { kind: "wildcard" }, body: '"skip"' },
              ],
              loc: { line: 3, col: 10 },
            },
          },
          loc: { line: 3, col: 3 },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "const status");
  assert.equal(items[1].label, "rule gate");
  assert.equal(items[1].nested, "gate");
});

test("collectWorkflowChildren: const with match_expr arm with no run/ensure", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "const",
          name: "val",
          value: {
            kind: "match_expr",
            match: {
              subject: "x",
              arms: [
                { pattern: { kind: "string_literal", value: "a" }, body: '"hello"' },
                { pattern: { kind: "wildcard" }, body: '"default"' },
              ],
              loc: { line: 3, col: 10 },
            },
          },
          loc: { line: 3, col: 3 },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "const val");
});

// --- collectWorkflowChildren: run_inline_script ---

test("collectWorkflowChildren: collects run_inline_script steps", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run_inline_script", body: "echo hello", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "script (inline)");
});

// --- buildRunTreeRows: prefix/indentation ---

test("buildRunTreeRows: grandchild rows are more indented than children", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          { type: "run", workflow: { value: "sub", loc: { line: 2, col: 3 } } },
        ],
        loc: { line: 1, col: 1 },
      },
      {
        name: "sub",
        comments: [],
        params: [],
        steps: [
          { type: "log", message: "hello", loc: { line: 5, col: 3 } },
        ],
        loc: { line: 4, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod);
  // Root and direct children share empty prefix; grandchildren are indented
  assert.equal(rows[0].prefix, "", "root should have empty prefix");
  assert.equal(rows[1].prefix, "", "direct child inherits root prefix");
  assert.ok(rows[2].prefix.length > rows[1].prefix.length, "grandchild should be more indented than child");
});

// --- buildRunTreeRows: cross-module imported workflows ---

test("buildRunTreeRows: cross-module workflows are expanded from importedModules", () => {
  const mainMod = minimalModule({
    imports: [{ path: "lib.jh", alias: "lib", loc: { line: 1, col: 1 } }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "lib.greet", loc: { line: 3, col: 3 } } },
      ],
      loc: { line: 2, col: 1 },
    }],
  });
  const libMod = minimalModule({
    filePath: "lib.jh",
    workflows: [{
      name: "greet",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "hello from lib", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const importedModules = new Map([["lib", libMod]]);
  const rows = buildRunTreeRows(mainMod, undefined, importedModules);
  // Should contain the imported workflow's children
  const libLogRows = rows.filter((r) => r.rawLabel === "ℹ hello from lib");
  assert.equal(libLogRows.length, 1, "should expand imported workflow children");
});

// --- formatElapsedDuration: exact boundary ---

test("formatElapsedDuration: exactly 60000ms uses minute format", () => {
  assert.equal(formatElapsedDuration(60000), "1m 0s");
});

test("formatElapsedDuration: just under 60000ms uses seconds format", () => {
  assert.equal(formatElapsedDuration(59999), "60s");
});

// --- collectWorkflowChildren: stepFunc with symbols ---

test("collectWorkflowChildren: run step with dotted ref populates stepFunc from symbols", () => {
  const mod = minimalModule({
    imports: [{ path: "lib.jh", alias: "lib", loc: { line: 1, col: 1 } }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "lib.deploy", loc: { line: 3, col: 3 } } },
      ],
      loc: { line: 2, col: 1 },
    }],
  });
  const symbols = new Map([["lib", "mylib"]]);
  const items = collectWorkflowChildren(mod, "default", symbols);
  assert.equal(items.length, 1);
  assert.equal(items[0].stepFunc, "mylib::deploy");
});

test("collectWorkflowChildren: run step with dotted ref falls back to alias when symbol missing", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "lib.deploy", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const symbols = new Map<string, string>();
  const items = collectWorkflowChildren(mod, "default", symbols);
  assert.equal(items[0].stepFunc, "lib::deploy");
});

test("collectWorkflowChildren: run step with currentSymbol populates stepFunc", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "helper", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default", undefined, "main_mod");
  assert.equal(items[0].stepFunc, "main_mod::helper");
});

test("collectWorkflowChildren: ensure step with dotted ref populates stepFunc from symbols", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "ensure", ref: { value: "lib.check", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const symbols = new Map([["lib", "mylib"]]);
  const items = collectWorkflowChildren(mod, "default", symbols);
  assert.equal(items[0].stepFunc, "mylib::check");
});

test("collectWorkflowChildren: ensure step with currentSymbol populates stepFunc", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "ensure", ref: { value: "gate", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default", undefined, "main_mod");
  assert.equal(items[0].stepFunc, "main_mod::gate");
});

test("collectWorkflowChildren: prompt step always has jaiph::prompt stepFunc", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: 'prompt "test"', loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].stepFunc, "jaiph::prompt");
});

// --- buildRunTreeRows: self-recursion depth gating ---

test("buildRunTreeRows: self-recursive workflow with three sites limits expansion", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "default", loc: { line: 2, col: 3 } } },
        { type: "log", message: "a", loc: { line: 3, col: 3 } },
        { type: "run", workflow: { value: "default", loc: { line: 4, col: 3 } } },
        { type: "log", message: "b", loc: { line: 5, col: 3 } },
        { type: "run", workflow: { value: "default", loc: { line: 6, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  // Should terminate without infinite expansion
  assert.ok(rows.length >= 3, "should produce tree rows");
  assert.ok(rows.length < 200, "should not expand infinitely");
  // Root is first
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[0].isRoot, true);
});

// --- collectWorkflowChildren: prompt label formatting ---

test("collectWorkflowChildren: prompt with escaped quotes in raw", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: 'prompt "say \\"hello\\""', loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  // The escaped quotes in raw should be handled: \" → " in content, then re-escaped for display
  assert.match(items[0].label, /^prompt "/);
});

test("collectWorkflowChildren: prompt with no quotes in raw", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: "prompt myVar", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  // No quote found, preview is empty → label is just 'prompt ""'
  assert.equal(items[0].label, 'prompt ""');
});

// --- styleKeywordLabel / styleDim / styleYellow / styleBold ---
// In test env (non-TTY), these return plain text. We verify the non-TTY path.

test("styleKeywordLabel: returns plain 'kind name' in non-TTY", () => {
  const result = styleKeywordLabel("workflow deploy");
  assert.equal(result, "workflow deploy");
});

test("styleKeywordLabel: handles single-word label", () => {
  const result = styleKeywordLabel("wait");
  assert.equal(result, "step wait");
});

test("styleDim: returns plain text in non-TTY", () => {
  assert.equal(styleDim("hello"), "hello");
});

test("styleYellow: returns plain text in non-TTY", () => {
  assert.equal(styleYellow("warning"), "warning");
});

test("styleBold: returns plain text in non-TTY", () => {
  assert.equal(styleBold("title"), "title");
});

test("collectWorkflowChildren: prompt with long text truncated at 24 chars", () => {
  const longText = "A".repeat(30);
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: `prompt "${longText}"`, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items[0].label.includes("A".repeat(24) + "..."), "should truncate at 24 chars");
  assert.ok(!items[0].label.includes("A".repeat(25)), "should not contain more than 24 chars");
});

// --- buildRunTreeRows: rootDir parameter ---

test("buildRunTreeRows: rootDir populates symbols for imported modules", () => {
  const mainMod = minimalModule({
    filePath: "/project/main.jh",
    imports: [{ path: "lib.jh", alias: "lib", loc: { line: 1, col: 1 } }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "lib.greet", loc: { line: 3, col: 3 } } },
      ],
      loc: { line: 2, col: 1 },
    }],
  });
  const libMod = minimalModule({
    filePath: "/project/lib.jh",
    workflows: [{
      name: "greet",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "hello", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const importedModules = new Map([["lib", libMod]]);
  const rows = buildRunTreeRows(mainMod, undefined, importedModules, "/project");
  // With rootDir, symbols should be resolved; the run step should have a stepFunc
  const runRow = rows.find((r) => r.rawLabel === "workflow lib.greet");
  assert.ok(runRow, "should have the imported workflow row");
  assert.ok(runRow!.stepFunc, "stepFunc should be populated when rootDir is given");
});

// --- buildRunTreeRows: custom rootLabel ---

test("buildRunTreeRows: custom rootLabel appears in root row", () => {
  const mod = minimalModule({
    workflows: [{ name: "deploy", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const rows = buildRunTreeRows(mod, "workflow deploy");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawLabel, "workflow deploy");
  assert.equal(rows[0].isRoot, true);
});

test("buildRunTreeRows: custom rootLabel with rule kind", () => {
  const mod = minimalModule({
    workflows: [{ name: "check", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const rows = buildRunTreeRows(mod, "rule check");
  assert.equal(rows[0].rawLabel, "rule check");
  assert.equal(rows[0].isRoot, true);
});

test("buildRunTreeRows: custom rootLabel preserves tree children", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          { type: "log", message: "hello", loc: { line: 2, col: 3 } },
        ],
        loc: { line: 1, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod, "workflow main_entry");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rawLabel, "workflow main_entry");
  assert.equal(rows[1].rawLabel, "ℹ hello");
});

// --- formatRunningBottomLine: edge cases ---

test("formatRunningBottomLine: zero elapsed time", () => {
  const result = formatRunningBottomLine("test", 0.0);
  assert.ok(result.includes("RUNNING"), "should contain RUNNING");
  assert.ok(result.includes("0.0s"), "should show zero time");
});

test("formatRunningBottomLine: large elapsed time", () => {
  const result = formatRunningBottomLine("deploy", 999.9);
  assert.ok(result.includes("999.9s"), "should show large time");
});

// --- collectWorkflowChildren: shell command truncation boundary ---

test("collectWorkflowChildren: shell command at exactly 56 chars is not truncated", () => {
  const cmd = "a".repeat(56);
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "shell", command: cmd, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, `$ ${cmd}`, "56-char command should not be truncated");
  assert.ok(!items[0].label.includes("..."), "should not have ellipsis");
});

test("collectWorkflowChildren: shell command at 57 chars is truncated", () => {
  const cmd = "b".repeat(57);
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "shell", command: cmd, loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items[0].label.includes("..."), "57-char command should be truncated");
  assert.equal(items[0].label, `$ ${"b".repeat(53)}...`);
});

test("collectWorkflowChildren: shell command at 1 char is not truncated", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "shell", command: "x", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "$ x");
});

// --- style functions: TTY and NO_COLOR paths ---

test("styleKeywordLabel: returns ANSI bold kind when TTY and no NO_COLOR", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    delete process.env.NO_COLOR;
    const result = styleKeywordLabel("workflow deploy");
    assert.ok(result.includes("\u001b[1mworkflow\u001b[0m"), "kind should be bold in TTY mode");
    assert.ok(result.includes("deploy"), "name should be present");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleKeywordLabel: returns plain text when NO_COLOR is set", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    process.env.NO_COLOR = "1";
    const result = styleKeywordLabel("workflow deploy");
    assert.equal(result, "workflow deploy", "should return plain text with NO_COLOR");
    assert.ok(!result.includes("\u001b["), "should not contain ANSI codes");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleDim: returns ANSI dim when TTY and no NO_COLOR", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    delete process.env.NO_COLOR;
    const result = styleDim("hello");
    assert.equal(result, "\u001b[2mhello\u001b[0m", "should wrap in dim ANSI");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleDim: returns plain text when NO_COLOR is set", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    process.env.NO_COLOR = "";
    const result = styleDim("hello");
    assert.equal(result, "hello", "should return plain text with NO_COLOR");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleYellow: returns ANSI yellow when TTY and no NO_COLOR", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    delete process.env.NO_COLOR;
    const result = styleYellow("warning");
    assert.equal(result, "\u001b[33mwarning\u001b[0m", "should wrap in yellow ANSI");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleYellow: returns plain text when NO_COLOR is set", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    process.env.NO_COLOR = "1";
    const result = styleYellow("warning");
    assert.equal(result, "warning", "should return plain text with NO_COLOR");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleBold: returns ANSI bold when TTY and no NO_COLOR", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    delete process.env.NO_COLOR;
    const result = styleBold("title");
    assert.equal(result, "\u001b[1mtitle\u001b[0m", "should wrap in bold ANSI");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("styleBold: returns plain text when not TTY", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true, configurable: true });
    delete process.env.NO_COLOR;
    const result = styleBold("title");
    assert.equal(result, "title", "should return plain text when not TTY");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

// --- buildRunTreeRows: selfRecursiveRunSiteCount returns 0 for missing workflow ---

test("buildRunTreeRows: non-existent nested workflow reference is handled gracefully", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "nonexistent", loc: { line: 2, col: 3 } } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  // Should have root + the run step reference, but no children expanded since workflow doesn't exist
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "workflow nonexistent");
});

test("collectWorkflowChildren: returns empty for workflow with no matching name", () => {
  const mod = minimalModule({
    workflows: [{
      name: "other",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "hello", loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "nonexistent");
  assert.deepStrictEqual(items, []);
});

// --- collectWorkflowChildren: prompt with multiline whitespace raw ---

test("collectWorkflowChildren: prompt with triple-quoted raw (no double quote) returns empty preview", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "prompt", raw: 'prompt """\nHello\n"""', loc: { line: 2, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  // The promptPreviewFromRaw picks up text between the first pair of double quotes
  // In triple-quote form, first " starts at index 7, second " is immediately after → empty content
  // Then third " triggers break → empty preview
  assert.match(items[0].label, /^prompt "/);
});

// --- buildRunTreeRows: channels without routes don't produce tree nodes ---

test("buildRunTreeRows: channel without routes adds no tree rows", () => {
  const mod = minimalModule({
    channels: [{
      name: "events",
      loc: { line: 1, col: 9 },
    }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [{ type: "log", message: "ok", loc: { line: 3, col: 3 } }],
      loc: { line: 2, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  assert.equal(rows.length, 2); // root + log
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "ℹ ok");
});

// --- buildRunTreeRows: imported module not found falls through gracefully ---

test("buildRunTreeRows: imported module alias not in importedModules map is not expanded", () => {
  const mainMod = minimalModule({
    imports: [{ path: "lib.jh", alias: "lib", loc: { line: 1, col: 1 } }],
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "run", workflow: { value: "lib.greet", loc: { line: 3, col: 3 } } },
      ],
      loc: { line: 2, col: 1 },
    }],
  });
  // Pass empty importedModules — alias "lib" not resolved
  const importedModules = new Map<string, jaiphModule>();
  const rows = buildRunTreeRows(mainMod, undefined, importedModules);
  // Should still have root + the run step reference, but not expanded
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "workflow lib.greet");
});

// --- buildRunTreeRows: match_expr arm expansion ---

test("buildRunTreeRows: match arm with run body expands nested workflow", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          {
            type: "const",
            name: "result",
            value: {
              kind: "match_expr",
              match: {
                subject: "x",
                arms: [
                  { pattern: { kind: "string_literal", value: "a" }, body: 'run deploy("a")' },
                  { pattern: { kind: "wildcard" }, body: '"fallback"' },
                ],
                loc: { line: 3, col: 3 },
              },
            },
            loc: { line: 2, col: 3 },
          },
        ],
        loc: { line: 1, col: 1 },
      },
      {
        name: "deploy",
        comments: [],
        params: [],
        steps: [
          { type: "log", message: "deploying", loc: { line: 8, col: 3 } },
        ],
        loc: { line: 7, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod);
  // root + const result + workflow deploy (from match arm) + log deploying (expanded)
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "const result");
  assert.equal(rows[2].rawLabel, "workflow deploy");
  assert.equal(rows[3].rawLabel, "ℹ deploying");
  assert.equal(rows.length, 4);
});

test("buildRunTreeRows: match arm with ensure body shows rule in tree", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        {
          type: "const",
          name: "status",
          value: {
            kind: "match_expr",
            match: {
              subject: "mode",
              arms: [
                { pattern: { kind: "string_literal", value: "strict" }, body: 'ensure gate()' },
                { pattern: { kind: "wildcard" }, body: '"skip"' },
              ],
              loc: { line: 3, col: 3 },
            },
          },
          loc: { line: 2, col: 3 },
        },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "const status");
  assert.equal(rows[2].rawLabel, "rule gate");
  assert.equal(rows.length, 3);
});

// --- buildRunTreeRows: mixed step types in tree ---

test("buildRunTreeRows: workflow with multiple step types produces correct tree", () => {
  const mod = minimalModule({
    workflows: [{
      name: "default",
      comments: [],
      params: [],
      steps: [
        { type: "log", message: "starting", loc: { line: 2, col: 3 } },
        { type: "run", workflow: { value: "helper", loc: { line: 3, col: 3 } } },
        { type: "ensure", ref: { value: "check", loc: { line: 4, col: 3 } } },
        { type: "send", channel: "events", rhs: { kind: "literal", token: '"data"' }, loc: { line: 5, col: 3 } },
        { type: "fail", message: '"reason"', loc: { line: 6, col: 3 } },
      ],
      loc: { line: 1, col: 1 },
    }],
  });
  const rows = buildRunTreeRows(mod);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "ℹ starting");
  assert.equal(rows[2].rawLabel, "workflow helper");
  assert.equal(rows[3].rawLabel, "rule check");
  assert.equal(rows[4].rawLabel, "events <- send");
  assert.equal(rows[5].rawLabel, 'fail "reason"');
  assert.equal(rows.length, 6);
});

// --- buildRunTreeRows: run with catch block in tree ---

test("buildRunTreeRows: run with catch block shows recovery steps in tree", () => {
  const mod = minimalModule({
    workflows: [
      {
        name: "default",
        comments: [],
        params: [],
        steps: [
          {
            type: "run",
            workflow: { value: "risky", loc: { line: 2, col: 3 } },
            recover: {
              bindings: { failure: "err" },
              block: [
                { type: "log", message: "recovering", loc: { line: 4, col: 5 } },
                { type: "run", workflow: { value: "fallback", loc: { line: 5, col: 5 } } },
              ],
            },
          },
        ],
        loc: { line: 1, col: 1 },
      },
      {
        name: "risky",
        comments: [],
        params: [],
        steps: [{ type: "log", message: "trying", loc: { line: 8, col: 3 } }],
        loc: { line: 7, col: 1 },
      },
    ],
  });
  const rows = buildRunTreeRows(mod);
  // root + workflow risky + log trying (expanded) + log recovering (catch) + workflow fallback (catch)
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[1].rawLabel, "workflow risky");
  // risky is expanded since it has children
  assert.equal(rows[2].rawLabel, "ℹ trying");
  // catch block children
  assert.equal(rows[3].rawLabel, "ℹ recovering");
  assert.equal(rows[4].rawLabel, "workflow fallback");
  assert.equal(rows.length, 5);
});
