import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
  collectWorkflowChildren,
  buildRunTreeRows,
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
