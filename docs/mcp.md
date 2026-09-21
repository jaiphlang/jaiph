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

The server speaks newline-delimited JSON-RPC 2.0 over stdio and runs until stdin closes or it receives `SIGINT`/`SIGTERM`. There is no authentication — the parent MCP client is the only caller. stdout carries only protocol JSON; every banner, warning, and compile diagnostic goes to stderr, and a compile error exits `1` with nothing on stdout. For `--workspace`, `--env`, exit behavior, and error codes, see [the `jaiph mcp` reference](cli.md#jaiph-mcp).

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

Jaiph derives tools from the entry file's exported defs; see [the `jaiph mcp` reference](cli.md#jaiph-mcp) for the exposure rules and how a tool name is formed.

## 4. Write tool descriptions as comments

A tool's description comes from the `#` comment lines directly above the def; see [the `jaiph mcp` reference](cli.md#jaiph-mcp) for how those comments are parsed and the fallback when none exist.

## 5. Understand the input and result

Each parameter is a required string, and a successful `tools/call` returns the def's `return` value as a text block from a durable run under `.jaiph/runs/`; see [the `jaiph mcp` reference](cli.md#jaiph-mcp) for the input schema, failure results, and error codes.

## 6. Stream progress and cancel {#7-stream-progress-and-cancel-a-long-call}

Pass a `progressToken` in the call's `params._meta` for per-step `notifications/progress`, and send `notifications/cancelled` to abandon a call; see [the `jaiph mcp` reference](cli.md#jaiph-mcp) for the frame contents and cancellation behavior.

## 7. Hot reload and shutdown

The server hot-reloads the module graph on save and drains in-flight calls on shutdown; see [the `jaiph mcp` reference](cli.md#jaiph-mcp) for the reload and shutdown contract.

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
