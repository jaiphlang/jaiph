# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed
   by `pick_task` or by the engineer workflow.
4. Queue changes go through `.jaiph/libs/jaiphlang/queue.py` only: the
   product-owner defs, or the engineer, architect-review and security-review
   workflows. Never by editing this file.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Scope MCP-over-HTTP in-flight calls to the caller #dev-ready

Source: code audit 2026-11-15. Reproduced against the handler.

### Current behavior

`ServeHandler` (`src/cli/serve/handler.ts`) holds one `McpServer` (`src/cli/shared/mcp-server.ts`) for all HTTP clients. `McpServer.inFlight` is a map keyed only by the client-chosen JSON-RPC id. `handleCancelled` looks up `params.requestId` and calls `cancelRun` with no principal check. `handleMcp` requires a capability only for `tools/call` and `tools/list`, so `notifications/cancelled` needs none.

- In OIDC mode, a caller with a valid token and no scopes can POST `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}` and kill another principal's run. Ids are guessable. `docs/cli.md` promises that a principal may cancel only runs it created.
- In any mode, two concurrent `tools/call` requests with the same id overwrite each other's entry. The first to finish deletes it; the other loses progress notifications and cannot be cancelled. An SSE disconnect cancels by id and can kill the wrong call.

### Required behavior

- Over HTTP, in-flight calls are tracked under a server-generated key, or under (principal, id). Two calls with the same client id are independent.
- `notifications/cancelled` over HTTP cancels only a call owned by the same principal and requires the `cancel` capability. Otherwise it is a no-op (still 202).
- An SSE disconnect cancels exactly the call of that request, through a captured handle, not by id lookup.
- stdio MCP behaviour is unchanged.

### Acceptance

- Handler test with two principals: B's `notifications/cancelled` for A's request id does not cancel A's run; A's own cancel does.
- A principal without the `cancel` capability cannot cancel its own call through `/mcp`.
- Two concurrent same-id calls both complete with their own results, and cancelling one leaves the other running.
- SSE hang-up on one of two same-id calls cancels only that one.
- `integration/mcp-server.test.ts`, `integration/serve-server.test.ts`, `integration/serve-auth.test.ts` pass. `docs/cli.md` / `docs/mcp.md` state the rule. CHANGELOG entry under Unreleased.

## Reject cross-origin and wrong-Host requests in jaiph serve #dev-ready

Source: code audit 2026-11-15. `/mcp` accepting `text/plain` was reproduced.

### Current behavior

The default `jaiph serve` binds `127.0.0.1` with auth off. No code under `src/cli/serve` reads the `Origin` or `Host` header. `handleMcp` in `handler.ts` does not check `Content-Type`; REST routes return 415 only when the body is non-empty.

Any web page the developer opens can run `fetch("http://127.0.0.1:5247/mcp", {method:"POST", mode:"no-cors", body:'{"jsonrpc":"2.0","id":1,"method":"tools/call",…}'})`. This is a simple request with no preflight, and the workflow runs with attacker-chosen arguments. A def with no parameters can also be started with an empty-body `POST /{name}`. With DNS rebinding the page can read `/runs`, events and artifacts too. The MCP Streamable HTTP spec requires Origin validation for this reason.

### Required behavior

- If an `Origin` header is present and is not the server's own origin or in an allowlist, respond 403 with a JSON error. Add an allowlist setting (`JAIPH_SERVE_ALLOWED_ORIGINS`, comma separated; document it in `docs/env-vars.md`, which has a parity gate against `src/`).
- When bound to a loopback address, the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the bound port; otherwise 403. When bound to a non-loopback address, add an optional `JAIPH_SERVE_ALLOWED_HOSTS` and skip the check when unset.
- `POST /mcp` and every REST `POST` require `Content-Type: application/json` (parameters allowed), including bodyless POSTs; otherwise 415.
- `/healthz`, `/docs`, `/openapi.json` and the embedded Swagger assets keep working from the same origin. Requests with no `Origin` (curl, MCP clients) keep working.

### Acceptance

- Handler tests: `Origin: https://evil.example` on `/mcp` and on `POST /{name}` gives 403; an allowlisted origin passes; same-origin passes; no `Origin` passes.
- `Host: evil.example:5247` on a loopback bind gives 403; `localhost:<port>` and `127.0.0.1:<port>` pass.
- `Content-Type: text/plain` on `/mcp` gives 415; a bodyless `POST /{name}` without the JSON content type gives 415.
- Swagger UI "try it out" still works (existing serve tests and any docs e2e pass).
- `docs/serve.md` (or the serve section in `docs/cli.md`) documents the checks. CHANGELOG entry under Unreleased with a breaking-change note for bodyless POSTs.

## Keep the audit-chain key out of the workflow leader's environment #dev-ready

Source: code audit 2026-11-15. Reproduced on macOS.

### Current behavior

`jaiph run` puts `JAIPH_CHAIN_KEY` into the environment of the workflow leader (`src/cli/commands/run.ts` around line 150, `src/runtime/kernel/workflow-launch.ts`). The runtime scrubs it from script and prompt child envs, but a child of the same user can read the parent's exec-time environment: a script running `ps eww -p $PPID` (or reading `/proc/$PPID/environ` on Linux) prints `JAIPH_CHAIN_KEY=…` and the backend credentials such as `ANTHROPIC_API_KEY`.

The script also has `JAIPH_RUN_DIR`, so it can forge a journal that verifies. This contradicts `docs/artifacts.md` ("a per-run secret the audited program never sees"), `docs/architecture.md`, and `docs/env-vars.md` ("agent credentials never reaches a script").

### Required behavior

- The chain key reaches the leader the same way `--env` grant values do today (`src/runtime/kernel/env-grant-file.ts`: a `0600` file in a `mkdtemp` directory, read once at start and removed), or over an inherited pipe. It is never in any process's exec-time environment.
- All three launch paths do this: `jaiph run`, `jaiph run --raw`, and the serve/MCP launcher in `src/cli/shared/workflow-call*.ts`.
- Backend credentials: either hand them over the same way, or change the three docs pages to say plainly that a script running as the same OS user can read the leader's environment and that the credential scrub is not a security boundary without OS isolation. Pick the file handover if it is small; otherwise fix the docs and say so in the task report.

### Acceptance

