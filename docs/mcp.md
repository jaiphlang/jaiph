---
title: Serve workflows as MCP tools
permalink: /how-to/mcp
diataxis: how-to
---

# Serve workflows as MCP tools

This recipe turns a `.jh` file into an [MCP](https://modelcontextprotocol.io/) server so that any MCP client (Claude Code, Claude Desktop, Cursor) can call the file's workflows as tools. A workflow encodes a tested, multi-step, repair-capable procedure (`ensure`, `catch`, `recover`, artifacts) — exposing it as a tool lets an agent invoke that procedure instead of improvising shell commands.

No SDK project and no build step are involved: `jaiph mcp ./tools.jh` reuses the same compile-time validation, runner, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run).

## Prerequisites

- A `.jh` file with at least one workflow.
- Agent credentials for any exposed workflow that uses `prompt` — see [Authenticate agent backends](/how-to/agent-auth). Set them on the **host** environment: in Docker mode the credential keys for the backends the served file selects (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`) are forwarded into the container through the env allowlist, and in host mode they are read directly. Any *other* host variable a workflow needs (a `GITHUB_TOKEN`, an API base URL) does not cross the sandbox on its own — forward it explicitly with `--env` (see below).

## 1. Serve a file over stdio

```bash
jaiph mcp ./tools.jh
```

The server speaks newline-delimited [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over stdio (the MCP stdio transport) and runs until stdin closes or it receives `SIGINT` / `SIGTERM`. `jaiph --mcp ./tools.jh` is an equivalent alias.

Add `--workspace <dir>` to set the import-resolution root explicitly (default: auto-detected from the file's directory, exactly as in `jaiph run`).

Add `--env KEY=VALUE` (or `--env KEY` to forward the host's current value) to define a variable in every tool call's environment. The flag is repeatable and the pairs are resolved **once at startup**, then applied to every call for the server's lifetime — a bare `--env KEY` whose value is missing on the host fails fast (`E_ENV_MISSING`) before the server starts. In a Docker sandbox `--env` is the per-key consent that crosses a host variable into the container verbatim, bypassing the credential allowlist; use it for any config or secret a workflow needs that the backend allowlist does not already forward (see [Safety posture](#safety-posture)).

> **stdout carries only protocol JSON.** From the moment the server starts, stdout is the JSON-RPC channel. Every banner, warning, reload notice, and compile diagnostic goes to **stderr**. If the file has compile errors, the server prints `file:line:col CODE message` lines to stderr and exits `1` with nothing on stdout.

## 2. Register the server with a client

For Claude Code:

```bash
claude mcp add mytools -- jaiph mcp ./tools.jh
```

Clients that configure MCP servers with JSON (Claude Desktop's `claude_desktop_config.json`, Cursor's `.cursor/mcp.json`) use the same command and arguments:

```json
{
  "mcpServers": {
    "mytools": {
      "command": "jaiph",
      "args": ["mcp", "./tools.jh"]
    }
  }
}
```

Any client that launches a command and speaks the MCP stdio transport works the same way — point it at `jaiph mcp <file.jh>`. The client sends `initialize`, then `tools/list`, then `tools/call`; the server needs no other configuration.

## 3. Choose which workflows are exposed

Not every workflow in the file becomes a tool. `deriveTools` applies these rules to the **entry file only** (imported modules are never exposed):

1. **If the file declares `export workflow …`, exactly those are exposed.** `export` is the module's public-API marker; use it to publish a deliberate tool surface and hide helpers.
2. **Otherwise every top-level workflow is exposed**, except **channel route targets** (workflows wired as inbox handlers via `channel name -> handler`) — those are message handlers, not tools, and are skipped with a warning.
3. **`default` is special.** It is exposed only when it is the *only* candidate, under a tool name derived from the file's basename (`deploy.jh` → `deploy`). When other workflows exist, `default` is skipped (it stays the `jaiph run` entrypoint, not a public tool).

The tool name for a named workflow is the workflow name itself. For a lone `default`, the file basename is sanitized to the MCP tool-name charset: the `.jh` suffix is stripped and any character outside `[A-Za-z0-9_-]` becomes `_`, truncated to 128 characters.

Skips and exclusions are logged as warnings on **stderr** at load time — they never appear on stdout.

## 4. Write tool descriptions as comments

The description an agent reads when deciding whether to call a tool comes from the **`#` comment lines directly above the workflow**. Shebang lines (`#!…`) are dropped; the leading `#` is stripped from each remaining line; the lines are joined with newlines. Descriptions are the primary signal a client uses to pick a tool, so write them for the calling agent.

```jaiph
# Deploy the application to the named environment.
# Runs the test suite first and aborts the deploy if it fails.
export workflow deploy(environment) {
  ensure tests_pass()
  run `./deploy.sh ${environment}`()
  return "deployed to ${environment}"
}
```

If a workflow has no leading comment, the description falls back to `Run the "<name>" workflow from <basename>.`

## 5. Understand the input schema

Every Jaiph parameter is a string, so each tool's input schema is a flat object of string properties with **all parameters required** and no additional properties allowed. The `deploy` workflow above produces:

```json
{
  "type": "object",
  "properties": { "environment": { "type": "string" } },
  "required": ["environment"],
  "additionalProperties": false
}
```

A workflow with no parameters produces the same shape with an empty `properties` and no `required` key.

## 6. Call a tool and read the result

On `tools/call`, the server maps the arguments object to positional workflow arguments in declared order and runs the workflow — in a Docker sandbox or on the host, per the same env-driven selection as `jaiph run` (see [Safety posture](#safety-posture)). The result is a text content block:

- **On success**, the text is the workflow's `return` value (persisted as `return_value.txt`); if the workflow returns nothing, it falls back to the workflow's `log` output, then to a `workflow <name> completed` note.
- **On failure**, the result carries `isError: true` and text describing the failing step, its captured output, and a `run dir: <path>` pointer so the client can inspect the full run.

A **workflow failure is not a protocol error** — it comes back as a normal result with `isError: true`. Protocol-level errors (JSON-RPC `-32602`) are reserved for calls that never start: an unknown tool name, a missing or non-string required argument, or an unexpected argument key.

Every call is a durable, inspectable run under `.jaiph/runs/` in the workspace, exactly as for `jaiph run`. Concurrent calls are isolated by per-call run ids and run directories, so a slow call never stalls other calls or a `ping`. Under the default isolated sandbox each call also gets its own point-in-time snapshot of the workspace, so calls do not race on workspace files; only in inplace mode (`JAIPH_INPLACE=1`) can two calls that mutate the *same* files race, since both write the live tree.

## 7. Stream progress and cancel a long call

A multi-step workflow can take a while. The server streams step-level progress to clients that ask for it, and lets a client cancel a call it no longer needs.

### Receive progress notifications

Include a `progressToken` (a string or number of your choosing) in the call's `params._meta`:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{"environment":"staging"},"_meta":{"progressToken":"deploy-1"}}}
```

As the workflow runs, each step boundary — a step starting and a step finishing — emits a `notifications/progress` back to the client carrying your token:

```json
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":1,"message":"workflow deploy"}}
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":2,"message":"script deploy_sh"}}
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":3,"message":"script deploy_sh"}}
```

- `progress` is a **monotonically increasing counter** — a running count of step events observed, not a fraction of a known total (there is no `total`, because a workflow's step count is not known up front). Both the **start and the end** of a step notify, so the counter advances by two per step and a `message` repeats across the start/end pair (above, the `deploy_sh` script step).
- `message` is the step's kind and name — `workflow <name>`, `script <name>`, or `rule <name>` — from the same step events surfaced on `jaiph run`'s stderr. The tool's own workflow is the first step (`workflow deploy` above), followed by its nested steps.
- Notifications **stop the moment the call's response is sent.** No progress notification ever follows the result for that call.
- A call **without** a `progressToken` receives no progress notifications at all — behaviour is identical to before you opted in.

### Cancel an in-flight call

To abandon a running call, send a `notifications/cancelled` naming its request id:

```json
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}
```

The server terminates that call's run — the whole child process tree, `SIGINT` first and then `SIGKILL` after a short grace period, the same escalation `jaiph run` applies on Ctrl-C. In Docker mode the call's container is also force-removed by name (`docker rm -f`) so it cannot keep running after cancellation — the same no-orphaned-container contract `jaiph run` gives on interrupt (see [Sandboxing — interrupting a Docker run](sandboxing.md#interrupting-a-docker-run)). Per the MCP spec, a cancelled call sends **no response** for that id; the run's `.jaiph/runs/` directory is left as-is for inspection. The server keeps serving — other in-flight calls are untouched and a subsequent `ping` or `tools/call` answers normally. A cancellation that arrives before the run's child has even spawned is honored as soon as it starts.

## 8. Edit the file while the server runs (hot reload)

The server watches every source file in the module graph (polling, ~750 ms). When you edit and save:

- The graph is reloaded and re-validated, tools are re-derived, and the server emits `notifications/tools/list_changed`. A subsequent `tools/list` reflects the new tool set.
- If the edit introduces a **compile error**, the server keeps serving the previous, valid tool set and logs the diagnostics to stderr — clients are never left with a broken tool list.

## Safety posture

An MCP-exposed workflow is **arbitrary shell reachable by the connected agent** — that is the point of the feature. Treat every exposed workflow as code the client may run at will, and scope the exposed surface with `export` accordingly.

Tool calls honor the **same env-driven Docker sandbox as `jaiph run`** ([Sandboxing](sandboxing.md)): Docker is on by default on macOS/Linux and off under `JAIPH_UNSAFE=true` or on Windows (host-only). The image is prepared once when the server starts, not per call.

**The workspace is isolated by default** — the same as `jaiph run`. Each tool call's container works on its own writable point-in-time snapshot of the workspace; edits are discarded when the container exits and the host workspace is untouched. Concurrent calls each get their own run id and run directory.

To **opt into live writes**, set `JAIPH_INPLACE=1` before starting the server. In inplace mode the host workspace is bind-mounted read-write into each tool call's container, so effects land live — two calls that mutate the *same* files can still race.

Other sandbox controls:

- `JAIPH_UNSAFE=true` — run on the host with no sandbox at all.

Agent-credential pre-flight runs once at startup. In MCP mode its findings are demoted to warnings even in Docker mode (the server can outlive a credential fix, and per-call failures still surface to the client); set credentials on the host so the allowlist forwards them into the container.

## Verification

With the server running, a scripted stdio session drives the full handshake. Every stdout line is a JSON-RPC message:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"deploy","arguments":{"environment":"staging"}}}' \
 | jaiph mcp ./tools.jh
```

You should see three responses on stdout — the `initialize` result, the `tools/list` array with your comment-derived descriptions, and the `tools/call` result carrying the workflow's return value — and startup/warning lines only on stderr.

## Related

- [CLI — `jaiph mcp`](cli.md#jaiph-mcp) — the flag, exit behaviour, and error-code reference.
- [Authenticate agent backends](/how-to/agent-auth) — host credentials for workflows that use `prompt`.
- [Grammar — Imports and exports](grammar.md#imports-and-exports) — how `export` marks the public surface.
- [Save artifacts](/how-to/artifacts) — the `.jaiph/runs/` layout every call writes to.
