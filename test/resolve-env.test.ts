import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeEnv } from "../src/cli/run/env";
import type { JaiphConfig } from "../src/config";

test("resolveRuntimeEnv: sets JAIPH_WORKSPACE from workspaceRoot", () => {
  const config: JaiphConfig = {};
  const env = resolveRuntimeEnv(config, "/workspace", "/workspace/main.sh");
  assert.equal(env.JAIPH_WORKSPACE, "/workspace");
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
  process.env.JAIPH_RUN_DIR = "/old/run";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_RUN_DIR, undefined);
    assert.equal(env.BASH_ENV, undefined);
    assert.equal(env.JAIPH_PRECEDING_FILES, undefined);
    assert.equal(env.JAIPH_RUN_SUMMARY_FILE, undefined);
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_RUN_DIR = saved;
    } else {
      delete process.env.JAIPH_RUN_DIR;
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