- New e2e test: a script step prints the environment of `$PPID` (`ps eww` on macOS, `/proc/$PPID/environ` on Linux); output does not contain `JAIPH_CHAIN_KEY`.
- The journal of that run still verifies.
- The key file is gone after the leader starts (test asserts the path does not exist during a step).
- Docs match the chosen credential behaviour. `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Kill the whole process tree on step idle-kill and prompt watchdog #dev-ready

Source: code audit 2026-11-15. Reproduced.

### Current behavior

`killProcessTree` in `src/runtime/kernel/portability.ts` calls `process.kill(-pid, signal)`, which works only when the child is a process-group leader. Script children (`node-workflow-runtime.ts`, the script spawn) and agent backends (`prompt-backends.ts`) are spawned without `detached: true`, so the call throws ESRCH and falls back to killing the single pid.

With `JAIPH_STEP_IDLE_KILL_SEC=1`, `script hang = 'sleep 47; echo never'` fails as expected, but `sleep 47` survives with ppid 1 after the run exits. A timed-out agent's tool subprocesses and MCP servers keep running and can keep changing the workspace. The watchdog comment "Terminate the backend and any descendants" is false on POSIX.

### Required behavior

- On POSIX, script and backend children are spawned in their own process group.
- The leader tracks those group ids. On SIGINT/SIGTERM and on run timeout it signals every live child group, so Ctrl-C behaviour stays the same (today it works only because children share the leader's group).
- Idle-kill and the prompt watchdog kill the child's whole group.
- Windows behaviour is unchanged.

### Acceptance

- Real-process test: a script backgrounds a grandchild that writes its pid to a file, then hangs; after idle-kill the grandchild pid is dead.
- Same for a fake agent backend under the prompt watchdog.
- `integration/signal-lifecycle.test.ts` still passes; add a case where SIGINT to `jaiph run` kills a grandchild of a script step.
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Unblock a stdin pipeline when the downstream stage stops reading #dev-ready

Source: code audit 2026-11-15. Reproduced.

### Current behavior

In `node-workflow-runtime.ts` the script spawn tees upstream stdout into a `handoff` PassThrough and pipes it into the next stage's stdin (around lines 2343–2355 and 2411–2418). The upstream stdout is paused when `handoff` is full and resumed only on `drain`. If the consumer exits early or fails to spawn, nothing reads `handoff` and the producer blocks forever.

`const first = stdin gen() -> sink()` with `sink = 'head -c 10'` and a 5 MB producer hangs until `JAIPH_RUN_TIMEOUT`, which is unset by default, so effectively until the 3600 s idle kill. A sink whose shebang interpreter does not exist hangs the same way.

### Required behavior

- When the downstream stdin closes, errors (EPIPE) or the downstream fails to spawn, the upstream stops being back-pressured: either it keeps draining to its `.out` capture only, or its stdout is destroyed so it receives SIGPIPE. Choose one and document it in `docs/language.md` next to the `stdin` pipeline section.
- `handoff` is ended on idle-kill.
- The step result of each stage is settled exactly once.

### Acceptance

- Test: producer larger than 64 KB with a consumer that reads 10 bytes and exits; the pipeline settles within 5 seconds.
- Test: consumer with a missing interpreter; the pipeline fails within 5 seconds with the spawn error.
- Existing pipeline tests and e2e pass. CHANGELOG entry under Unreleased.

## Keep the current-def context per async branch #dev-ready

Source: code audit 2026-11-15. Sender misattribution reproduced.

### Current behavior

`NodeWorkflowRuntime.defCtxStack` (`node-workflow-runtime.ts`, field near line 251) is one array shared by all `async` branches. The frame stack is already isolated per branch with `AsyncLocalStorage`; this one is not. A branch's `pop()` removes whatever is on top, and "current def" is read from the top (lines near 1106, 2530, 2631).

`async fast(); async slow()` where `slow` sleeps and then sends: the receiver gets `sender="fast"` and the journal's `INBOX_ENQUEUE.sender` is `fast`. By reading, `resolveRecoverLimit` and `resolveConfigAgentModel` can apply another branch's def-level `run.recover_limit` or `agent.model`.

### Required behavior

The def context is per async branch: store it in `AsyncLocalStorage` alongside the frame stack, or carry it in `Scope`. Channel route lookup still walks the enclosing defs of the sending branch.

### Acceptance

- Test: two async defs, one slow sender; `sender` in the dispatched message and in the journal is the sending def.
- Test: two async defs with different def-level `agent.model` (and `run.recover_limit`), each interleaved with a sleep; each prompt/recover uses its own def's value (assert through the mock backend / emitted events).
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Capture only the final answer from a multi-turn agent stream #dev-ready

Source: code audit 2026-11-15. Reproduced on a synthetic stream only; step 1 below confirms the real shape.

### Current behavior

`src/runtime/kernel/stream-parser.ts`: every `text_delta` is appended to `state.final` (around line 132), and the terminal `result` event is ignored once any delta was seen. For a claude stream with narration, a tool call and then the answer, the captured value is `"I'll inspect the repo first.APPROVED"`. `if verdict == "APPROVED"` is then false. `returns` schemas usually survive because `extractJson` scans from the end.

### Required behavior

1. Record a real multi-turn stream from the pinned claude CLI (`claude -p --output-format stream-json --include-partial-messages` with a prompt that forces one tool call) and commit it as a fixture under `test-fixtures/`. Do the same for cursor if its stream has turns. If the real stream shows the bug does not occur, report that and add the fixture as a regression test only.
2. The captured value is the text of the last assistant turn: prefer the terminal `result` text when the stream has one; otherwise reset `state.final` when a new assistant message starts.
3. The live progress stream still shows all turns.

### Acceptance

- `stream-parser.test.ts`: the real multi-turn fixture yields only the final turn's text.
- Single-turn fixtures are unchanged.
- `npm test` passes. CHANGELOG entry under Unreleased.

## Apply prompt timeouts to the codex backend #dev-ready

Source: code audit 2026-11-15. Confirmed by reading.

### Current behavior

`src/runtime/kernel/prompt-codex.ts` uses `http(s).request` with no timeout. `installPromptWatchdog` applies only to subprocess backends, so `JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS` and `JAIPH_PROMPT_MAX_SECONDS` are ignored for codex. An endpoint that accepts the connection and stalls mid-stream hangs the run. `res.on("end")` returns status 0 even when `[DONE]` or a `finish_reason` never arrived.

### Required behavior

- The idle timeout resets on each received chunk and destroys the request when it fires. The max timeout is absolute. Both produce the same failure text as the subprocess backends.
- A stream that ends without `[DONE]` or a `finish_reason` is a failure.
- The run's abort signal destroys the request.

### Acceptance

- Test with a local HTTP server that sends headers and one chunk, then stalls: the prompt fails within the configured idle timeout.
- Test with a server that streams slowly forever: fails at the max timeout.
- Test with a server that closes after one chunk and no `[DONE]`: non-zero status.
- `docs/env-vars.md` rows for both variables no longer exclude codex. CHANGELOG entry under Unreleased.

## Do not copy the Claude config directory into the run directory #dev-ready

Source: code audit 2026-11-15. Confirmed by reading.

### Current behavior

`src/runtime/kernel/prompt-claude.ts` (around lines 82–98): when `<config>/session-env` is not writable, it runs `cpSync(configuredDir, <JAIPH_RUN_DIR>/claude-config, { recursive: true })`. With a read-only `~/.claude`, every run copies credentials, settings and all project history into `.jaiph/runs/<run>/claude-config`. That directory is never cleaned, every script can read it through `JAIPH_RUN_DIR`, `jaiph serve` can list it as artifacts, and CI commonly uploads run directories.

### Required behavior

- Copy only the files claude needs to authenticate and start (credentials and settings files; find the minimal set by test) into a `0700` directory created with `mkdtemp` under the OS temp dir.
- Remove that directory when the run ends, including on failure and signal.
- Nothing from the Claude config lands under the run directory.

### Acceptance

- Test: unwritable config dir containing a fake `.credentials.json` and a large `projects/` tree; after the prompt step nothing named `claude-config` or `.credentials.json` exists under the run dir, `projects/` was not copied anywhere, and the temp directory has mode `0700`.
- Test: the temp directory is removed at run end.
- The existing test near `prompt.test.ts:549` is updated to the new path. CHANGELOG entry under Unreleased.

## Store async handles out of band #dev-ready

Source: code audit 2026-11-15. Reproduced.

### Current behavior

Async handles live in `scope.vars` as strings with the prefix `__JAIPH_HANDLE__`; `isHandle` in `node-workflow-runtime.ts` is `value.startsWith(HANDLE_PREFIX)`. A script that prints `__JAIPH_HANDLE__1`, captured into `x`, makes `${x}` resolve to async handle 1's result, or fails with "invalid async handle". Untrusted script or agent output can swap its value for another step's result.

### Required behavior

A captured string is never interpreted as a handle. Keep handles in a separate structure (for example a `Map` from variable name to handle per scope, or a tagged value type instead of `string`). Do not fix this with an unguessable prefix.

### Acceptance

- Test: a script prints `__JAIPH_HANDLE__1` while an async handle 1 exists; the captured variable interpolates to the literal text.
- Existing async tests and e2e pass. CHANGELOG entry under Unreleased.

## Harden serve request handling: bad percent-encoding, non-ASCII file names, reserved def names #dev-ready

Source: code audit 2026-11-15. Reproduced or confirmed by reading.

### Current behavior

All in `src/cli/serve/handler.ts` unless noted:

- `decodeURIComponent` is unguarded on route segments (around lines 341–378). `GET /runs/%E0%A4%A` or `POST /%` throws `URIError`, which returns 500 `E_INTERNAL` and logs an operator error per request.
- Artifact download builds `Content-Disposition: … filename="${basename}"` (around line 754). Node throws `ERR_INVALID_CHAR` for names such as `报告.txt`, emoji or control characters, so a listed artifact always returns 500. Backslashes are not escaped.
- A def or file named `runs`, `defs`, `mcp`, `healthz`, `docs` or `openapi.json` is advertised in OpenAPI, but `POST /runs` hits the list route and returns 405.
- `X-Correlation-Id` is stripped of CR/LF only (around line 292). A value like `x principal=operator` forges a key=value pair in the audit log line built in `src/cli/shared/server-log.ts`.
- Artifact download checks containment with `realpathSync` + `statSync` and then reopens the file by path (`src/cli/serve/runfiles.ts`). A running step can swap the final component for a symlink between check and open.

### Required behavior

- One safe-decode helper; a malformed segment is 404 (run/def lookup) with the normal JSON error shape and no operator error log.
- `Content-Disposition` carries an ASCII fallback `filename=` (with `"` and `\` escaped or replaced) and an RFC 5987 `filename*=UTF-8''…`.
- Tool derivation (`src/cli/shared/mcp-tools.ts`) rejects a def whose REST name collides with a reserved route, at `jaiph serve` startup, with an error naming the def and the reserved name. MCP stdio is unaffected.
- The correlation id is restricted to a safe charset (for example `[A-Za-z0-9._:-]`, max 128 chars); other values are replaced by a generated id.
- The artifact file is opened once (with `O_NOFOLLOW` where available), `fstat` on the descriptor decides size and file type, and the stream reads from that descriptor.

