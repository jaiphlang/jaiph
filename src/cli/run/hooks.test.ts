import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalHooksPath,
  projectHooksPath,
  parseHookConfig,
  loadMergedHooks,
  runHooksForEvent,
  isProjectHooksTrusted,
  type MergedHookConfig,
} from "./hooks";

test("globalHooksPath returns path under homedir", () => {
  const p = globalHooksPath();
  assert.ok(p.endsWith(".jaiph/hooks.json"), "path should end with .jaiph/hooks.json");
  assert.ok(p.includes("jaiph"), "path should contain jaiph");
});

test("projectHooksPath returns path under workspace", () => {
  const p = projectHooksPath("/repo/foo");
  assert.equal(p, "/repo/foo/.jaiph/hooks.json");
});

test("parseHookConfig returns null for invalid JSON", () => {
  assert.equal(parseHookConfig("{", "test"), null);
  assert.equal(parseHookConfig("not json", "test"), null);
  assert.equal(parseHookConfig("[]", "test"), null);
});

test("parseHookConfig returns null for non-object", () => {
  assert.equal(parseHookConfig("null", "test"), null);
  assert.equal(parseHookConfig("123", "test"), null);
});

test("parseHookConfig extracts only supported events with string arrays", () => {
  const cfg = parseHookConfig(
    '{"run_start":["a","b"],"run_end":["c"],"step_start":[],"step_end":["d"],"unknown":["e"]}',
    "test",
  );
  assert.ok(cfg);
  assert.deepEqual(cfg!.run_start, ["a", "b"]);
  assert.deepEqual(cfg!.run_end, ["c"]);
  assert.deepEqual(cfg!.step_start, undefined);
  assert.deepEqual(cfg!.step_end, ["d"]);
  assert.equal((cfg as Record<string, unknown>)["unknown"], undefined);
});

test("parseHookConfig ignores non-string array elements", () => {
  const cfg = parseHookConfig(
    '{"run_start":["ok",1,null,true,""]}',
    "test",
  );
  assert.ok(cfg);
  assert.deepEqual(cfg!.run_start, ["ok"]);
});

test("loadMergedHooks returns empty when no config files exist", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-hooks-none-"));
  try {
    const merged = loadMergedHooks(root, true);
    assert.deepEqual(merged.run_start, []);
    assert.deepEqual(merged.run_end, []);
    assert.deepEqual(merged.step_start, []);
    assert.deepEqual(merged.step_end, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadMergedHooks loads project-local hooks.json when the workspace is trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-hooks-project-"));
  try {
    const jaiphDir = join(root, ".jaiph");
    const hooksPath = join(jaiphDir, "hooks.json");
    mkdirSync(jaiphDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        run_start: ["echo start"],
        run_end: ["echo end"],
      }),
    );
    const merged = loadMergedHooks(root, true);
    assert.deepEqual(merged.run_start, ["echo start"]);
    assert.deepEqual(merged.run_end, ["echo end"]);
    assert.deepEqual(merged.step_start, []);
    assert.deepEqual(merged.step_end, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadMergedHooks ignores project-local hooks.json when the workspace is untrusted (finding M-10)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-hooks-untrusted-"));
  try {
    const jaiphDir = join(root, ".jaiph");
    mkdirSync(jaiphDir, { recursive: true });
    writeFileSync(
      join(jaiphDir, "hooks.json"),
      JSON.stringify({ run_start: ["touch /tmp/should-not-run"] }),
    );
    const merged = loadMergedHooks(root, false);
    // Absent the trust decision the project file's commands must not be loaded.
    assert.deepEqual(merged.run_start, []);
    assert.deepEqual(merged.run_end, []);
    assert.deepEqual(merged.step_start, []);
    assert.deepEqual(merged.step_end, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadMergedHooks keeps global ~/.jaiph/hooks.json even when the workspace is untrusted", () => {
  const realHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "jaiph-hooks-home-"));
  const root = mkdtempSync(join(tmpdir(), "jaiph-hooks-global-"));
  try {
    // Global hooks live under the operator's own home and are implicitly
    // trusted; the workspace-trust gate applies only to the project file.
    const globalDir = join(fakeHome, ".jaiph");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "hooks.json"),
      JSON.stringify({ run_start: ["echo global"] }),
    );
    // An untrusted project file present alongside must not run, but must also
    // not suppress the global command for the same event.
    const projectDir = join(root, ".jaiph");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "hooks.json"),
      JSON.stringify({ run_start: ["echo project"] }),
    );
    process.env.HOME = fakeHome;
    const merged = loadMergedHooks(root, false);
    assert.deepEqual(merged.run_start, ["echo global"]);
    assert.deepEqual(merged.run_end, []);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("isProjectHooksTrusted honours only the documented opt-in values", () => {
  assert.equal(isProjectHooksTrusted({ JAIPH_TRUST_PROJECT_HOOKS: "1" }), true);
  assert.equal(isProjectHooksTrusted({ JAIPH_TRUST_PROJECT_HOOKS: "true" }), true);
  assert.equal(isProjectHooksTrusted({ JAIPH_TRUST_PROJECT_HOOKS: "0" }), false);
  assert.equal(isProjectHooksTrusted({ JAIPH_TRUST_PROJECT_HOOKS: "yes" }), false);
  assert.equal(isProjectHooksTrusted({}), false);
});

test("runHooksForEvent with empty config does not throw", () => {
  const empty: MergedHookConfig = {
    run_start: [],
    run_end: [],
    step_start: [],
    step_end: [],
  };
  runHooksForEvent(empty, "run_start", {
    event: "run_start",
    run_id: "",
    timestamp: new Date().toISOString(),
    run_path: "/x.jh",
    workspace: "/ws",
  });
});

test("runHooksForEvent with failing command does not throw", () => {
  const config: MergedHookConfig = {
    run_start: ["exit 1"],
    run_end: [],
    step_start: [],
    step_end: [],
  };
  runHooksForEvent(config, "run_start", {
    event: "run_start",
    run_id: "",
    timestamp: new Date().toISOString(),
    run_path: "/x.jh",
    workspace: "/ws",
  });
});

test("runHooksForEvent passes payload as JSON on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-hooks-payload-"));
  const payloadFile = join(root, "payload.json");
  try {
    const config: MergedHookConfig = {
      run_start: [`cat > "${payloadFile.replace(/"/g, '\\"')}"`],
      run_end: [],
      step_start: [],
      step_end: [],
    };
    const payload = {
      event: "run_start" as const,
      run_id: "run-123",
      timestamp: "2025-03-11T12:00:00.000Z",
      run_path: "/repo/ci.jh",
      workspace: "/repo",
    };
    runHooksForEvent(config, "run_start", payload);
    await new Promise((r) => setTimeout(r, 150));
    const content = readFileSync(payloadFile, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    assert.equal(parsed.event, "run_start");
    assert.equal(parsed.run_id, "run-123");
    assert.equal(parsed.run_path, "/repo/ci.jh");
    assert.equal(parsed.workspace, "/repo");
    assert.equal(parsed.timestamp, "2025-03-11T12:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
