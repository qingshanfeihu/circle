#!/usr/bin/env python3
"""Minimal stdio MCP server for Circle sandbox parity tests."""

from __future__ import annotations

import anyio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

app = Server("circle-parity-mcp")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="parity_echo",
            description="Echo a token for Circle MCP live tests.",
            inputSchema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        )
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    if name != "parity_echo":
        raise ValueError(f"unknown tool {name}")
    text = str(arguments.get("text") or "")
    return [TextContent(type="text", text=f"MCP_ECHO:{text}")]


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    anyio.run(main)
