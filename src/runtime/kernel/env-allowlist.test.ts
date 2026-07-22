import test from "node:test";
import assert from "node:assert/strict";
import { scrubPromptEnv } from "./env-allowlist";

// scrubPromptEnv builds the env handed to every prompt backend subprocess
// (runBackend in prompt.ts). Contract: base environment + JAIPH_* control keys
// + the backend's own credential keys pass; everything else — including
// `--env`-injected secrets — is dropped, fail-closed.

test("scrubPromptEnv: drops an injected non-allowlisted secret, keeps base env", () => {
  const env = scrubPromptEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/home/u/.config",
      TMPDIR: "/tmp",
      GITHUB_TOKEN: "gh-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      MY_TOKEN: "s3cret",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    },
    "cursor",
  );
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.XDG_CONFIG_HOME, "/home/u/.config");
  assert.equal(env.TMPDIR, "/tmp");
});

test("scrubPromptEnv: forwards only the backend's own credential keys", () => {
  const all = {
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    CURSOR_API_KEY: "cursor-key",
    OPENAI_API_KEY: "openai-key",
  };
  const claude = scrubPromptEnv(all, "claude");
  assert.equal(claude.ANTHROPIC_API_KEY, "anthropic-key");
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, "claude-oauth");
  assert.equal(claude.CURSOR_API_KEY, undefined);
  assert.equal(claude.OPENAI_API_KEY, undefined);

  const cursor = scrubPromptEnv(all, "cursor");
  assert.equal(cursor.CURSOR_API_KEY, "cursor-key");
  assert.equal(cursor.ANTHROPIC_API_KEY, undefined);
  assert.equal(cursor.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(cursor.OPENAI_API_KEY, undefined);
});

test("scrubPromptEnv: an unrecognized backend forwards no credentials (fail-closed)", () => {
  const env = scrubPromptEnv(
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CURSOR_API_KEY: "k", OPENAI_API_KEY: "k" },
    "something-else",
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("scrubPromptEnv: JAIPH_ control keys pass, JAIPH_DOCKER_/inplace exclusions do not", () => {
  const env = scrubPromptEnv(
    {
      JAIPH_TEST_MODE: "1",
      JAIPH_RUN_DIR: "/runs/r1",
      JAIPH_DOCKER_IMAGE: "img",
      JAIPH_INPLACE: "true",
      JAIPH_RUN_WORKFLOW: "deploy",
    },
    "cursor",
  );
  assert.equal(env.JAIPH_TEST_MODE, "1");
  assert.equal(env.JAIPH_RUN_DIR, "/runs/r1");
  assert.equal(env.JAIPH_DOCKER_IMAGE, undefined);
  assert.equal(env.JAIPH_INPLACE, undefined);
  // Bracket access: the docs parity gate (docs-reference-task5) reserves the
  // greppable dot-access form for real runtime reads of that variable.
  assert.equal(env["JAIPH_RUN_WORKFLOW"], undefined);
});

test("scrubPromptEnv: CLAUDE_CONFIG_DIR passes as base env (needed by the Claude CLI)", () => {
  const env = scrubPromptEnv({ CLAUDE_CONFIG_DIR: "/cfg/claude" }, "claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg/claude");
});

test("scrubPromptEnv: base env names match case-insensitively (Windows-style keys)", () => {
  const env = scrubPromptEnv({ Path: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe" }, "cursor");
  assert.equal(env.Path, "C:\\bin");
  assert.equal(env.ComSpec, "C:\\Windows\\cmd.exe");
});

test("scrubPromptEnv: proxy and TLS trust settings pass", () => {
  const env = scrubPromptEnv(
    { HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/ca.pem" },
    "cursor",
  );
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.no_proxy, "localhost");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/ca.pem");
});

test("scrubPromptEnv: skips undefined values", () => {
  const env = scrubPromptEnv({ PATH: undefined, HOME: "/home/u" }, "cursor");
  assert.ok(!("PATH" in env));
  assert.equal(env.HOME, "/home/u");
});
