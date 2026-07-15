import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmInplaceRun,
  confirmUnsafeRun,
  detectGitTreeState,
  formatInplaceWarning,
  formatUnsafeWarning,
  _inplacePrompt,
} from "./docker-inplace";

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), "jaiph-inplace-ws-"));
}

function captureStderr(): { restore: () => void; data: () => string } {
  let buf = "";
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => { process.stderr.write = orig; },
    data: () => buf,
  };
}

function stubPrompt(answers: string[]): { restore: () => void; callCount: () => number } {
  const orig = _inplacePrompt.ask;
  let calls = 0;
  _inplacePrompt.ask = async (_q: string) => {
    const a = answers[calls] ?? "";
    calls += 1;
    const trimmed = a.trim().toLowerCase();
    return trimmed === "y" || trimmed === "yes";
  };
  return {
    restore: () => { _inplacePrompt.ask = orig; },
    callCount: () => calls,
  };
}

// ---------------------------------------------------------------------------
// detectGitTreeState
// ---------------------------------------------------------------------------

test("detectGitTreeState: non-git directory returns no-repo", () => {
  const ws = makeWs();
  try {
    assert.equal(detectGitTreeState(ws), "no-repo");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("detectGitTreeState: clean git tree returns clean", () => {
  if (!HAS_GIT) return;
  const ws = makeWs();
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: ws });
    spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
    spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: ws });
    assert.equal(detectGitTreeState(ws), "clean");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("detectGitTreeState: dirty git tree returns dirty", () => {
  if (!HAS_GIT) return;
  const ws = makeWs();
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    writeFileSync(join(ws, "untracked.txt"), "hi");
    assert.equal(detectGitTreeState(ws), "dirty");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatInplaceWarning: three required variants, each names directory + recovery posture
// ---------------------------------------------------------------------------

test("formatInplaceWarning: clean variant names directory and points at git restore", () => {
  const msg = formatInplaceWarning("/tmp/example", "clean");
  assert.ok(msg.includes("/tmp/example"), "names workspace directory");
  assert.ok(msg.includes("in-place mode"), "labels the mode");
  assert.ok(msg.includes("git restore") || msg.includes("git reset"), "names recovery command");
  assert.ok(msg.includes("clean"), "describes clean state");
  assert.ok(
    msg.includes("Everything outside this directory stays sandboxed"),
    "still reminds the user the machine boundary holds",
  );
});

test("formatInplaceWarning: leads with workspace-only access scope after the header", () => {
  const msg = formatInplaceWarning("/tmp/example", "clean");
  // The first line after the header must state the access scope in plain language.
  const lines = msg.split("\n");
  assert.ok(lines[1].includes("Filesystem access:"), "second line states filesystem access scope");
  assert.ok(lines[1].includes("this workspace directory only"), "scope is workspace-only");
  assert.ok(lines[1].includes("/tmp/example"), "scope names the directory");
  assert.ok(lines[1].includes("Docker sandbox"), "scope says the rest stays in the Docker sandbox");
  // Typo guard: the tail must read "the rest", never "therest".
  assert.ok(msg.includes("the rest of your machine"), "tail reads 'the rest of your machine'");
  assert.ok(!msg.includes("therest"), "no 'therest' typo");
});

test("formatInplaceWarning: dirty variant warns about mixed-in changes and not-cleanly-undoable", () => {
  const msg = formatInplaceWarning("/tmp/example", "dirty");
  assert.ok(msg.includes("/tmp/example"));
  assert.ok(msg.includes("uncommitted"), "calls out uncommitted changes");
  assert.ok(
    msg.includes("can't be cleanly undone") || msg.includes("cleanly undone"),
    "states the not-cleanly-undoable posture",
  );
  assert.ok(msg.includes("commit") || msg.includes("stash"), "suggests commit/stash");
});

test("formatInplaceWarning: no-repo variant states irreversibility and suggests git init", () => {
  const msg = formatInplaceWarning("/tmp/example", "no-repo");
  assert.ok(msg.includes("/tmp/example"));
  assert.ok(msg.includes("No git repository"), "calls out the missing repo");
  assert.ok(msg.includes("irreversible"), "states irreversibility");
  assert.ok(msg.includes("git init"), "suggests git init");
});

// ---------------------------------------------------------------------------
// confirmInplaceRun: gate behavior
// ---------------------------------------------------------------------------

test("confirmInplaceRun: JAIPH_INPLACE_YES=1 auto-confirms without calling the prompt", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  const cap = captureStderr();
  try {
    const ok = await confirmInplaceRun(ws, { JAIPH_INPLACE_YES: "1" }, true);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 0, "prompt must not be invoked when auto-confirmed");
    assert.equal(cap.data(), "", "no warning printed on auto-confirm");
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: JAIPH_INPLACE_YES=true also auto-confirms", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  try {
    const ok = await confirmInplaceRun(ws, { JAIPH_INPLACE_YES: "true" }, true);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 0);
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: TTY + user answers yes → returns true (launches)", async () => {
  const ws = makeWs();
  const spy = stubPrompt(["y"]);
  const cap = captureStderr();
  try {
    const ok = await confirmInplaceRun(ws, {}, true);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 1, "prompt invoked exactly once");
    assert.ok(cap.data().includes("in-place mode"), "warning printed before prompt");
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: TTY + user answers no → returns false (aborts cleanly, no launch)", async () => {
  const ws = makeWs();
  const spy = stubPrompt(["n"]);
  const cap = captureStderr();
  try {
    const ok = await confirmInplaceRun(ws, {}, true);
    assert.equal(ok, false);
    assert.equal(spy.callCount(), 1);
    assert.ok(cap.data().includes("in-place mode"));
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: TTY + empty answer defaults to no", async () => {
  const ws = makeWs();
  const spy = stubPrompt([""]);
  const cap = captureStderr();
  try {
    const ok = await confirmInplaceRun(ws, {}, true);
    assert.equal(ok, false);
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: non-TTY without JAIPH_INPLACE_YES throws E_DOCKER_INPLACE_NO_CONFIRM", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  try {
    await assert.rejects(
      () => confirmInplaceRun(ws, {}, false),
      /E_DOCKER_INPLACE_NO_CONFIRM/,
    );
    assert.equal(spy.callCount(), 0, "prompt is never invoked in non-TTY path");
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: non-TTY + JAIPH_INPLACE_YES=1 still proceeds", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  try {
    const ok = await confirmInplaceRun(ws, { JAIPH_INPLACE_YES: "1" }, false);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 0);
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: warning text adapts to git state (no-repo variant printed for non-git workspace)", async () => {
  const ws = makeWs();
  const spy = stubPrompt(["n"]);
  const cap = captureStderr();
  try {
    await confirmInplaceRun(ws, {}, true);
    const out = cap.data();
    assert.ok(out.includes("No git repository"), "no-repo branch printed");
    assert.ok(out.includes(ws), "workspace path named in warning");
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: warning text uses clean variant for clean git tree", async () => {
  if (!HAS_GIT) return;
  const ws = makeWs();
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: ws });
    spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
    spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: ws });
    const spy = stubPrompt(["n"]);
    const cap = captureStderr();
    try {
      await confirmInplaceRun(ws, {}, true);
      const out = cap.data();
      assert.ok(out.includes("clean"), "clean branch printed");
      assert.ok(out.includes("git restore") || out.includes("git reset"), "clean branch names recovery command");
    } finally {
      cap.restore();
      spy.restore();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmInplaceRun: warning text uses dirty variant for dirty git tree", async () => {
  if (!HAS_GIT) return;
  const ws = makeWs();
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    writeFileSync(join(ws, "untracked.txt"), "hi");
    const spy = stubPrompt(["n"]);
    const cap = captureStderr();
    try {
      await confirmInplaceRun(ws, {}, true);
      const out = cap.data();
      assert.ok(out.includes("uncommitted"), "dirty branch printed");
      assert.ok(out.includes("commit") || out.includes("stash"), "dirty branch suggests commit/stash");
    } finally {
      cap.restore();
      spy.restore();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatUnsafeWarning: stronger than inplace — whole machine, no sandbox, secrets
// ---------------------------------------------------------------------------

test("formatUnsafeWarning: states host-only / no sandbox and whole-machine filesystem reach", () => {
  const msg = formatUnsafeWarning("/tmp/example", "clean");
  assert.ok(msg.includes("unsafe mode"), "labels the mode");
  assert.ok(msg.includes("NO sandbox"), "states no sandbox");
  assert.ok(msg.includes("host"), "states host-only");
  assert.ok(msg.includes("ENTIRE machine"), "states whole-filesystem reach");
  assert.ok(msg.includes("secrets"), "warns scripts/agents can read env secrets");
  assert.ok(
    msg.includes("outside this project"),
    "warns scripts/agents can reach paths outside the project",
  );
  assert.ok(
    msg.includes("more exposure than --inplace"),
    "frames unsafe as strictly more exposure than inplace, not a lighter variant",
  );
});

test("formatUnsafeWarning: carries the three git-state variants (dirty especially dangerous)", () => {
  const clean = formatUnsafeWarning("/tmp/example", "clean");
  assert.ok(clean.includes("git restore") || clean.includes("git reset"), "clean names recovery command");
  const dirty = formatUnsafeWarning("/tmp/example", "dirty");
  assert.ok(dirty.includes("uncommitted"), "dirty calls out uncommitted changes");
  const noRepo = formatUnsafeWarning("/tmp/example", "no-repo");
  assert.ok(noRepo.includes("No git repository"), "no-repo calls out the missing repo");
  assert.ok(noRepo.includes("irreversible"), "no-repo states irreversibility");
});

// ---------------------------------------------------------------------------
// confirmUnsafeRun: gate behavior (mirrors confirmInplaceRun)
// ---------------------------------------------------------------------------

test("confirmUnsafeRun: JAIPH_INPLACE_YES=1 auto-confirms without calling the prompt", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  const cap = captureStderr();
  try {
    const ok = await confirmUnsafeRun(ws, { JAIPH_INPLACE_YES: "1" }, true);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 0, "prompt must not be invoked when auto-confirmed");
    assert.equal(cap.data(), "", "no warning printed on auto-confirm");
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmUnsafeRun: TTY + user answers yes → returns true (proceeds host-only)", async () => {
  const ws = makeWs();
  const spy = stubPrompt(["y"]);
  const cap = captureStderr();
  try {
    const ok = await confirmUnsafeRun(ws, {}, true);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 1, "prompt invoked exactly once");
    assert.ok(cap.data().includes("unsafe mode"), "unsafe warning printed before prompt");
    assert.ok(cap.data().includes("NO sandbox"), "warning states no sandbox");
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmUnsafeRun: TTY + user answers no → returns false (aborts cleanly)", async () => {
  const ws = makeWs();
  const spy = stubPrompt(["n"]);
  const cap = captureStderr();
  try {
    const ok = await confirmUnsafeRun(ws, {}, true);
    assert.equal(ok, false);
    assert.equal(spy.callCount(), 1);
    assert.ok(cap.data().includes("unsafe mode"));
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmUnsafeRun: TTY + empty answer defaults to no", async () => {
  const ws = makeWs();
  const spy = stubPrompt([""]);
  const cap = captureStderr();
  try {
    const ok = await confirmUnsafeRun(ws, {}, true);
    assert.equal(ok, false);
  } finally {
    cap.restore();
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmUnsafeRun: non-TTY without JAIPH_INPLACE_YES throws E_UNSAFE_NO_CONFIRM", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  try {
    await assert.rejects(
      () => confirmUnsafeRun(ws, {}, false),
      /E_UNSAFE_NO_CONFIRM/,
    );
    assert.equal(spy.callCount(), 0, "prompt is never invoked in non-TTY path");
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("confirmUnsafeRun: non-TTY + JAIPH_INPLACE_YES=1 still proceeds", async () => {
  const ws = makeWs();
  const spy = stubPrompt([]);
  try {
    const ok = await confirmUnsafeRun(ws, { JAIPH_INPLACE_YES: "1" }, false);
    assert.equal(ok, true);
    assert.equal(spy.callCount(), 0);
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

void readFileSync;
