import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeEnv } from "./env";
import type { JaiphConfig } from "../../config";

test("resolveRuntimeEnv: sets JAIPH_WORKSPACE from workspaceRoot", () => {
  const config: JaiphConfig = {};
  const env = resolveRuntimeEnv(config, "/workspace", "/workspace/main.sh");
  assert.equal(env.JAIPH_WORKSPACE, "/workspace");
});

test("resolveRuntimeEnv: defaults JAIPH_STDLIB to bundled path (ignores shell JAIPH_STDLIB)", () => {
  const saved = process.env.JAIPH_STDLIB;
  const savedOverride = process.env.JAIPH_USE_CUSTOM_STDLIB;
  process.env.JAIPH_STDLIB = "/tmp/should-not-be-used";
  delete process.env.JAIPH_USE_CUSTOM_STDLIB;
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.match(env.JAIPH_STDLIB ?? "", /jaiph_stdlib\.sh$/);
    assert.notEqual(env.JAIPH_STDLIB, "/tmp/should-not-be-used");
  } finally {
    if (saved !== undefined) process.env.JAIPH_STDLIB = saved;
    else delete process.env.JAIPH_STDLIB;
    if (savedOverride !== undefined) process.env.JAIPH_USE_CUSTOM_STDLIB = savedOverride;
    else delete process.env.JAIPH_USE_CUSTOM_STDLIB;
  }
});

test("resolveRuntimeEnv: applies config defaults when env not set", () => {
  const saved = process.env.JAIPH_AGENT_MODEL;
  delete process.env.JAIPH_AGENT_MODEL;
  try {
    const config: JaiphConfig = { agent: { defaultModel: "sonnet" } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_AGENT_MODEL, "sonnet");
  } finally {
    if (saved !== undefined) process.env.JAIPH_AGENT_MODEL = saved;
  }
});

test("resolveRuntimeEnv: does not override env-provided values", () => {
  const saved = process.env.JAIPH_AGENT_MODEL;
  process.env.JAIPH_AGENT_MODEL = "opus";
  try {
    const config: JaiphConfig = { agent: { defaultModel: "sonnet" } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_AGENT_MODEL, "opus");
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_AGENT_MODEL = saved;
    } else {
      delete process.env.JAIPH_AGENT_MODEL;
    }
  }
});

test("resolveRuntimeEnv: marks env-provided keys as locked", () => {
  const saved = process.env.JAIPH_DEBUG;
  process.env.JAIPH_DEBUG = "true";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_DEBUG_LOCKED, "1");
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_DEBUG = saved;
    } else {
      delete process.env.JAIPH_DEBUG;
    }
  }
});

test("resolveRuntimeEnv: cleans transient keys", () => {
  const saved = process.env.JAIPH_RUN_DIR;
  const savedModule = process.env.JAIPH_RUN_STEP_MODULE;
  const savedMeta = process.env.JAIPH_META_FILE;
  process.env.JAIPH_RUN_DIR = "/old/run";
  process.env.JAIPH_RUN_STEP_MODULE = "/stale/module.sh";
  process.env.JAIPH_META_FILE = "/stale/meta.txt";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_RUN_DIR, undefined);
    assert.equal(env.JAIPH_META_FILE, undefined);
    assert.equal(env.BASH_ENV, undefined);
    assert.equal(env.JAIPH_PRECEDING_FILES, undefined);
    assert.equal(env.JAIPH_RUN_SUMMARY_FILE, undefined);
    assert.equal(env.JAIPH_RUN_STEP_MODULE, undefined);
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_RUN_DIR = saved;
    } else {
      delete process.env.JAIPH_RUN_DIR;
    }
    if (savedModule !== undefined) {
      process.env.JAIPH_RUN_STEP_MODULE = savedModule;
    } else {
      delete process.env.JAIPH_RUN_STEP_MODULE;
    }
    if (savedMeta !== undefined) {
      process.env.JAIPH_META_FILE = savedMeta;
    } else {
      delete process.env.JAIPH_META_FILE;
    }
  }
});

test("resolveRuntimeEnv: sets JAIPH_SOURCE_FILE from inputAbs basename", () => {
  const config: JaiphConfig = {};
  const env = resolveRuntimeEnv(config, "/ws", "/ws/deep/main.sh");
  assert.equal(env.JAIPH_SOURCE_FILE, "main.sh");
});

test("resolveRuntimeEnv: defaults JAIPH_AGENT_TRUSTED_WORKSPACE to workspaceRoot", () => {
  const saved = process.env.JAIPH_AGENT_TRUSTED_WORKSPACE;
  delete process.env.JAIPH_AGENT_TRUSTED_WORKSPACE;
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_AGENT_TRUSTED_WORKSPACE, "/ws");
  } finally {
    if (saved !== undefined) process.env.JAIPH_AGENT_TRUSTED_WORKSPACE = saved;
  }
});

test("resolveRuntimeEnv: sets debug from config", () => {
  const savedDebug = process.env.JAIPH_DEBUG;
  delete process.env.JAIPH_DEBUG;
  try {
    const config: JaiphConfig = { run: { debug: true } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_DEBUG, "true");
  } finally {
    if (savedDebug !== undefined) {
      process.env.JAIPH_DEBUG = savedDebug;
    } else {
      delete process.env.JAIPH_DEBUG;
    }
  }
});
