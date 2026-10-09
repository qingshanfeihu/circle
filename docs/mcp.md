# MCP servers

Circle can load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers and offer them to the model next to its own. Read [what MCP tools are allowed to do](#security) before you rely on them.

## Add a server

Add it to `mcp_servers` in [`settings.json`](settings.md) in the data folder, then run `/reload` or `/mcp reload`. A project's `.circle/settings.json` cannot add servers.

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
| `name` | Prefix for the server's tools: letters, digits, `_` and `-`, up to 32 characters. Falls back to `id`, then `mcp0`, `mcp1`, … Any other name stops the full-screen interface from starting; see [Known issues](known-issues.md#mcp-and-extensions). |
| `command`, `args`, `env` | Start the server as a program (stdio), in the workspace. |
| `url`, `transport` | Connect to a server. `transport` is `sse` (the default), `streamable_http` or `websocket`; anything else is treated as `sse`. |

An entry with neither `command` nor `url` is skipped. There is no way to send authentication headers from settings, and a URL may not carry a user name or password.

A program started for a server gets your environment without the variables whose names look secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like; see [The shell environment](security.md#the-shell-environment)), plus the `env` you give it. Put a key the server needs in `env`.

## What you get

Each tool is offered to the model as `<name>_<tool>`, for example `memory_create_entities`. Circle connects when the full-screen interface starts, and again on `/reload`, `/mcp reload` and `/extensions reload`. It waits up to 30 seconds for each server. A server that fails is listed by `/mcp` with the reason, and the other servers' tools still load.

A tool call is limited to 30 seconds. `esc` sends the server a cancellation; what the server does with it is up to the server. Images and PDFs a tool returns go to the model as attachments.

## Commands

| Command | What it does |
|---|---|
| `/mcp` | List the servers, their tools, and why a server failed. |
| `/mcp reload` | Re-read `settings.json` and reconnect every server. Not while a turn runs. |

MCP servers are not loaded in [print mode, line mode](cli.md#print-mode) or [RPC mode](rpc.md). Closing Circle closes the connections and stops the programs it started.

## Security

An MCP server can be a program that runs with your rights, and its tools can do whatever it does. Circle cannot know what a tool changes, so every MCP tool call **asks for approval**, and `read-only` mode refuses them. "Allow for this session" on the card covers every call to that tool. Only add servers you trust. See [Security](security.md).
