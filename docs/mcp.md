---
title: MCP server in 30 seconds
permalink: /how-to/mcp
diataxis: how-to
---

# MCP server in 30 seconds

Turn a `.jh` file into an [MCP](https://modelcontextprotocol.io/) server so any MCP client (Claude Code, Claude Desktop, Cursor) can call the file's exported defs as tools. `jaiph mcp ./tools.jh` reuses the same validation, runner, and `.jaiph/runs/` artifacts as [`jaiph run`](cli.md#jaiph-run), with no SDK or build step. For the network sibling that speaks MCP over HTTP, see [Serve defs over HTTP](serve.md).

## Prerequisites

- A `.jh` file with at least one exported def.
- Agent credentials for any exposed def that uses `prompt` — see [Authenticate agent backends](agent-auth.md).

## 1. Serve a file over stdio

```bash
jaiph mcp ./tools.jh
```

The server speaks newline-delimited JSON-RPC 2.0 over stdio and runs until stdin closes or it receives `SIGINT`/`SIGTERM`. stdout carries only protocol JSON; every banner, warning, and compile diagnostic goes to stderr, and a compile error exits `1` with nothing on stdout. For `--workspace`, `--env`, exit behavior, and error codes, see [the `jaiph mcp` reference](cli.md#jaiph-mcp).

## 2. Register the server with a client

```bash
claude mcp add mytools -- jaiph mcp ./tools.jh
```

Clients that configure MCP servers with JSON (Claude Desktop, Cursor) use the same command and arguments:

```json
{
  "mcpServers": {
    "mytools": { "command": "jaiph", "args": ["mcp", "./tools.jh"] }
  }
}
```

The client sends `initialize`, then `tools/list`, then `tools/call`; the server needs no other configuration.

## 3. Choose which defs are exposed

`deriveTools` applies these rules to the entry file only, and never exposes imported modules:

1. Candidates are exported defs only. Zero exports means no tools, plus a warning.
2. Skip `main` unless it is the only export; then expose it under a tool name taken from the file's basename (`deploy.jh` becomes `deploy`).
3. An exported channel-route handler is a tool.

A named def's tool name is the def name. For a lone `main`, Jaiph strips `.jh`, replaces any character outside `[A-Za-z0-9_-]` with `_`, truncates to 128 characters, and falls back to `def` if that leaves an empty name. Every skip is a stderr warning.

## 4. Write tool descriptions as comments

The description an agent reads comes from the `#` comment lines directly above the def: Jaiph drops shebang lines, strips the leading `#` and one space, drops blank lines, and joins the rest with newlines. With no leading comment, the description falls back to `Run the "<name>" def from <basename>.`

```jaiph
# Deploy the application to the named environment.
# Returns a short confirmation once the deploy finishes.
export def deploy(environment) {
  run deploy_sh(environment)
  return "deployed to ${environment}"
}
```

## 5. Understand the input and result

Every parameter is a required string, so a tool's input schema is a flat object of string properties with `additionalProperties: false`. On `tools/call`, the server maps arguments to positional def arguments and runs the def on the host as a durable run under `.jaiph/runs/`. Success returns the def's `return` value as a text block; failure returns `isError: true` with the failing step, its captured output, and a `run dir:` pointer, credential-redacted. A def failure is a normal result, not a protocol error; JSON-RPC `-32602` is reserved for calls that never start (unknown tool, missing or non-string argument, unexpected key).

## 6. Stream progress and cancel {#7-stream-progress-and-cancel-a-long-call}

Include a `progressToken` in the call's `params._meta` to receive a `notifications/progress` at each step boundary (start and end), carrying an increasing counter and a `def <name>` / `script <name>` / `prompt <backend>` message. A call without a token receives none. To abandon a running call, send `notifications/cancelled` with its `requestId`; the server terminates that call's child process tree (`SIGINT`, then `SIGKILL`) and leaves its run directory in place. Other in-flight calls are untouched.

## 7. Hot reload and shutdown

The server watches every source file in the module graph. On save it re-validates, re-derives the tools, and emits `notifications/tools/list_changed`; a compile error keeps the previous valid tool set serving, and a call in flight keeps running against its own generation. On stdin close or a signal the server drains in-flight calls, then exits `0`; a second signal terminates every in-flight child tree first.

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

You should see three responses on stdout: the `initialize` result, the `tools/list` array with your comment-derived descriptions, and the `tools/call` result carrying the def's return value. Startup and warning lines appear only on stderr.

## Related

- [CLI reference for `jaiph mcp`](cli.md#jaiph-mcp): flags, exit behavior, and error codes.
- [Serve defs over HTTP](serve.md): the network transport at `POST /mcp`.
- [Authenticate agent backends](agent-auth.md): host credentials for defs that use `prompt`.
- [Save artifacts](artifacts.md): the `.jaiph/runs/` layout every call writes to.
