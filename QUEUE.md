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

## Fix: Accept triple-quoted call args; never silently shell-fall back incomplete `run`/`return run` calls #dev-ready

**Problem:** Authors naturally write multiline managed calls with a triple-quoted string argument, e.g.:

```jaiph
return run review_scope(
  "codebase",
  """
  Review the ENTIRE repository…
  """,
  report_file
)
```

Two failures compound:

1. **Grammar gap.** `docs/grammar.md` `call_arg` allows only `double_quoted_string | IDENT | IDENT.IDENT | run … | ensure …` — **not** `triple_quoted_block`, even though triple-quoted literals are first-class in `const`, `return`, `log`/`fail`, `prompt`, and match arms. Call sites that need multiline text are forced into a `const` binding first (workaround used in `.jaiph/security_review.jh`).
2. **Silent shell fallback (the real bug).** When the parser does not recognize the multiline / triple-quoted call form, it does **not** emit `E_PARSE`. The line with the opening `return run review_scope(` (or similar) is treated as a free-form workflow shell step (`sh_line_<N>`). `jaiph compile` can still succeed (or the failure is deferred), and `jaiph run` then dies at runtime with an opaque shell error such as `sh: 1: Syntax error: "(" unexpected`. That is a language/runtime contract violation: unrecognized managed syntax must fail at compile time with `path:line:col CODE message`, never become a shell step.

Observed in practice while running `.jaiph/security_review.jh` under Docker: step `script sh_line_147` failed with `Syntax error: "(" unexpected` instead of a compile diagnostic.

**Required behavior:**

* Extend `call_arg` to accept `triple_quoted_block` (same dedent / `${…}` interpolation rules as other triple-quoted positions). Applies to `run`, `ensure`, `return run`, `return ensure`, nested `run`/`ensure` call args, and inline-script arg lists wherever `call_arg` is used.
* Multiline managed calls whose `(` … `)` span multiple source lines must parse when each argument is a valid `call_arg` (including triple-quoted blocks and bare identifiers). Prefer documenting and testing the form used above (`return run name(\n  …\n)`).
* Any line that *looks like* a managed call start (`run` / `ensure` / `return run` / `return ensure` with an identifier and `(`) but cannot be completed as a valid call **must** be `E_PARSE` (or `E_VALIDATE` only when the shape is unambiguous but a name/arity/scope rule fails). It must **never** become a workflow shell (`sh_line_*`) step.
* Double-quoted single-line call args, bare ids, nested `run`/`ensure`, and existing shell-line workflows that are *intentionally* free-form shell (no `run`/`ensure`/`return` keyword prefix) keep working unchanged.
* Update `docs/grammar.md` (`call_arg` production) and `docs/language.md` (call-argument table) to list triple-quoted blocks; call out that incomplete managed calls are hard errors, not shell.

**Implementation sketch:**

* Parser path that builds call argument lists (workflow brace / call parsing under `src/parse/`) — accept triple-quoted blocks as `Arg` literals; ensure multiline `(` … `)` consumption does not abort into the “unrecognised line → shell step” branch mid-call.
* Wherever workflow body lines fall through to `Expr.shell` / inline shell steps: if the line (or an open multiline call buffer) begins with a managed-call prefix, emit `E_PARSE` with a message that names the problem (e.g. unclosed `(`, unsupported argument form) instead of recording a shell step.
* Formatter (`src/format/emit.ts`) — emit triple-quoted call args when the AST has them; round-trip the multiline call shape if the author wrote it that way (or document intentional normalization).
* Validator — reuse existing literal `${…}` / unknown-ident checks for the new arg form; no special-case needed beyond treating them like other string literal args.

Acceptance:

* **Positive compile:** `jaiph compile` accepts a workflow containing `return run helper("x", """line1\nline2""", y)` (and the same with `run` / `ensure` statement forms) where `helper` / rule / script is declared with matching arity; emitted runtime graph has a managed call with three args — **no** `sh_line_*` step.
* **Multiline form:** the exact multiline `return run name(\n  "a",\n  """…""",\n  ident\n)` shape compiles and runs; capture/`return` value is the callee’s return value.
* **Negative compile (the bug lock):** a deliberately broken managed call that previously became shell — e.g. `return run missing_close(` alone, or a call with an argument form that is still illegal — yields `E_PARSE` (or documented `E_VALIDATE`) from `jaiph compile` / txtar, **exit non-zero**, and must **not** produce a `sh_line_*` script in the runtime graph. Add a txtar case under `test-fixtures/compiler-txtar/` (parse-errors or validate-errors as appropriate) that fails if shell fallback returns.
* **Unit / golden:** parser unit test that a triple-quoted call arg is stored as `Arg` literal (not shell); optional golden-ast fixture if the repo still maintains golden AST for call shapes.
* **Docs:** `docs/grammar.md` and `docs/language.md` updated; no “triple-quoted only via const” workaround required in docs examples for call args.
* `npm test` and `npm run test:e2e` pass (add a focused e2e only if unit/txtar cannot cover the runtime path; prefer txtar + unit for the compile-time contract).

***

