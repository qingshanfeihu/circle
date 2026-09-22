"""Load LangChain tools from configured MCP servers."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)


def _connection_from_config(item: dict[str, Any]) -> dict[str, Any] | None:
    """Map Circle settings entry → langchain-mcp-adapters connection dict."""
    if item.get("command"):
        args = item.get("args") or []
        if not isinstance(args, list):
            args = [str(args)]
        conn: dict[str, Any] = {
            "transport": "stdio",
            "command": str(item["command"]),
            "args": [str(a) for a in args],
        }
        env = item.get("env")
        if isinstance(env, dict):
            conn["env"] = {str(k): str(v) for k, v in env.items()}
        return conn
    url = item.get("url")
    if url:
        transport = str(item.get("transport") or "sse").lower()
        if transport not in {"sse", "streamable_http", "websocket"}:
            transport = "sse"
        return {"transport": transport, "url": str(url)}
    return None


def build_mcp_connections(servers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for i, item in enumerate(servers):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("id") or f"mcp{i}")
        conn = _connection_from_config(item)
        if conn is None:
            continue
        out[name] = conn
    return out


async def _aload_mcp_tools(connections: dict[str, dict[str, Any]]) -> list[BaseTool]:
    if not connections:
        return []
    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient(connections, tool_name_prefix=True)
    return list(await client.get_tools())


def load_mcp_tools_sync(
    servers: list[dict[str, Any]],
    *,
    timeout: float = 30.0,
) -> list[BaseTool]:
    """Synchronously load MCP tools; failures are logged and skipped."""
    connections = build_mcp_connections(servers)
    if not connections:
        return []
    try:
        return asyncio.run(asyncio.wait_for(_aload_mcp_tools(connections), timeout=timeout))
    except Exception as exc:  # noqa: BLE001
        logger.warning("MCP tool load failed: %s", exc)
        return []


def format_mcp_status(servers: list[dict[str, Any]], tools: list[BaseTool] | None = None) -> str:
    if not servers:
        return (
            "未配置 MCP。在 ~/.circle/settings.json 添加 mcp_servers:\n"
            '  [{ "name": "example", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }]'
        )
    lines = [f"MCP servers ({len(servers)}):"]
    for item in servers:
        name = str(item.get("name") or item.get("id") or "?")
        cmd = str(item.get("command") or item.get("url") or "")
        lines.append(f"  · {name}  {cmd}")
    if tools is not None:
        lines.append(f"已加载工具: {len(tools)}")
        for t in tools[:40]:
            lines.append(f"  · {getattr(t, 'name', t)}")
        if len(tools) > 40:
            lines.append(f"  … +{len(tools) - 40} more")
    return "\n".join(lines)
