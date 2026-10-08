import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from './types.js';
import { isRecord } from './settings.js';
import { shellEnvironment } from './sandbox.js';

export interface McpConnection {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable_http' | 'websocket';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}
export interface McpStatus {
  name: string;
  connection: string;
  tools: string[];
  error: string;
}
export function buildMcpConnections(
  servers: Record<string, unknown>[],
): McpConnection[] {
  const connections = new Map<string, McpConnection>();
  for (const [index, item] of servers.entries()) {
    const name = String(item.name || item.id || `mcp${index}`);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name))
      throw new Error(`invalid MCP server name: ${name}`);
    if (item.command) {
      const args =
        item.args === undefined
          ? []
          : Array.isArray(item.args)
            ? item.args.map(String)
            : [String(item.args)];
      const env = isRecord(item.env)
        ? Object.fromEntries(
            Object.entries(item.env).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined;
      connections.set(name, {
        name,
        transport: 'stdio',
        command: String(item.command),
        args,
        env,
      });
    } else if (item.url) {
      const raw = String(item.transport || 'sse').toLowerCase();
      const transport = ['sse', 'streamable_http', 'websocket'].includes(raw)
        ? (raw as McpConnection['transport'])
        : 'sse';
      connections.set(name, { name, transport, url: String(item.url) });
    }
  }
  return [...connections.values()];
}
function transportFor(connection: McpConnection, workspace: string): Transport {
  if (connection.transport === 'stdio')
    return new StdioClientTransport({
      command: connection.command!,
      args: connection.args ?? [],
      cwd: workspace,
      env: {
        ...(shellEnvironment() as Record<string, string>),
        ...connection.env,
      },
      stderr: 'pipe',
    });
  const url = new URL(connection.url!);
  const protocols =
    connection.transport === 'websocket'
      ? ['ws:', 'wss:']
      : ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password)
    throw new Error('invalid MCP server URL');
  if (connection.transport === 'streamable_http')
    return new StreamableHTTPClientTransport(url);
  if (connection.transport === 'websocket')
    return new WebSocketClientTransport(url);
  return new SSEClientTransport(url);
}
export class McpManager {
  tools: Tool[] = [];
  status: McpStatus[] = [];
  private clients: Client[] = [];
  constructor(
    readonly workspace: string,
    readonly timeout = 30000,
  ) {}
  async load(
    servers: Record<string, unknown>[],
    reserved = new Set<string>(),
    signal?: AbortSignal,
  ): Promise<void> {
    const clients: Client[] = [];
    const tools: Tool[] = [];
    const status: McpStatus[] = [];
    try {
      for (const connection of buildMcpConnections(servers)) {
        signal?.throwIfAborted();
        const state: McpStatus = {
          name: connection.name,
          connection: connection.command || connection.url || '',
          tools: [],
          error: '',
        };
        status.push(state);
        const client = new Client({
          name: 'circle-next',
          version: '0.1.0-dev',
        });
        let transport: Transport | undefined;
        const timeout = AbortSignal.timeout(this.timeout);
        const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
        try {
          transport = transportFor(connection, this.workspace);
          if (transport instanceof StdioClientTransport)
            transport.stderr?.on('data', () => {});
          await client.connect(transport, {
            signal: combined,
            timeout: this.timeout,
          });
          const registered: Tool[] = [];
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const listed = await client.listTools(
              cursor ? { cursor } : undefined,
              { signal: combined, timeout: this.timeout },
            );
            for (const spec of listed.tools) {
              const name = `${connection.name}_${spec.name}`;
              if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
                throw new Error(`invalid MCP tool name: ${name}`);
              if (
                reserved.has(name) ||
                tools.some((tool) => tool.name === name) ||
                registered.some((tool) => tool.name === name)
              )
                throw new Error(`tool '${name}' already exists`);
              registered.push({
                name,
                description: spec.description || name,
                parameters: spec.inputSchema,
                effect: 'unknown',
                run: async (args, context) => {
                  context.signal.throwIfAborted();
                  const result = await client.callTool(
                    { name: spec.name, arguments: args },
                    undefined,
                    {
                      signal: context.signal,
                      timeout: this.timeout,
                      maxTotalTimeout: this.timeout,
                    },
                  );
                  const content = Array.isArray(result.content)
                    ? result.content
                    : [];
                  const text = content
                    .map((block) =>
                      isRecord(block) && block.type === 'text'
                        ? String(block.text || '')
                        : JSON.stringify(block),
                    )
                    .join('\n');
                  if (result.isError)
                    throw new Error(text || 'MCP tool failed');
                  return text || JSON.stringify(result.structuredContent ?? {});
                },
              });
            }
            cursor = listed.nextCursor;
            if (cursor) {
              if (cursors.has(cursor))
                throw new Error('MCP tools pagination repeated a cursor');
              cursors.add(cursor);
            }
          } while (cursor);
          clients.push(client);
          tools.push(...registered);
          state.tools = registered.map((tool) => tool.name);
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          await client.close().catch(() => {});
          await transport?.close().catch(() => {});
          if (signal?.aborted) throw signal.reason;
        }
      }
      const previous = this.clients;
      this.clients = clients;
      this.tools = tools;
      this.status = status;
      await Promise.all(
        previous.map((client) => client.close().catch(() => {})),
      );
    } catch (error) {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      throw error;
    }
  }
  describe(): string {
    if (!this.status.length)
      return 'No MCP servers. Add mcp_servers to settings.json.';
    return (
      `MCP servers (${this.status.length}):\n` +
      this.status
        .map(
          (server) =>
            `  · ${server.name}  ${server.connection}${server.error ? '\n    failed: ' + server.error : '\n    ' + server.tools.join(', ')}`,
        )
        .join('\n')
    );
  }
  async close(): Promise<void> {
    const clients = this.clients.splice(0);
    this.tools = [];
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  }
}