### Acceptance

- `GET /runs/%zz` and `POST /%` return 404, and the test's log sink has no error-level line.
- Downloading an artifact named `报告.txt` and one named `a"b\c.txt` returns 200 with a parseable header.
- `jaiph serve` on a file exporting `def runs()` fails at startup with the stated error.
- A correlation id containing spaces or `=` does not appear verbatim in the audit line.
- Test that swaps the artifact for a symlink to a file outside the run dir after resolution (inject a hook between resolve and open) does not serve the outside file.
- `integration/serve-server.test.ts` passes. CHANGELOG entry under Unreleased.

## Close serve auth edge cases #dev-ready

Source: code audit 2026-11-15. Confirmed by reading `src/cli/serve/auth.ts`.

### Current behavior

- `JAIPH_SERVE_TOKEN=""` (for example from an unset `${VAR}` in a compose file) is falsy at `if (config.token)` and silently selects open mode on loopback.
- JWT verification passes no `requiredClaims`, so a signed token with no `exp` is accepted forever.
- `discoverJwksUri` has no request timeout, does not check that the discovery document's `issuer` equals the configured issuer, and accepts a non-https `jwks_uri`.
- The bearer scheme is matched with a case-sensitive `/^Bearer\s+/`; RFC 7235 schemes are case-insensitive, so `bearer x` gets 401.

### Required behavior

- `JAIPH_SERVE_TOKEN` set to an empty string is a startup error with a clear message.
- OIDC tokens must carry `exp`.
- Discovery has a timeout (10 s), requires `issuer` to match, and requires an `https:` `jwks_uri` unless the issuer itself is `http://localhost` / `http://127.0.0.1` (tests).
- The scheme match is case-insensitive.

### Acceptance

- Unit tests for each bullet: empty token fails startup; token without `exp` is 401; discovery with mismatched issuer, http `jwks_uri`, or a stalled server fails startup; `bearer <token>` authenticates.
- `integration/serve-auth.test.ts` passes. `docs/` auth section updated. CHANGELOG entry under Unreleased.

## Bound memory in the serve event follower and run-dir lookup #dev-ready

Source: code audit 2026-11-15. Confirmed by reading.

### Current behavior

