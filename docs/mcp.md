---
title: Serve workflows as MCP tools
permalink: /how-to/mcp
diataxis: how-to
---

# Serve workflows as MCP tools

This guide turns a `.jh` file into an [MCP](https://modelcontextprotocol.io/) server, so any MCP client (Claude Code, Claude Desktop, Cursor) can call the file's workflows as tools. A workflow is a tested procedure with several steps and built-in repair (`ensure`, `catch`, `recover`, and artifacts). When you expose that workflow as a tool, an agent can invoke the procedure instead of writing its own shell commands.

You don't need an SDK project or a build step. `jaiph mcp ./tools.jh` reuses the same compile-time validation, runner, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run).

## Prerequisites

- A `.jh` file with at least one workflow.
- Agent credentials for any exposed workflow that uses `prompt`. See [Authenticate agent backends](agent-auth.md). Set the credentials on the host environment. Any other host variable a workflow needs, such as a `GITHUB_TOKEN` or an API base URL, forward with `--env` (described below).

## 1. Serve a file over stdio

```bash
jaiph mcp ./tools.jh
```

The server speaks newline-delimited [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over stdio, which is the MCP stdio transport. It runs until stdin closes or it receives `SIGINT` or `SIGTERM`. `jaiph --mcp ./tools.jh` is an equivalent alias.

> **MCP over the network.** [`jaiph serve`](serve.md) exposes the same tools over MCP Streamable HTTP at `POST /mcp`, alongside its REST API. It shares one run registry, concurrency cap, hot reload, and bearer auth with the stdio server. Use `jaiph mcp` for a stdio client on the same machine, and use `jaiph serve` when an MCP client must reach the workflows over HTTP. Everything below applies to both transports the same way: exposure rules, descriptions, input schema, result shape, progress, and cancel.

Add `--workspace <dir>` to set the import resolution root. By default Jaiph auto-detects it from the file's directory, the same as `jaiph run`.

Add `--env KEY=VALUE` to define a variable in every tool call's environment, or `--env KEY` to forward the host's current value. The flag is repeatable. Jaiph resolves the pairs once at startup and then applies them to every call for the server's lifetime. A bare `--env KEY` whose value is missing on the host fails with `E_ENV_MISSING` before the server starts.

> **stdout carries only protocol JSON.** From the moment the server starts, stdout is the JSON-RPC channel. Every banner, warning, reload notice, and compile diagnostic goes to stderr. If the file has compile errors, the server prints `file:line:col CODE message` lines to stderr and exits `1` with nothing on stdout.

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

Any client that launches a command and speaks the MCP stdio transport works the same way. Point it at `jaiph mcp <file.jh>`. The client sends `initialize`, then `tools/list`, then `tools/call`, and the server needs no other configuration.

## 3. Choose which workflows are exposed

Not every workflow in the file becomes a tool. `deriveTools` applies these rules to the entry file only, and never exposes imported modules:

1. If the file declares one or more `export workflow` statements, Jaiph exposes exactly those workflows. `export` marks the module's public API. Use it to publish a deliberate set of tools and hide helper workflows.
2. Otherwise Jaiph exposes every top-level workflow, except channel route targets. A channel route target is a workflow wired as an inbox handler through `channel name -> handler`. These workflows are message handlers rather than tools, so Jaiph skips them and logs a warning.
3. Jaiph treats `default` specially. It exposes `default` only when it is the only candidate, under a tool name taken from the file's basename (`deploy.jh` becomes `deploy`). When other workflows exist, Jaiph skips `default`, so it stays the `jaiph run` entrypoint rather than a public tool.

The tool name for a named workflow is the workflow name itself. For a lone `default`, Jaiph builds the name from the file basename. It strips the `.jh` suffix, replaces any character outside `[A-Za-z0-9_-]` with `_`, and truncates the result to 128 characters.

Jaiph logs every skip and exclusion as a warning on stderr at load time, and never on stdout.

## 4. Write tool descriptions as comments

The description an agent reads when it decides whether to call a tool comes from the `#` comment lines directly above the workflow. Jaiph drops shebang lines (`#!…`), strips the leading `#` from each remaining line, and joins the lines with newlines. A client relies on the description to pick a tool, so write it for the calling agent.

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

Every Jaiph parameter is a string, so each tool's input schema is a flat object of string properties. Every parameter is required, and no additional properties are allowed. The `deploy` workflow above produces this schema:

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

On `tools/call`, the server maps the arguments object to positional workflow arguments in declared order and runs the workflow on the host. The result is a text content block:

- On success, the text is the workflow's `return` value, saved as `return_value.txt`. If the workflow returns nothing, the text falls back to the workflow's `log` output, and then to a `workflow <name> completed` note.
- On failure, the result carries `isError: true`. The text describes the failing step, its captured output, and a `run dir: <path>` pointer so the client can inspect the full run. Jaiph redacts credentials in the failure text (`[REDACTED]`) the same way as in the event journal, so a secret that a failing step prints is never returned to the client. A successful `return` value is intended API output, so Jaiph returns it as is.

A workflow failure is not a protocol error. It comes back as a normal result with `isError: true`. Jaiph reserves protocol-level errors (JSON-RPC `-32602`) for calls that never start, such as an unknown tool name, a missing or non-string required argument, or an unexpected argument key.

Every call is a durable run under `.jaiph/runs/` in the workspace, and you can inspect it exactly as for `jaiph run`. Jaiph isolates concurrent calls by giving each one its own run id and run directory, so a slow call never stalls other calls or a `ping`. Two calls that change the same files can race.

## 7. Stream progress and cancel a long call

A workflow with several steps can take a while. The server streams step-level progress to clients that ask for it, and lets a client cancel a call it no longer needs.

### Receive progress notifications

Include a `progressToken` (a string or number of your choosing) in the call's `params._meta`:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deploy","arguments":{"environment":"staging"},"_meta":{"progressToken":"deploy-1"}}}
```

As the workflow runs, Jaiph sends a `notifications/progress` back to the client at each step boundary, carrying your token. A step boundary is a step starting or a step finishing. For example:

```json
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":1,"message":"workflow deploy"}}
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":2,"message":"script deploy_sh"}}
{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"deploy-1","progress":3,"message":"script deploy_sh"}}
```

- `progress` is a counter that only increases. It is a running count of the step events seen so far, not a fraction of a known total. There is no `total`, because Jaiph does not know a workflow's step count up front. Both the start and the end of a step send a notification, so the counter goes up by two per step, and the `message` repeats across the start and end pair (above, the `deploy_sh` script step).
- `message` is the step's kind and name, one of `workflow <name>`, `script <name>`, or `rule <name>`. These are the same step events that `jaiph run` prints on stderr. The tool's own workflow is the first step (`workflow deploy` above), followed by its nested steps.
- Notifications stop the moment the call's response is sent. No progress notification ever follows the result for that call.
- A call without a `progressToken` receives no progress notifications at all, which is the same behavior as before you opted in.

### Cancel an in-flight call

To abandon a running call, send a `notifications/cancelled` naming its request id:

```json
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}
```

The server terminates that call's run, meaning the whole child process tree. It sends `SIGINT` first, then `SIGKILL` after a short grace period, the same escalation `jaiph run` applies on Ctrl-C. Per the MCP spec, a cancelled call sends no response for that id, and Jaiph leaves the run's `.jaiph/runs/` directory in place for inspection. The server keeps serving, other in-flight calls are untouched, and a later `ping` or `tools/call` answers normally. A cancellation that arrives before the run's child has spawned is honored as soon as the child starts.

## 8. Edit the file while the server runs (hot reload)

The server watches every source file in the module graph, polling about every 750 ms. When you edit and save a file:

- The server reloads and re-validates the graph and re-derives the tools. It then emits `notifications/tools/list_changed`, and a later `tools/list` returns the new tool set.
- If the edit introduces a compile error, the server keeps serving the previous valid tool set and logs the diagnostics to stderr. Clients are never left with a broken tool list.
- A tool call already in flight is untouched. It keeps running against the scripts of the generation it started under, and Jaiph deletes that generation's files only once its last in-flight call settles. New calls use the reloaded sources.

## Shutdown (drain, then cancel)

The server shuts down when stdin closes or on `SIGINT` or `SIGTERM`. Either way it first drains. It stops accepting input and waits for in-flight tool calls to finish, keeping their scripts on disk until they settle, and then cleans up and exits `0`. If you don't want to wait, send a second signal. The server then terminates every in-flight run's child process tree (`SIGINT`, then `SIGKILL` after a short grace period). The killed calls report error results, and the server exits `0`.

## Safety posture

An exposed workflow is arbitrary shell that the connected agent can run, which is the point of the feature. Treat every exposed workflow as code the client may run at any time, and limit the exposed set with `export`. A tool-call argument that binds to a workflow parameter is shell-quoted before it reaches any shell step, so an argument value cannot inject extra shell commands, though the client can still run whatever the exposed workflow itself does.

Tool calls execute on the host, the same as `jaiph run`. Isolation is an outer concern: wrap `jaiph mcp` in a container, a pod, or a CI runner if wanted. See [Deploy jaiph](deploy.md).

The agent-credential pre-flight check runs once at startup. In MCP mode, the server reports its findings as warnings, because the server can outlive a credential fix and a per-call failure still surfaces to the client.

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

You should see three responses on stdout. They are the `initialize` result, the `tools/list` array with your comment-derived descriptions, and the `tools/call` result carrying the workflow's return value. Startup and warning lines appear only on stderr.

## Related

- [CLI reference for `jaiph mcp`](cli.md#jaiph-mcp): the flags, exit behavior, and error codes.
- [Authenticate agent backends](agent-auth.md): host credentials for workflows that use `prompt`.
- [Grammar, imports and exports](grammar.md#imports-and-exports): how `export` marks the public surface.
- [Save artifacts](artifacts.md): the `.jaiph/runs/` layout every call writes to.
