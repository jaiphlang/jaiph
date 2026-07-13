import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Acceptance for "Distro: native Windows smoke job in CI".
//
// The runtime behaviour (running the real jaiph.exe, cancelling mid-run, the
// prompt pre-flight) is exercised on windows-latest by
// e2e/tests/windows_native_smoke.ps1. These host-portable guards pin the
// contract that must hold everywhere and fail when it is violated:
//   1. The windows-native-smoke job exists on windows-latest, builds the
//      standalone .exe, and runs the smoke harness — and it is required for
//      merge (the docker-publish gate needs it, alongside test/e2e/e2e-wsl).
//   2. Output assertions run against actual jaiph.exe stdout (exit code +
//      expected log lines); the cancellation check fails if any child survives.
//   3. The job uses no WSL (e2e-wsl is left as-is and is the only WSL lane).

const REPO_ROOT = process.cwd();
const CI_YML = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const HARNESS_PATH = "e2e/tests/windows_native_smoke.ps1";
const HARNESS = readFileSync(join(REPO_ROOT, HARNESS_PATH), "utf8");

// Slice a job body out of the YAML by stable anchors so per-job assertions do
// not accidentally match text from another job (e.g. the WSL job).
function sliceBetween(text: string, start: string, end: string | null): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `expected to find "${start}" in workflow`);
  const to = end === null ? text.length : text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `expected to find "${end}" after "${start}"`);
  return text.slice(from, to === text.length ? text.length : to);
}

const SMOKE_JOB = sliceBetween(CI_YML, "\n  windows-native-smoke:", "\n  docker-publish:");

// ── Acceptance 1: the job exists, builds the .exe, runs the harness, gates merge ─

test("windows-native-smoke runs natively on windows-latest", () => {
  assert.match(SMOKE_JOB, /runs-on:\s*windows-latest/, "job runs on windows-latest");
});

test("windows-native-smoke builds the standalone windows-x64 binary from the checkout", () => {
  assert.match(
    SMOKE_JOB,
    /bun build --compile --target=bun-windows-x64 \.\/src\/cli\.ts --outfile jaiph-windows-x64\.exe/,
    "compiles jaiph-windows-x64.exe with bun --compile",
  );
});

test("windows-native-smoke runs the smoke harness against the built exe", () => {
  assert.match(SMOKE_JOB, /windows_native_smoke\.ps1/, "invokes the smoke harness");
  assert.match(
    SMOKE_JOB,
    /JAIPH_TEST_WINDOWS_EXE\s*=\s*Join-Path \$env:GITHUB_WORKSPACE "jaiph-windows-x64\.exe"/,
    "points the harness at the freshly built exe",
  );
});

test("windows-native-smoke is required for merge in the CI gate", () => {
  // docker-publish is the CI gate (release-workflow uses the same pattern): its
  // needs list is what must be green. The smoke job joins test/e2e/e2e-wsl there.
  const needs = sliceBetween(CI_YML, "\n  docker-publish:", "\n    if:");
  assert.match(needs, /needs:\s*\[[^\]]*\bwindows-native-smoke\b[^\]]*\]/, "gate needs windows-native-smoke");
  for (const gate of ["test", "e2e", "e2e-wsl"]) {
    assert.match(needs, new RegExp(`\\b${gate}\\b`), `gate still needs ${gate}`);
  }
});

// ── Acceptance 2: assertions run against real jaiph.exe stdout / cancellation ──

test("harness exists and runs the built exe (not a Node fallback)", () => {
  assert.ok(existsSync(join(REPO_ROOT, HARNESS_PATH)), "windows_native_smoke.ps1 present");
  assert.match(HARNESS, /JAIPH_TEST_WINDOWS_EXE/, "runs the binary provided by CI");
});

test("sample run asserts exit code and expected log lines against stdout", () => {
  // The sample workflow covers every required construct.
  assert.match(HARNESS, /script node_step = ```node/, "script step with a non-bash lang tag");
  assert.match(HARNESS, /echo "inline shell for \$\{who\}"/, "inline shell line with interpolation");
  assert.match(HARNESS, /log "smoke greeting for \$\{who\}"/, "log output with interpolation");
  // Assertions read stdout (redirected to a file), not merged output, and check
  // both the exit code and the interpolated log line.
  assert.match(HARNESS, /-RedirectStandardOutput \$sampleOut/, "captures stdout separately");
  assert.match(HARNESS, /Assert-Equal \$sample\.ExitCode 0/, "asserts the exit code");
  assert.match(
    HARNESS,
    /Assert-Contains \$sampleStdout "smoke greeting for Windows"/,
    "asserts the interpolated log line on stdout",
  );
});

test("cancellation check fails if any child of the workflow leader survives", () => {
  // Record the descendant tree, deliver a real Ctrl-C, then assert none survive.
  assert.match(HARNESS, /Get-DescendantPids -RootPid \$leaderPid/, "captures the leader's descendant tree");
  assert.match(HARNESS, /GenerateConsoleCtrlEvent/, "delivers a real Ctrl-C (not a plain kill)");
  assert.match(
    HARNESS,
    /Assert-True \(\$survivors\.Count -eq 0\) "no child of the workflow leader survives termination"/,
    "fails when a child survives",
  );
});

test("prompt-step pre-flight fails fast with the documented error (no hang)", () => {
  assert.match(HARNESS, /agent\.backend = "codex"/, "configures a backend with no login path");
  assert.match(HARNESS, /Remove-Item Env:\\OPENAI_API_KEY/, "runs with the credential unset");
  assert.match(HARNESS, /WaitForExit\(30000\)/, "bounds the run so a hang is a failure");
  assert.match(HARNESS, /prompt pre-flight hung/, "reports a hang as a failure");
  assert.match(HARNESS, /Assert-Contains \$promptStderr "E_AGENT_CREDENTIALS"/, "asserts the documented error");
});

// ── Acceptance 3: no WSL usage ────────────────────────────────────────────────

test("windows-native-smoke never invokes wsl", () => {
  // e2e-wsl is the only WSL lane; the smoke job must not shell out to `wsl`.
  assert.doesNotMatch(SMOKE_JOB, /\bwsl\s+-/, "no wsl flag invocation in the CI job");
  assert.doesNotMatch(HARNESS, /(^|[^a-zA-Z])wsl\s+-/m, "no wsl flag invocation in the harness");
  // The harness actively guards against it by shadowing `wsl`.
  assert.match(HARNESS, /function wsl \{/, "harness shadows wsl so any call throws");
});

test("e2e-wsl is left in place (its removal is not gated on this task)", () => {
  assert.match(CI_YML, /\n  e2e-wsl:/, "the WSL job still exists");
  assert.match(CI_YML, /wsl -d "\$distro"/, "e2e-wsl still runs the suite inside WSL");
});
