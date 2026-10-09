# MCP

Add servers to `mcp_servers` in the account-level `settings.json`. Project settings cannot replace these connections.

```json
{
  "mcp_servers": [
    { "name": "memory", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    { "name": "remote", "url": "https://example.com/mcp", "transport": "streamable_http" }
  ]
}
```

`command` starts a stdio server in the workspace. `args` are separate arguments. A server's explicit `env` object augments the inherited environment; model API credentials are excluded from the inherited environment. URL connections support `streamable_http`, `sse` and `websocket`. Omitting the transport selects `sse` for compatibility with existing configurations.

Tools are named `<server>_<tool>`, such as `memory_read_graph`. External calls require the same approvals as other stateful tools. Read-only mode blocks tools whose effects are unknown; a server's optional read-only hint does not grant an execution exemption.

`/mcp` lists connections, tools and load errors. `/mcp reload` reconnects when the current turn is idle. A reload requested while a turn runs leaves the current runtime and queue intact. Closing the session closes MCP clients and stdio server processes.

Print, line and RPC modes do not load MCP servers. Cancellation sends the MCP cancellation notification; the remote server remains responsible for stopping its work. Tests verify cancellation against a local server with a delayed filesystem effect, plus initialization and calls over every supported transport.
