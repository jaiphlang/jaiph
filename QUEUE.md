# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Require explicit unsafe consent flag for mcp/serve host-only mode #dev-ready

Context: Security review 2026-07-31, finding M-1 (ASI-04 Unauthorized Escalation), severity MEDIUM, confidence 0.85. `jaiph run` gates host-only execution behind an interactive confirmation, but the long-lived server modes do not.

Problem: `resolveStartupPosture` builds the runtime env by spreading `process.env`, so an inherited/exported `JAIPH_UNSAFE=true` (e.g. left over in a shell profile from an earlier host-only `jaiph run`) silently switches `jaiph mcp ./untrusted.jh` or `jaiph serve` into host-only execution. Every tool call then runs on the host with full filesystem and credential access, unsandboxed, with only a single stderr log line — no prompt, no explicit consent.

Location: `src/cli/shared/generation.ts:177-186` (posture resolution spreads `process.env`); contrast the consent gate in `src/cli/commands/run.ts:209-220` and `src/runtime/docker-inplace.ts:102-129`.

Remediation: Apply the same consent gate to `mcp`/`serve` as `run` has: host-only execution requires `--unsafe` (or `--yes`) passed on the server's own command line, and an inherited ambient `JAIPH_UNSAFE=true` without that explicit flag is refused (startup error) rather than honored. If host-only mode is entered, print a loud, non-suppressible startup banner instead of one stderr log line.

### Acceptance criteria
- Starting `jaiph mcp` or `jaiph serve` with `JAIPH_UNSAFE=true` in the environment but without an explicit unsafe CLI flag exits with an error (does not start host-only), verified by a test.
- Starting `jaiph mcp`/`jaiph serve` with the explicit unsafe CLI flag runs host-only and emits a prominent startup banner stating that sandboxing is disabled, verified by a test asserting the banner text.
- Without `JAIPH_UNSAFE` and without the flag, `mcp`/`serve` behavior is unchanged (sandboxed default), verified by an existing or new test.
- `docs/env-vars.md` documents the new `JAIPH_UNSAFE` semantics for server modes.

## Make serve anonymous loopback auth an explicit opt-in #dev-ready

Context: Security review 2026-07-31, finding M-2 (ASI-04/ASI-07), severity MEDIUM, confidence 0.8. When neither `JAIPH_SERVE_TOKEN` nor OIDC is configured, `serve` runs in auth mode `none` on loopback with no warning.

Problem: In mode `none`, every request is authorized as an anonymous principal holding all capabilities (`invoke`, `inspect`, `cancel`) over all runs. On a shared or multi-user host, any other local user or process can `POST http://127.0.0.1:5247/v1/workflows/{name}/runs` or hit `/mcp` and execute arbitrary exposed workflows and read every run's artifacts — loopback is a boundary against the network, not against other local users. Only a non-loopback bind without auth is currently a startup error.

Location: `src/cli/serve/auth.ts:99-101` (`openPrincipal` returns `capabilities: new Set(ALL_CAPABILITIES), ownsAllRuns: true`) and `src/cli/serve/auth.ts:294-303` (mode `none`); guard at `src/cli/commands/serve.ts:171-178`.

Remediation: Require an explicit `--allow-anonymous` flag before binding even loopback with no configured auth; without the flag and without `JAIPH_SERVE_TOKEN`/OIDC, startup fails with an actionable error. When `--allow-anonymous` is passed, log an explicit startup warning that the server is open to all local principals, and document in the serve docs that shared hosts must use `JAIPH_SERVE_TOKEN` or OIDC.

### Acceptance criteria
- `jaiph serve` on loopback with no `JAIPH_SERVE_TOKEN`, no OIDC config, and no `--allow-anonymous` flag exits with a startup error, verified by a test.
- `jaiph serve --allow-anonymous` starts, serves anonymous requests as before, and emits a startup warning about the open-auth posture, verified by a test asserting the warning.
- `serve` with `JAIPH_SERVE_TOKEN` or OIDC configured starts without requiring the flag and behaves as before, verified by existing or new tests.
- Serve documentation states that anonymous mode is single-user-workstation only and shared hosts require token or OIDC auth.

