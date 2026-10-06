# MCP servers

Circle can load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers and offer them to the model next to its own.

> **Status.** Loading works and `/mcp` lists the tools. Calling them is probably broken in the full-screen interface: the tool adapter is async-only and Circle runs tools synchronously, which produces `Tool execution failed: NotImplementedError` when the model tries one. This was confirmed in a minimal graph but not against a live server. See [Known issues](known-issues.md). Read [what MCP tools are allowed to do](#security) before you rely on them.

## Add a server

Add it to `mcp_servers` in [`settings.json`](settings.md), then run `/reload`.

A server started as a program on your machine:

```json
"mcp_servers": [
  {
    "name": "memory",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "env": { "SOME_VAR": "value" }
  }
]
```

A server reached over the network:

```json
"mcp_servers": [
  { "name": "docs", "url": "https://example.com/mcp", "transport": "streamable_http" }
]
```

| Field | Meaning |
|---|---|
| `name` | Prefix for the server's tools. Falls back to `id`, then `mcp0`, `mcp1`, ... |
| `command`, `args`, `env` | Start the server as a program (stdio). |
| `url`, `transport` | Connect to a server. `transport` is `sse` (the default), `streamable_http` or `websocket`; anything else is treated as `sse`. |

An entry with neither `command` nor `url` is skipped. There is no way to send authentication headers from settings.

## What you get

Each tool is offered to the model as `<name>_<tool>`, for example `memory_create_entities`. Circle connects when a session starts and again on `/reload` and `/mcp reload`. It waits up to 30 seconds. **If anything fails, including one bad server, none of your MCP tools load**, and the only trace is a line in `logs/circle.log`.

If an extension tool has the same name as an MCP tool, the extension tool is dropped, also without a message.

## Commands

| Command | What it does |
|---|---|
| `/mcp` | List the servers and up to 40 loaded tools. |
| `/mcp reload` | Rebuild the agent and reconnect, using the settings already in memory. It waits until the turn ends. To pick up a change you made to `settings.json`, use `/reload`. |

MCP servers are not loaded in [print mode or line mode](cli.md#print-mode).

## Security

MCP tools **never ask for approval** and are not blocked by `read-only` mode. A server can be a program that runs with your rights, and its tools can do whatever it does. Only add servers you trust. See [Security](security.md).