## Fix: MCP sandbox parity with `jaiph run` — default Docker isolation, not inplace #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 2 (MEDIUM, ASI-03).

**Problem:** `selectMcpSandboxMode` (`src/runtime/docker.ts`) defaults MCP tool calls to **`inplace`** (host workspace bind-mounted `:rw`) when nothing is set. `jaiph run` defaults to **`overlay`/`copy`** isolation and only enters inplace when `JAIPH_INPLACE` is truthy. MCP therefore inverts the CLI default: the same workflow is workspace-isolated under `jaiph run` but mutates the live tree under `jaiph mcp`. That violates **principle of least surprise** and widens blast radius when prompt output reaches shell/file writes (Finding 1).

Current comments in `src/cli/commands/mcp.ts` and `selectMcpSandboxMode` intentionally document the inverted default; that decision is wrong for least surprise and must be reversed.

**Required behavior:**

* MCP sandbox **mode selection must match `jaiph run`**: reuse `selectSandboxMode` (or make `selectMcpSandboxMode` an alias/delegate with identical semantics). Default = Docker on + `overlay` when `/dev/fuse` is available else `copy`; **`inplace` only when `JAIPH_INPLACE=1|true`**.
* Docker remains the default for MCP when Docker is available — same enablement rules as `jaiph run` (`JAIPH_UNSAFE` / `JAIPH_DOCKER_ENABLED`). No special-case “MCP defaults to live host writes.”
* Startup banner / logs state the resolved mode accurately (isolated vs inplace path). Inplace must be clearly labeled as opt-in live writes.
* Update `docs/mcp.md`, `docs/sandboxing.md` / `docs/sandbox-run.md` as needed, and remove “MCP inverts the jaiph run default” wording from code comments.
* `JAIPH_DOCKER_NO_OVERLAY` continues to force `copy` for both `run` and `mcp`.

**Implementation sketch:**

* `src/runtime/docker.ts` — collapse MCP mode selection onto `selectSandboxMode`; delete or deprecate the inverted `selectMcpSandboxMode` body.
* `src/cli/mcp/call.ts`, `src/cli/commands/mcp.ts` — call the shared selector; fix banner strings.
* Tests: unit tests for mode selection env matrix; update `e2e/tests/141_mcp_docker_sandbox.sh` / `integration/mcp-server.test.ts` expectations that assumed inplace-by-default.

Acceptance:

* With no sandbox env set, `jaiph mcp` tool calls use `overlay` or `copy` (never `inplace`); workspace mutations in the container do not land on the host workspace.
* `JAIPH_INPLACE=1 jaiph mcp …` uses inplace and logs that writes land live on the workspace path.
* Mode-selection unit tests assert MCP and `jaiph run` share the same truth table for `JAIPH_INPLACE` / `JAIPH_DOCKER_NO_OVERLAY` / fuse presence.
* Docs no longer claim MCP defaults to inplace.
* `npm test` and `npm run test:e2e` pass.

***

## Feat: Warn (and document) when prompt-derived values are interpolated into shell steps #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 1 (MEDIUM, ASI-01/ASI-02).

**Problem:** Workflow shell fallthrough runs `sh -c` on an interpolated command string (`executeShLine` in `src/runtime/kernel/node-workflow-runtime.ts`). A `${var}` that originated from a `prompt` capture is spliced in with no quoting or validation. In the default Docker sandbox this is contained; under `--unsafe` / inplace it becomes host-impacting command injection. Authors today have no compile-time signal and little docs guidance to prefer argv-passing into `script` steps (already safe).

**Required behavior:**

* Document the hazard prominently (language + sandboxing / first-agent docs): prefer `run script(capture)` argv over embedding `${capture}` in shell lines; note that scripts spawn by argv.
* Emit a compile-time **warning** (or `E_VALIDATE` if the project already has a warning channel — prefer non-fatal warning if available; otherwise a documented opt-in lint) when a shell step’s command interpolates a binding known to be a typed/untyped `prompt` capture in the same workflow scope.
* Optional stretch (include if small): a shell-quoting interpolation form or helper so the safe path is easy — only if it fits existing string/interp design without a large grammar change; otherwise leave as a follow-up note in docs.

Acceptance:

* Docs describe the prompt→shell data-flow hazard and the argv-safe pattern with a minimal example.
* A workflow that does `const x = prompt "…"` then a shell line containing `${x}` produces a visible compile diagnostic (warning or error — pick one, test it).
* Equivalent workflow that passes `x` as a script argument does **not** produce that diagnostic.
* `npm test` covers the diagnostic; e2e only if compile-path tests cannot assert it.

***

## Feat: Hash-chain `run_summary.jsonl` and redact secrets in run artifacts #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 4 (LOW, ASI-06).

**Problem:** Structured run events are written under `.jaiph/runs` (mounted writable at `/jaiph/run` inside the sandbox). There is no hash chain, so a misbehaving agent can rewrite its own audit trail. Prompt/command artifacts persist interpolated secrets in cleartext.

**Required behavior:**