## Store audit chain key outside the run directory and fail closed on key loss #dev-ready

Context: Security review 2026-07-31, finding M-3 (ASI-06 Insufficient Logging), severity MEDIUM, confidence 0.7. The journal's keyed-HMAC tamper evidence can be silently disabled by the workflow it is meant to constrain.

Problem: The per-run HMAC key is persisted as `.chain-key` inside the run directory, which is agent-writable (`$JAIPH_RUN_DIR` for script steps; bind-mounted `rw` at `/jaiph/run` in Docker). A malicious workflow's first script step runs `mkdir "$JAIPH_RUN_DIR/.chain-key"`, squatting the path as a directory; at finalize the host's `writeFileSync` throws `EISDIR`, which `writeChainKey` swallows. `readChainKey` then returns `null`, `verifyRunJournal` fails open (`verified:false, ok:true`), and the workflow can rewrite or delete `run_summary.jsonl` to erase evidence — the mangled journal is still exported to OTLP/Sentry and served over `/v1/runs/{id}/events` with no integrity failure.

Location: `src/runtime/kernel/emit.ts:52-58` (`writeChainKey` swallows all write errors) and `src/runtime/kernel/emit.ts:119-124` (`verifyRunJournal` fails open when no key is present); host call sites `src/cli/exec/call.ts:248` and `src/cli/commands/run.ts:637` write `.chain-key` into the run directory.