- `readNewLines` in `src/cli/serve/runfiles.ts` (around lines 148–170) allocates `Buffer.alloc(size - offset)`; on the first poll the offset is 0, so the whole journal is read synchronously, converted to a string and split. The comment says no poll loads the whole file.
- The SSE writer ignores the return value of `res.write` (`src/cli/serve/server.ts` around line 100), so a client that does not read makes the server buffer without limit.
- `runDirFor` caches only hits. For a run with no directory (spawn failure, or before the journal exists), every `/events` or `/artifacts` request and every 250 ms SSE poll calls `findRunDir`, which `readFileSync`s every journal in the tree to read its first line (`src/cli/shared/errors.ts` around lines 230–262).
- On startup, `src/cli/serve/run-store.ts` loads every run directory with no cap, and stamps any journal without `run.json` as `interrupted`, writing a `run.json` into it. That includes runs made by plain `jaiph run` and runs of a still-live process in the same workspace.

### Required behavior

- The follower reads in bounded chunks (64 KB) and waits for `drain` before reading more.
- `findRunDir` reads only the first line (bounded bytes) of each journal, and misses are negative-cached for terminal runs.
- Startup reconciliation only touches run directories that this server created (they already have a `run.json`, or carry a marker written at launch) and applies the retention cap while loading.

### Acceptance

- Test: follower over a 50 MB journal; the largest single read is at most 64 KB (inject the fs read function or measure through a seam).
- Test: a writer that returns `false` from `write` stops further reads until `drain`.
- Test: a terminal run with no directory triggers one tree scan across many requests.
- Test: a run directory created by `jaiph run` (no `run.json`) is not modified by serve startup.
- `integration/serve-restart.test.ts` passes. CHANGELOG entry under Unreleased.

## Pass call arguments to the runtime as typed values #dev-ready

Source: code audit 2026-11-15. Reproduced.

### Current behavior

The parser produces typed `Arg[]` for a call. `argsToRuntimeString` (`src/parse/core.ts`) joins them into one string, and the runtime re-tokenises that string: `resolveArgsRaw` in `node-workflow-runtime.ts` (around line 1598) feeds it to `parseArgTokens` in `src/runtime/kernel/runtime-arg-parser.ts`, a whitespace-and-quote tokenizer. There are 14 `argsToRuntimeString(` call sites in the runtime. `docs/architecture.md` says no downstream consumer re-parses call arguments.

Bugs from the round trip:

- `show("", "b")` delivers one argument: the empty literal is dropped by `if (cur.length > 0)`. `const e = ""; show(e, "b")` delivers two.
- `INLINE_CAPTURE_RE` is defined twice (`node-workflow-runtime.ts` near line 850 and `src/parse/validate-string-content.ts` near line 102) with different call parsers behind each.

### Required behavior

- The runtime evaluates `Arg[]` directly: one resulting argv element per `Arg`, nested calls through the existing nested-call path.
- Delete `argsToRuntimeString`, `parseArgTokens` and `commaArgsToInterpolated` when nothing else uses them (match-arm bodies still use a string form today; if they still need a string parser after this task, keep the minimum and say so in the report).
- One inline-capture scanner, exported from `src/parser.ts`, used by both the validator and the runtime.

### Acceptance

- Regression tests: `show("", "b")` delivers two arguments, the first empty; arguments containing spaces, quotes, commas, `)` and `${…}` arrive byte-exact; a nested call argument still works.
- No behaviour change elsewhere: run a before/after differential (old `dist` vs new `dist`) over every `.jh` in `examples/`, `e2e/`, `test-fixtures/` and `.jaiph/` comparing the argv the runtime would pass, and report the diff count; the only allowed diffs are empty-string arguments.
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass. `docs/architecture.md` is accurate. CHANGELOG entry under Unreleased.

## Parse match-arm bodies into a typed AST node #dev-ready

Source: code audit 2026-11-15. Reproduced.

### Current behavior

`MatchArmDef.body` is a `string` (`src/types.ts` around line 40). The parser classifies the body from tokens (`src/parse/match-arms.ts` around lines 127–160) and then discards the classification. Six places re-classify the string with regexes:

- runtime: `node-workflow-runtime.ts` around lines 898–929 (`startsWith("fail ")`, `/^([A-Za-z_][A-Za-z0-9_.]*)\(([^)]*)\)\s*$/`)
- validator: `src/transpile/validate-match.ts` around line 39
- graph: `src/graph/build.ts` around line 138
- progress tree: `src/cli/run/progress.ts` around line 142
- test runner: `src/runtime/kernel/node-test-runner.ts` around line 73
- test parser: `src/parse/tests.ts` around line 76

All three of these pass `jaiph compile`:

- `"a" => nope_missing("x")` fails only at run time with `Unknown run target: nope_missing`.
- `"a" => echoit("p)q")` does not run the script; the arm returns the literal text `echoit("p)q")` and the run passes, because the runtime regex `[^)]*` disagrees with the parser.
- `"a" => show("x, y", "z")` passes `x y` as the first argument (the comma is lost). The same call outside a match passes `x, y`.

### Required behavior

- The arm body is a typed sum built once in the parser, for example `{ kind: "fail"; message } | { kind: "value"; expr }`, reusing the existing call / literal / variable expression shapes.
- The validator resolves the callee and checks arity through the same path as any other call (`E_VALIDATE` for an unknown def or script).
- The runtime evaluates the expression through its normal expression/call path. Graph, progress tree, test runner and test parser switch on `kind`.
- The formatter output is unchanged.

### Acceptance

- The three cases above are regression tests: unknown callee is `E_VALIDATE` at compile time; `echoit("p)q")` runs the script with argument `p)q`; `show("x, y", "z")` passes `x, y`.
- A grep-style test: no regex or `startsWith` classification of an arm body outside `src/parse/`.
- `src/format/roundtrip.test.ts`, `integration/format-roundtrip.test.ts`, `src/parse/parse-match.test.ts`, `parse-compact-match.test.ts` pass; golden ASTs are updated deliberately and the diff is limited to match arms.
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Reject expressions on the right side of const #dev-ready

Source: code audit 2026-11-15. Reproduced with the built CLI.

### Current behavior

A bare `const` right-hand side is stored verbatim as text. Each of these compiles and `jaiph run` passes:

- `const r = "a" + a` — `r` is the literal text `"a" + a`.
- `const x = await h()` — `x` is the literal `await h()`; `h` is never called.
- `const q = "a" > out.txt` — `q` is the literal text; no file is written.

`docs/grammar.md` (around line 233) lists `bash_value_expr` as a `const_rhs` alternative, but that nonterminal is defined nowhere. `docs/language.md` says "bare token. Stored verbatim."

An LLM that writes concatenation, `await` or a redirect gets a green compile and a green run with wrong data.

### Required behavior