* Each `run_summary.jsonl` line includes a hash of the previous line’s payload (or a running chain field) so truncation/rewrite is detectable by a verifier.
* Ship a small verify helper or `jaiph` subcommand/docs recipe that validates the chain for a run dir.
* Redact values of known credential env keys (the Docker allowlist / backend credential names) from persisted prompt bodies and reconstructed command lines before write.
* Document the chain format and redaction scope in architecture or artifacts docs.

Acceptance:

* Unit test: append two events, tamper with the first line on disk, verifier fails; untampered chain passes.
* Unit test: artifact write path redacts a fixture `ANTHROPIC_API_KEY` (or equivalent) value present in prompt text.
* Docs describe the chain field and how to verify.
* `npm test` passes.

***

## Feat: Sign release checksums and pin Dockerfile toolchain installers #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 5 (LOW, ASI-09).

**Problem:** `docs/install` verifies SHA-256 against `SHA256SUMS` from the same origin (TOFU, no detached signature). `runtime/Dockerfile` installs toolchains via unpinned `curl | sh`/`bash`.

**Required behavior:**

* Publish and verify a detached signature over `SHA256SUMS` (cosign or minisign — pick one and document) in the install scripts.
* Pin toolchain installers in `runtime/Dockerfile` to known content hashes (or fixed version URLs + checksum verify) before execute; no raw pipe-to-shell without verification.
* Document the trust model in contributing/release docs.

Acceptance:

* Installer fails closed when the signature is missing or invalid (tested with a fixture or mocked download in CI where feasible).
* Dockerfile build path does not execute unverified remote install scripts (grep/test lock).
* Docs describe how releases are signed and how users verify.
* Relevant CI / `npm test` hooks pass.

***

## Fix: Lock `agent.command` / `agent.backend` against untrusted imported module metadata #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 6 (LOW, ASI-03/ASI-09).

**Problem:** `applyMetadataScope` can set `JAIPH_AGENT_COMMAND` from an imported module’s metadata unless `JAIPH_AGENT_COMMAND_LOCKED=1`. A third-party `.jh` library can therefore change which binary the cursor backend spawns for `prompt` steps without attestation.

**Required behavior:**

* Imported-module metadata must **not** override `agent.command` / `agent.backend` (and equivalent env keys) by default.
* Only the entry module’s config (or an explicit unlock / allowlist flag documented for advanced use) may set those keys for the run.
* Existing `*_LOCKED` gates remain; defaults become safe without requiring the caller to pre-lock.

Acceptance:

* Test: entry workflow imports a module that sets `agent.command` to a distinct binary; prompt execution still uses the entry/default command unless explicitly opted in.
* Test: entry module setting `agent.command` still works.
* Docs note the trust boundary for execution-config keys on import.
* `npm test` passes.

***

## Fix: Forward only backend-specific credential env keys into the Docker sandbox #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 7 (LOW).

**Problem:** `ENV_ALLOW_PREFIXES` forwards entire `ANTHROPIC_*` / `CURSOR_*` / `CLAUDE_*` / `OPENAI_*` / `JAIPH_*` families into the container. Any host secret matching those prefixes is visible to sandboxed code and exfiltratable if prompt→shell injection lands inside the container.

**Required behavior:**

* Forward only the specific keys required by the resolved agent backend (document the allowlist per backend), not whole prefix families — except `JAIPH_*` run-control keys that the runtime itself needs (keep those as a tight enumerated or clearly justified prefix).
* `--env` / explicit passthrough remains an intentional escape hatch and is documented as such.
* Unit tests lock the forwarded key set for each backend.

Acceptance:

* With unrelated `ANTHROPIC_UNUSED=…` on the host and backend=claude, that key is **not** present in the container env in tests.
* Required keys for the active backend still forward.
* Docs list per-backend credential keys and the `--env` bypass.
* `npm test` passes.

***

## Fix: Prefer `copy` over elevated overlay defaults; document overlay capability posture #dev-ready

**Source:** `.jaiph/security_review_2026-07-20.md` Finding 3 (LOW, ASI-03/ASI-05).

**Problem:** Overlay mode starts as root with `SYS_ADMIN` and (on Linux) `apparmor=unconfined` to mount fuse-overlayfs, then drops privileges. That is a larger kernel attack surface than `copy` for the same isolation guarantee.

**Required behavior:**

* Re-evaluate default mode selection: prefer `copy` as the default when the isolation guarantee is equivalent, **or** keep overlay only where it is a clear win and document why — but do not leave AppArmor `unconfined` unexplained. If overlay remains default on fuse hosts, add a tailored AppArmor profile (or document tracked follow-up with a linked issue) and surface the elevated posture in sandbox docs.
* Sandbox docs state clearly: overlay elevates during setup; `copy` does not; when to force `JAIPH_DOCKER_NO_OVERLAY=1`.

Acceptance:

* Docs accurately describe overlay caps / AppArmor / UID drop vs copy.
* Either (a) default mode changes to `copy` with tests updated, or (b) overlay default remains but AppArmor is not blanket `unconfined` (profile or explicit tracked exception with test locking the chosen posture).
* `npm test` / relevant e2e sandbox tests pass.

***