Remediation: Store the chain key outside the agent-writable run directory (a host-side sidecar keyed by run id, e.g. under the operator's `.jaiph` state root that is never mounted into the container). Make `writeChainKey` failure a hard error instead of best-effort. For runs launched with a host key, treat a missing key at verify/export time as an integrity failure (fail closed) rather than "not verified".

### Acceptance criteria
- The chain key file is no longer written under the run directory; a test asserts the run directory contains no `.chain-key` after a completed run and that the key exists in the host-side location.
- A test simulating the squat (pre-creating a directory at the old in-run-dir key path) shows key persistence and journal verification unaffected.
- A failure to persist the chain key surfaces as a hard error, verified by a test that forces the write to fail.
- For a run that was launched with a chain key, `verifyRunJournal` (and the OTLP/Sentry/serve export boundaries) reports an integrity failure when the key is missing at verification time, verified by a test.

## Pin registry stdlib entry to a commit and enforce the pin on install #dev-ready

Context: Security review 2026-07-31, finding M-4 (ASI-09 Supply Chain), severity MEDIUM, confidence 0.75. `jaiph install jaiphlang` executes whatever the mutable branch HEAD points at.

Problem: The registry schema makes `commit` and `signature` optional, and the shipped `jaiphlang` entry has neither, so `jaiph install` runs `git clone --depth 1 --branch <ref>` against a mutable ref with no integrity gate before the cloned `.jh` modules become importable, executable code. Anyone able to move the `jaiphlang` repo's default branch — repo compromise, maintainer-account takeover, malicious force-push — gains code execution in every consumer that installs or updates the stdlib afterward.

Location: `docs/registry` (the `jaiphlang` entry lacks `commit`/`signature`); `src/cli/commands/registry.ts:29-34` (both fields optional); `src/cli/commands/install.ts:213-219` (clone by branch) and `src/cli/commands/install.ts:188` (commit match enforced only when `expectedCommit` is set).

Remediation: Require a pinned `commit` (and ideally a `signature` over it against the embedded registry key) for every shipped registry entry including the stdlib; make `postCloneHygiene` enforce the commit match unconditionally; treat an entry with no pin as untrusted — warn or refuse to install it.

### Acceptance criteria
- The shipped registry index pins the `jaiphlang` entry to an exact commit, and registry build/validation rejects shipped entries without a `commit`.
- `jaiph install` fails (or requires an explicit override with a warning) for a registry entry that has no pinned commit, verified by a test.
- A test where the cloned HEAD does not match the pinned commit shows the install failing and leaving no importable modules behind.
- Installing an entry whose clone matches the pinned commit succeeds, verified by a test.

## Require signature verification in CI installer and setup-jaiph action #dev-ready

Context: Security review 2026-07-31, finding M-5 (ASI-09 Supply Chain), severity MEDIUM, confidence 0.75. The entire CI install population currently skips the only out-of-band integrity check.

Problem: The installer downgrades to checksum-only when `CI` is set and `minisign` is absent — exactly the state of the official `setup-jaiph` action, which never installs minisign. An attacker who can write release assets or MITM the download serves a malicious binary plus a matching `SHA256SUMS`; the checksum passes (it was computed over the malicious bytes) and the signature step is silently skipped for the entire CI population. The release workflow compounds this by publishing unsigned artifacts when the signing secret is unset.

Location: `docs/install:275-284` (the `[ -n "${CI:-}" ]` checksum-only branch), mirrored in `docs/install.ps1`; `actions/setup-jaiph/setup.sh:48-51` (never installs minisign); `.github/workflows/release.yml:204-208` (skips `.minisig` when the signing secret is unset).

Remediation: Make the `setup-jaiph` action install `minisign` (or a vendored verifier) and require signature verification even under `CI`. Reserve checksum-only for an explicit, loudly-logged `JAIPH_ALLOW_UNSIGNED=1` opt-in instead of defaulting into it whenever `CI` is set (apply to both `docs/install` and `docs/install.ps1`). Fail the release build if the signing secret is unset rather than publishing unsigned.

### Acceptance criteria
- With `CI=true` and no `JAIPH_ALLOW_UNSIGNED`, the installer fails when minisign verification cannot be performed (missing tool or missing `.minisig`) instead of falling back to checksum-only, verified by an e2e installer test.
- With `JAIPH_ALLOW_UNSIGNED=1`, the installer proceeds checksum-only and prints a prominent warning, verified by a test.
- `actions/setup-jaiph/setup.sh` installs or vendors a minisign verifier so the action path performs signature verification, verified by the action e2e test.
- `.github/workflows/release.yml` fails when the signing secret is unset instead of publishing unsigned artifacts.
- `docs/env-vars.md` documents `JAIPH_ALLOW_UNSIGNED`.

## Pin sandbox runtime image by digest and verify on every run #dev-ready

Context: Security review 2026-07-31, finding M-6 (ASI-09/ASI-05), severity MEDIUM, confidence 0.8. The sandbox image is the load-bearing boundary between untrusted workflows and the host, but its integrity is never verified.

Problem: The runtime image is referenced as `ghcr.io/jaiphlang/jaiph-runtime:<version>` — a mutable tag — pulled with no digest check, and the pull is skipped entirely whenever an image with that tag already exists locally, with no re-verification. A registry compromise or tag re-point substitutes the sandbox rootfs, or a local attacker poisons the cached image under the same tag once, after which every subsequent run reuses it verbatim; a malicious rootfs means the sandbox provides no isolation at all.

Location: `src/runtime/docker.ts:104,108` (image reference by tag), `src/runtime/docker.ts:320-326` (`docker pull --quiet` with no digest check), `src/runtime/docker.ts:328-330` (`pullImageIfNeeded` skips the pull if the tag exists locally); `verifyImageHasJaiph` at `src/runtime/docker.ts:392` checks only that a `jaiph` binary exists.

Remediation: Pin the runtime image by `@sha256:` digest baked into the release and verify the resolved local image digest on every run, including cache hits (or verify a cosign/notation signature on the image before use). Fail closed when the resolved digest does not match the expected one.

### Acceptance criteria
- The expected runtime image digest ships with the release, and container runs resolve/pull the image by that digest rather than by mutable tag alone.
- A run using a locally-cached image whose digest does not match the expected digest fails closed with a clear error, verified by a test (e.g. tagging a different image with the runtime tag).
- A run with a matching digest proceeds normally, including the cache-hit path, verified by a test.
- The digest-mismatch error message tells the operator how to recover (e.g. re-pull the pinned image).