- A bare right-hand side is a single token: a number, or an identifier-like word with no whitespace. Everything else must be one of the existing forms (quoted string, `"""` block, call, prompt, match, inline script, and so on).
- Rejected with `E_PARSE` at the column of the first offending character:
  - quoted string followed by more text → `unexpected content after string; use "${name}" interpolation to build strings`
  - `await …` → `"await" is not a keyword; call the def directly: name(...)`
  - anything else with whitespace or an operator → `invalid const value; expected a string, number, call, prompt, match, or script`
- `docs/grammar.md`: remove or define `bash_value_expr` so every nonterminal used is defined.

### Acceptance

- The three inputs are in `test-fixtures/compiler-txtar/parse-errors.txt` with the messages above; snapshot refreshed.
- A test that every nonterminal referenced in the EBNF blocks of `docs/grammar.md` is defined there.
- Every `.jh` in `examples/`, `e2e/`, `.jaiph/` and `test-fixtures/` valid cases still compiles (fix sources that relied on the old behaviour, except under `.jaiph/`: list those in the report instead).
- `npm test` and `bash e2e/test_all.sh` pass. `docs/language.md` updated. CHANGELOG entry under Unreleased as a breaking change.

## Accept a trailing # comment after any statement, and compile the doc samples #dev-ready

Source: code audit 2026-11-15. Reproduced with the built CLI.

### Current behavior

The docs contradict each other and the parser:

- `docs/grammar.md` line 23: "Trailing `#` on a step line is not a comment."
- `docs/grammar.md` line 346: trailing text after `log`/`fail`/`return` is an error "where a trailing `#` comment is still allowed".
- `rejectTrailingAfterString` (`src/parse/block-ctx.ts` around line 99) allows `#` after `fail "…"` and `return "…"`. `parseSayBody` (`src/parse/stmt-say.ts` around line 79) rejects it after `log "…"`.

Accepted today: `const a = "v"  # c`, `return "ok"  # c`, `fail "x"  # c`. Rejected: `log "x" # c`, `helper(h)  # c`, `const b = helper(h)  # c`, `if … {  # c`, `const y = 'date'()  # c`, `return h  # c`, `log h  # c`.

Doc samples fail for this reason: `docs/language.md` lines 171, 200, 365, 410–412, 417 and `docs/testing.md` lines 104–106. No test compiles doc samples; `integration/docs-grammar-language-split.test.ts` only greps.

### Required behavior

- A `#` preceded by whitespace, outside any string / `"""` block / script body, starts a comment that runs to end of line, after any complete statement and after a block-opening `{`, in `.jh` and `.test.jh`.
- The comment is kept as trivia and the formatter preserves it (normalised to two spaces before `#`).
- `docs/grammar.md` states one rule in both places.
- New integration test that extracts every `jaiph` / `jh` fenced block from `docs/*.md` and `README.md` and compiles it (wrap statement fragments in a def). A fence can opt out with an explicit marker (for example an HTML comment `<!-- no-compile: reason -->` on the line before); every opt-out carries a reason.

### Acceptance

- Each rejected form listed above now parses; add them to the valid txtar cases and to formatter round-trip tests.
- `#` inside a string, a `"""` block, an inline script and a script body is unchanged.
- The doc-sample test passes with all samples in `docs/language.md` and `docs/testing.md` compiled, not opted out, unless they show an error on purpose.
- `integration/format-roundtrip.test.ts`, `npm test`, `bash e2e/test_all.sh` pass. Tree-sitter / TextMate grammars under `grammars/` and `plugins/` highlight the trailing comment. CHANGELOG entry under Unreleased.

## Make parse errors for common agent mistakes say what to change #dev-ready

Source: code audit 2026-11-15. Messages captured verbatim from the built CLI.

### Current behavior

| Input (inside a def) | Message today | Problem |
|---|---|---|
| `h` where `h` is a def (missing parentheses) | `E_PARSE not a statement; put the command in a script` (`src/parse/stmt-decl.ts` near line 198) | Sends the author to write a script instead of adding `()` |
| `while a == "x" {` | same message | No hint about `for` / `recover` |
| `log 'hello'` | `anonymous inline script requires argument list after closing quote: 'body'(args) or 'body'()` (`src/parse/inline-script.ts` near line 109) | A wrong-quote mistake reported as a script problem |
| `h() \|\| fail "x"` | `unexpected content after call call: '…'; shell redirection (>, \|, &) is not supported — use a script block` (`src/parse/core.ts` near line 91) | "call call" stutter, column 1, should point to `catch` |
| `const r = prompt Summarize this` | `after prompt body expected keyword "returns" with quoted schema … or end of line` | The real problem is the unquoted prompt body |
| `const r = prompt "x" returns { verdict: string }` | same message | `returns` is present; the schema lacks quotes |
| `if a == b {` / `if a {` | `invalid if syntax; expected: if <identifier> <op> <operand> { ... }` | Does not say which part is wrong |
| `export def main(a = "x")` | `invalid parameter name "a = "x""; must be an identifier` | Should say defaults and types are not supported |

### Required behavior

Messages (code stays `E_PARSE`, column points at the offending token, never column 1 unless that is where it is):

- bare identifier that is the name of a def or script visible to the parser in the same module → `"h" is a def; call it with parentheses: h()`. For any other bare word keep the existing message.
- `while …` → `"while" is not supported; use "for <name> in <list>" or "recover" to loop`. Same style for `try` (→ `catch`).
- single-quoted text after `log` / `logerr` / `logwarn` / `fail` / `return` with no `(` after the closing quote → `strings use double quotes: "hello"`.
- `call() || …` and `call() && …` → `"||" is not supported; handle failure with: call() catch (err) { … }`. Fix the "call call" stutter everywhere.
- unquoted prompt body → `prompt text must be a quoted string or """ block`.
- `returns` followed by a non-string → `returns schema must be a quoted string: returns "{ verdict: string }"`.
- `if` with a missing operator → `if needs a comparison: if <name> == "value" { … }`; `if` with a non-literal right operand → say the right side must be a string, regex or number literal (match what the parser really accepts).
- parameter with `=` or `:` → `parameters are bare names; default values and types are not supported`.

### Acceptance

- Every input in the table (plus `try {` and `h() && g()`) is in `test-fixtures/compiler-txtar/parse-errors.txt` with the new message and correct column; snapshot refreshed.
- No message in the snapshot contains `call call`.
- `docs/jaiph-skill.md` "common mistakes" section lists the same fixes; run `npm run build` so `src/runtime/embedded-assets.ts` matches it.
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Describe MCP tool parameters from def comments #dev-ready

Source: code audit 2026-11-15. Confirmed with a live `tools/list`.

### Current behavior

`src/cli/shared/mcp-tools.ts` (around lines 54–60) emits `{ "type": "string" }` for every parameter, all required, with no per-parameter description. An exported def with no comment gets the description `Run the "explode" def from tools.jh.` The repo's own hub (`.jaiph/main.jh`) explains parameters in free-text comments and uses the convention "optional args use \"\"". The OpenAPI document (`src/cli/serve/openapi.ts`) has the same gap.

### Required behavior

- In the comment block directly above an exported def, a line of the form `# name: text` where `name` is one of the def's parameters becomes `properties[name].description` in the MCP input schema and the OpenAPI request schema. Those lines are removed from the tool description; the rest of the comment stays the description.
- `jaiph mcp` and `jaiph serve` print one warning to stderr at startup for each exported def with no comment, and for each parameter with no description. No warning in `jaiph run`.
- No change to required-ness or types.

### Acceptance

- `src/cli/shared/mcp-tools.test.ts`: comment with two `# name: text` lines gives two parameter descriptions and a tool description without those lines; a `# other: text` line that names no parameter stays in the description.
- OpenAPI unit test for the same def.
- Test that the warning is printed once per undocumented def by `jaiph mcp` and not by `jaiph run`.
- `docs/mcp.md` and `docs/jaiph-skill.md` document the comment form (`npm run build` to refresh `src/runtime/embedded-assets.ts`). CHANGELOG entry under Unreleased.

## Fix AGENT.md test paths and CLI usage drift #dev-ready

Source: code audit 2026-11-15.

### Current behavior

- `AGENT.md` says cross-cutting tests live in `test/*.test.ts`, new ones "go in `test/`", and lists `node --test dist/test/*.test.js`. Neither `test/` nor `dist/test/` exists. The real location is `integration/*.test.ts`, compiled to `dist/integration/`. A worker following the file creates a tree nothing runs, or runs a glob that matches nothing and reports success.
- `src/cli/shared/usage.ts`: the synopsis shows `jaiph test [path]` and "Shared flags (jaiph run, jaiph serve, jaiph mcp)", but `jaiph test` accepts `--env` (`src/cli/commands/test.ts`). The `jaiph install [--force] …` synopsis omits `--allow-unpinned`. `docs/cli.md` (around lines 116–118 and 221) has the same omissions.

### Required behavior

- `AGENT.md` names `integration/*.test.ts` and `node --test dist/integration/*.test.js`, and lists `npm test`, `npm run lint`, `npm run arch:check`.
- Usage text and `docs/cli.md` show `--env` for `jaiph test` and `--allow-unpinned` for `jaiph install`.

### Acceptance

- Extend `integration/factory-code-philosophy.test.ts` (it already reads `AGENT.md`), or add a sibling test: every backticked repo-relative path in `AGENT.md` exists (glob patterns must match at least one file).
- A test that every flag a command's parser accepts appears in that command's synopsis line in `usage.ts`.
- `npm test` passes.

## Turn the lint cap exemptions into a ratchet #dev-ready

Source: code audit 2026-11-15.

### Current behavior

`eslint.config.mjs` turns `max-lines` (cap 400) and the runtime-import cap (8) `"off"` for three files with a "do not extend" comment. `src/eslint-caps.test.ts` only checks which files are exempt, not their size. Since the exemption was added, `src/runtime/kernel/node-workflow-runtime.ts` grew from 1698 to 2153 counted lines.

Measured today (counted lines / runtime import sources): `node-workflow-runtime.ts` 2153 / 25, `src/cli/serve/handler.ts` 587 / 13, `src/cli/commands/run.ts` 480 / 24. The numbers in the override comments are stale.

### Required behavior

- Replace `"off"` with per-file maxima equal to today's measured values (re-measure at implementation time).
- The caps test asserts, for each exempt file, that the configured maximum equals the measured value, so a split must lower the number in the same change and growth fails lint.
- `docs/agent-analyzability.md` describes the ratchet.

### Acceptance

- `npm run lint` passes unchanged.
- Adding one counted line or one import source to an exempt file fails lint (test with a synthetic copy, as the existing caps tests do).
- A configured maximum above the measured value fails `src/eslint-caps.test.ts`.

## Extract script subprocess execution from the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

`src/runtime/kernel/node-workflow-runtime.ts` is 2801 lines. About 330 of them run a script as a child process and use no instance state: `_scriptSpawn`, `argvEnvByteSize`, `spawnFailureText`, `spawnAndCapture`, `scriptCwd`, `executeScript`, `resolveScriptInterpreter` (around lines 71–115, 204–222, 2277–2492). Tests reach them through casts such as `runtime as unknown as { executeScript }` (`node-workflow-runtime.spawn-failure.test.ts`, `script-exec.test.ts`).

### Required behavior

- New module in `src/runtime/kernel/` with one public function, for example `runScriptProcess({ scriptsDir, scriptName, args, env, cwdFallback, io, stdin, onSpawn }): Promise<StepResult>`, plus the `StdinSource` / `StepIO` types it needs.
- It hides: shebang/interpreter resolution, the stdout tee and backpressure, single-settle, idle-kill, and the mapping of E2BIG / ENOENT spawn failures to step results.
- The runtime class calls it. Tests call the public function instead of casting to private members.
- The new file is under the 400-line and 8-import caps. Lower the lint maximum for `node-workflow-runtime.ts` if the caps are a ratchet by then.

### Acceptance

- `node-workflow-runtime.spawn-failure`, `script-exec` and `idle-kill` tests pass with no `as unknown as` cast to reach script execution.
- Journal lines, step artifacts and error texts are byte-identical: run a before/after differential of `run_summary.jsonl` (normalise timestamps, ids and hashes) and captured files over the e2e workflows that use scripts, and report the diff count (must be 0).
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.

## Extract output handles and the config-to-env table from the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

In `src/runtime/kernel/node-workflow-runtime.ts`:

- Output handles: lines around 294–380 and 2201–2269 plus the fields `handleRegistry`, `handleIdCounter`, `recoverMergeCounter`. Duplicates inside: `readFilePreview` (near 1998) and `readCapturePreview` (near 2787) are the same function; `handleStdinSource` (near 351) repeats lines near 1992; the bare-handle regex appears near 1645 and 1986.
- Metadata to env: `applyMetadataScope`, `scrubKernelKeys`, `resolveConfigAgentModel`, `resolveRecoverLimit` (around 2529–2637). `applyMetadataScope` is six near-identical LOCKED / IMPORT_UNLOCK blocks. `src/cli/run/env.ts` (lines 8–65) repeats the same config-key to env-key mapping. `env.ts` sets `JAIPH_AGENT_MODEL_LOCKED`, which nothing reads.

### Required behavior

- `class OutputHandles { create(ref, promise); createResolved(ref, result); is(value); resolve(id) }` plus pure helpers for forcing a value, deriving a stdin source, and merging failure captures, in their own module. One preview reader, one bare-handle pattern.
- One exported table `{ metaPath, envKey, entryOnly }[]` in the runtime package, used by `applyMetadataScope` and by `resolveRuntimeEnv` in `src/cli/run/env.ts` through the runtime's public entry.
- Remove the unread `JAIPH_AGENT_MODEL_LOCKED` write, or wire it up if the docs promise it (check `docs/env-vars.md`; keep docs and code in parity).
- New files are under the lint caps.

### Acceptance

- Unit tests for `OutputHandles` and for the table-driven `applyMetadataScope` covering each key in locked, unlocked, entry-module and imported-module cases; expected values taken from the current implementation.
- Existing runtime tests, `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.
- `node-workflow-runtime.ts` counted lines drop; update its lint maximum.

## Use one failure-policy helper for exec steps in the workflow runtime #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

In `src/runtime/kernel/node-workflow-runtime.ts`, the catch / recover / retry handling around a step is written three times: for a call step (around lines 1253–1320), for an inline script step (1321–1384), and for the async variant (1220–1247). Each copy is about 65 lines. `runNamedDef` (around 694–716) stops the heartbeat without `try/finally`, unlike `runRoot`.

### Required behavior

- One function, for example `runWithFailurePolicy(step, scope, runOnce: (stdin?) => Promise<StepResult>)`, used by all three sites.
- `runNamedDef` stops the heartbeat in `finally`.

### Acceptance

- Existing catch / recover / async tests pass unchanged.
- New test: `runNamedDef` on a def that throws leaves no heartbeat timer running.
- Before/after differential of journals over the e2e workflows that use `catch` and `recover` shows 0 diffs after normalisation.
- `npm test`, `npm run lint`, `bash e2e/test_all.sh` pass; lint maximum for the file lowered.

## Launch host runs through one module #dev-ready

Source: code audit 2026-11-15.

### Current behavior

Preparing and spawning a workflow leader (runtime env, `JAIPH_SOURCE_ABS`, run id, chain key, grant file, scripts dir, meta file, spawn, `writeChainKey`, cleanup) is written three times: `src/cli/commands/run.ts` lines 132–172, `run.ts` lines 275–303 (raw mode), and `src/cli/shared/workflow-call.ts` with `workflow-call-exec.ts`. The copies have drifted:

- raw mode uses `runtimeEnv[CHAIN_KEY_ENV] ?? generateChainKey()`; the other two always generate
- raw mode never sets `JAIPH_RUN_ID`

Leftovers from the bash runtime: `dummyBuiltPath = join(outDir, "entry.sh")` (`run.ts` near 294 and 382, `workflow-call-exec.ts` near 46) names a file that never exists and is used only for a `JAIPH_SCRIPTS` fallback in `node-workflow-runner.ts`; `JAIPH_META_FILE` is set in `workflow-launch.ts` and never read. The stderr line splitter is duplicated (`run.ts` 404–413, `workflow-call-exec.ts` 146–153; the latter caps output per completed line, so a stream with no newline grows without limit). `buf.stdout` in `run.ts` is never written, so the stdout branch of `drainBuffers` is dead. `src/cli/shared` imports from `run/*` and `telemetry/*`, so `serve` depends on `run` transitively.

### Required behavior

- One module (for example `src/cli/shared/host-run.ts`) with `launchHostRun({ inputAbs, workspaceRoot, outDir, scriptsDir, graphFile?, def, args, extraEnv, effectiveConfig, stdio, runId? })` returning `{ child, done: Promise<{ status, signal, runDir, summaryFile }>, cancel() }`. It owns env construction, chain key, grant file, meta file, timeout and cleanup.
- `jaiph run`, `jaiph run --raw`, serve and MCP all use it. Raw mode gets a run id and always generates a fresh chain key (state this in the CHANGELOG).
- Remove `entry.sh`, the `JAIPH_SCRIPTS` fallback and `JAIPH_META_FILE` if nothing reads them (keep `docs/env-vars.md` in parity). One stderr line splitter with a maximum line length.
- Move what the launcher needs out of `src/cli/run/` so `src/cli/shared` no longer imports from `src/cli/run`; add that as a dependency-cruiser rule.

### Acceptance

- Test: raw mode journal has a run id and verifies.
- Test: a 10 MB stderr line with no newline does not grow the splitter's buffer past the cap.
- `npm run arch:check` has a rule (with a synthetic-violation case in `src/arch-check.test.ts`) that `src/cli/shared` does not import `src/cli/run`.
- `integration/signal-lifecycle.test.ts`, `serve-server.test.ts`, `mcp-server.test.ts`, `run-summary-jsonl.test.ts`, workflow-launch tests, `npm test`, `npm run lint`, `bash e2e/test_all.sh` pass.
- `docs/architecture.md` describes the single launcher. CHANGELOG entry under Unreleased.

## Split progress rendering and result reporting out of the run command #dev-ready

Source: code audit 2026-11-15. No behaviour change in output.

### Current behavior

`src/cli/commands/run.ts` is exempt from the lint caps (480 counted lines, 24 import sources). Two clusters hold most of it:

- progress session: lines around 174–242 and 389–456 (`ttyCtx`, both intervals, `wireStreams`, `drainBuffers`, bottom-line clear/redraw)
- result report: lines around 458–543, `reportResult` with 11 positional parameters

`statSync(inputAbs)` near line 114 is unguarded: a missing file prints a raw `ENOENT … stat` message. `src/cli/commands/init.ts` line 52 has the same pattern, and `src/cli/commands/init.test.ts:92` is skipped with a note pointing to `.jaiph/tmp/qa_bug_report.md`, which is not in the repo. `src/cli/shared/paths.test.ts:19` silently skips when `.jaiph/tmp` does not exist.

### Required behavior

- `startProgressSession(child, emitter, { isTTY, colorEnabled, startedAt }): { stop() }` in `src/cli/run/`.
- `reportRunResult(outcome: RunOutcome): Promise<number>` in `src/cli/run/report.ts`, taking one object.
- `runWorkflow` reads as: parse args, load graph, preflight, launch, report. Remove `run.ts` from the lint cap exemptions if it now fits; otherwise lower its maxima.
- A missing or unreadable input path in `jaiph run` and `jaiph init` prints a one-line error naming the path and exits non-zero, with no stack or raw errno text.
- Unskip `init.test.ts:92`. `paths.test.ts` creates its sandbox directory instead of skipping.

### Acceptance

- `integration/tty-running-timer.test.ts` and all e2e golden trees pass unchanged.
- New tests: `jaiph run missing.jh` and the `init` case print the stated error.
- No `test.skip` / `{ skip: … }` remains in `init.test.ts` or `paths.test.ts`.
- `npm test`, `npm run lint`, `npm run arch:check`, `bash e2e/test_all.sh` pass.

## Extract a run registry and a route table from the serve handler #dev-ready

Source: code audit 2026-11-15. No behaviour change.

### Current behavior

`src/cli/serve/handler.ts` is exempt from the lint caps (587 counted lines, 13 import sources).

- About 220 lines own the run state: `runs`, `orderCounter`, `idempotencyIndex` (around lines 63–72, 149–221, 312–318, 578–623, 767–803).
- Routing (lines 324–372) repeats "check method, check capability, decode id" eight times; the auth block is duplicated near 268–277.
- Argument validation (lines 413–420) repeats `src/cli/shared/mcp-server.ts` near line 237.

### Required behavior

- `class RunRegistry { start(spec, args, identity, hooks); get(id, principal); list(principal, page); cancel(id); findIdempotent(key, argsHash); inFlight(); cancelAll() }` in its own file. It hides the concurrency cap, the cancel-before-spawn race, eviction, idempotency reservation, persistence, and ownership filtering.
- Routing is a table `{ method, pattern, capability, handle }[]`, with auth and capability checks applied in one place.
- MCP-over-HTTP and the run-file endpoints (events, artifacts) are two route modules over the registry.
- One shared `validateToolArgs(spec, raw)` used by REST and MCP.
- Every file is under the lint caps; remove `handler.ts` from the exemptions.

### Acceptance

- Handler unit tests, `integration/serve-server.test.ts`, `serve-auth.test.ts`, `serve-restart.test.ts` and the OpenAPI validation test pass with no change to expected status codes or bodies.
- Unit tests for `RunRegistry`: concurrency cap, cancel before spawn, idempotent replay, cross-principal `get` returns nothing.
- A test that every route in the table declares a capability or is in an explicit list of open routes (`/healthz`, `/docs`, `/openapi.json`, assets).
- `npm test`, `npm run lint`, `npm run arch:check` pass.

## Carry diagnostics as a typed error instead of a formatted string #dev-ready

Source: code audit 2026-11-15. Output text stays byte-identical.

### Current behavior

`jaiphError` in `src/errors.ts` returns `new Error("file:line:col CODE msg")`. `diagnosticFromThrown` in `src/diagnostics.ts` (near line 48) recovers the fields with `/^(.+):(\d+):(\d+) (\S+) ([\s\S]+)$/`. `code` is typed `string`; there are about 30 distinct `E_*` codes and no central list. A message or path that contains text shaped like `:1:2 X ` can be mis-split.

### Required behavior

- `class JaiphError extends Error { file; line; col; code: DiagnosticCode }` with `message` exactly as today.
- `DiagnosticCode` is a string-literal union in `src/errors.ts` listing every code in use.
- `diagnosticFromThrown` uses `instanceof JaiphError` and no regex. A non-Jaiph error keeps today's fallback.
- `jaiph compile --json` output is unchanged.

### Acceptance

- `test-fixtures/compiler-txtar/parse-errors-snapshot.json` and the other compiler snapshots are unchanged.
- Test: a file path containing `:3:4 E_FAKE ` still yields the right file, line, column and code.
- A test that every `E_*` literal in `src/` (outside tests) is a member of `DiagnosticCode`.
- `npm test`, `npm run lint` pass.

## Remove bash-runtime leftovers and dead exports; stop shipping tests in dist #dev-ready

Source: code audit 2026-11-15.

### Current behavior

Stale code from the old bash runtime:

- `isInternalParamValue` matching `::impl`, `jaiph::execute_readonly`, `jaiph::prompt_impl` (`src/cli/shared/format-params.ts` lines 9–15) and `stepFunc: "jaiph::prompt"` (`src/cli/run/progress.ts` near line 109)
- deletions of `JAIPH_STDLIB`, `JAIPH_LIB`, `JAIPH_PRECEDING_FILES`, `BASH_ENV`, and a comment about an emitted `export JAIPH_SCRIPTS=…` (`src/cli/run/env.ts` lines 74–93)
- a stand-alone `main()` with `readStdin` in `src/runtime/kernel/prompt.ts` (lines 172–199) and a `require.main` block in `src/runtime/kernel/node-workflow-runner.ts` (lines 68–75); nothing invokes either
- `toImportSource` rewriting `.jh` to `.sh` (`src/transpile/resolve.ts` lines 19–20), used only by tests

Dead or misplaced:

- `JaiphTestModule` (`src/types.ts` near line 401) and `RuntimeModuleNode` (`src/runtime/kernel/graph.ts`): no importer
- `lookupDef`, `lookupScript`, `extractRunMeta` (`src/cli/shared/errors.ts`) and `formatParamsForDisplay`: used only by tests
- `HookEventName`, `HookConfig`, `HookPayload` live in layer-0 `src/types.ts` (lines 406–453) but are used only by `src/cli/run/hooks.ts` and `emitter.ts`
- `src/cli/commands/minisign-fixture.ts` is a test fixture in the production tree
- `src/config.ts` is outside every dependency-cruiser layer rule: it imports `./parser` and is imported by runtime and CLI, and has no row in `docs/agent-analyzability.md`

Build: the `build` script copies `src/runtime` into `dist/src/runtime`, a tree that is now all TypeScript. `dist/src/runtime/kernel` contains 58 `.ts` files, 32 of them tests, and `package.json` ships `dist/src/`.

### Required behavior

- Delete the stale code and the dead symbols above. Before deleting each env-var cleanup in `env.ts`, confirm nothing in `src/`, `runtime/`, `e2e/` or `docs/env-vars.md` still refers to it (there is a docs parity gate: `env.JAIPH_X` text under `src/` must match a `docs/env-vars.md` row).
- Symbols used only by tests: delete them with their tests if they pin nothing a user can observe; otherwise keep them and say why in the report.
- Move the hook types next to `src/cli/run/hooks.ts`. Move `minisign-fixture.ts` under `test-infra/` or a `*.test-fixture.ts` location excluded from the package.
- Add a dependency-cruiser rule and a docs row for `src/config.ts` (allowed imports: layer 0 and `src/parser.ts`), with a synthetic-violation case in `src/arch-check.test.ts`.
- The published package contains no `.ts` sources and no test files. Fix the build copy step or the `files` list.

### Acceptance

- `npm pack --dry-run` output (assert in a test or script under `scripts/`) lists no `*.test.js`, no `*.ts` except `*.d.ts`.
- `npm run arch:check` passes with the new `config.ts` rule; the synthetic violation fails.
- `tsc`, `npm test`, `npm run lint`, `scripts/build-registry.test.mjs`, the standalone-binary / release smoke tests in CI config, and `bash e2e/test_all.sh` pass.
- CHANGELOG entry under Unreleased.
