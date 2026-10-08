import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from './types.js';
import { Sandbox, shellEnvironment } from './sandbox.js';
import { loadToolPrompt } from './system_prompt.js';

export interface LspServer {
  command: string;
  args: string[];
}
const DEFAULT_SERVERS: Record<string, LspServer> = {
  '.py': { command: 'pylsp', args: [] },
  '.pyi': { command: 'pylsp', args: [] },
  '.ts': { command: 'typescript-language-server', args: ['--stdio'] },
  '.tsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.js': { command: 'typescript-language-server', args: ['--stdio'] },
  '.jsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.go': { command: 'gopls', args: [] },
  '.rs': { command: 'rust-analyzer', args: [] },
};
export function findExecutable(
  command: string,
  environment = process.env,
): string | undefined {
  const extensions =
    process.platform === 'win32' && !extname(command)
      ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  const directories =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? ['']
      : (environment.PATH || '').split(delimiter);
  for (const directory of directories)
    for (const extension of extensions) {
      const path = directory
        ? join(directory, command + extension)
        : command + extension;
      try {
        accessSync(
          path,
          process.platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return path;
      } catch {
        /* Try the next PATH candidate. */
      }
    }
  return undefined;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private ready?: Promise<void>;
  private documents = new Map<string, { version: number; text: string }>();
  private exited: Promise<void>;
  constructor(
    server: LspServer,
    readonly workspace: string,
    readonly timeout = 8000,
  ) {
    const command = findExecutable(server.command) || server.command;
    this.child = spawn(command, server.args, {
      cwd: workspace,
      env: shellEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => {
        this.closed = true;
        this.fail(new Error('language server closed'));
        resolve();
      });
    });
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  private send(message: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed)
      throw new Error('language server is closed');
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 10_000_000) {
      this.fail(new Error('LSP response exceeds 10 MB'));
      void this.close();
      return;
    }
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const match = this.buffer
        .subarray(0, end)
        .toString('ascii')
        .match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.fail(new Error('invalid LSP framing'));
        void this.close();
        return;
      }
      const length = Number(match[1]);
      if (length > 10_000_000) {
        this.fail(new Error('LSP response exceeds 10 MB'));
        void this.close();
        return;
      }
      if (this.buffer.length < end + 4 + length) return;
      const data = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        this.fail(new Error('invalid LSP JSON'));
        continue;
      }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (message.method === 'workspace/configuration')
            this.send({
              id: message.id,
              result: (
                (message.params as { items?: unknown[] })?.items ?? []
              ).map(() => null),
            });
          else if (
            message.method === 'client/registerCapability' ||
            message.method === 'client/unregisterCapability' ||
            message.method === 'window/workDoneProgress/create'
          )
            this.send({ id: message.id, result: null });
          else
            this.send({
              id: message.id,
              error: { code: -32601, message: 'client method not supported' },
            });
        }
        continue;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      pending.cleanup();
      if (message.error)
        pending.reject(
          new Error('LSP error: ' + JSON.stringify(message.error)),
        );
      else pending.resolve(message.result);
    }
  }
  async initialize(signal: AbortSignal): Promise<void> {
    if (!this.ready)
      this.ready = this.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.workspace).href,
          capabilities: {
            workspace: { configuration: true },
            textDocument: { synchronization: { didSave: false } },
          },
        },
        signal,
      )
        .then(() => {
          this.notify('initialized', {});
        })
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    await this.ready;
    signal.throwIfAborted();
  }
  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }
  async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = this.timeout,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (error: Error): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        try {
          this.notify('$/cancelRequest', { id });
        } catch {
          /* Server exited while cancelling. */
        }
        reject(error);
      };
      const abort = (): void =>
        finish(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Interrupted'),
        );
      const timer = setTimeout(
        () => finish(new Error(`timeout waiting for LSP response: ${method}`)),
        timeoutMs,
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.send({ id, method, params });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  open(path: string): void {
    const uri = pathToFileURL(path).href;
    const text = readFileSync(path, 'utf8');
    const previous = this.documents.get(uri);
    const version = (previous?.version ?? 0) + 1;
    if (!previous) {
      const extension = extname(path).slice(1);
      const languageId =
        (
          {
            py: 'python',
            pyi: 'python',
            ts: 'typescript',
            tsx: 'typescriptreact',
            js: 'javascript',
            jsx: 'javascriptreact',
            rs: 'rust',
            go: 'go',
          } as Record<string, string>
        )[extension] || extension;
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text },
      });
    } else if (text !== previous.text)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    this.documents.set(uri, { version, text });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('language server closed'));
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32')
      await new Promise<void>((resolve) =>
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () =>
          resolve(),
        ),
      );
    else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* Process has already stopped. */
      }
    }
    const escalation = setTimeout(() => {
      if (process.platform !== 'win32')
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* Process group stopped. */
        }
    }, 500);
    try {
      await this.exited;
    } finally {
      clearTimeout(escalation);
    }
  }
}
export class LspManager {
  private clients = new Map<string, LspClient>();
  constructor(
    readonly sandbox: Sandbox,
    readonly servers: Record<string, LspServer> = DEFAULT_SERVERS,
    readonly timeout = 8000,
  ) {}
  tool(): Tool {
    return {
      name: 'lsp',
      description: loadToolPrompt('lsp'),
      effect: 'read',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'goToDefinition',
              'findReferences',
              'hover',
              'documentSymbol',
              'workspaceSymbol',
              'goToImplementation',
            ],
          },
          filePath: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          character: { type: 'integer', minimum: 1 },
          query: { type: 'string' },
        },
        required: ['operation', 'filePath'],
      },
      run: async (args, context) => {
        const path = this.sandbox.resolvePath(
          String(args.filePath || args.file_path || '.'),
        );
        this.sandbox.checkCredentialPath(path);
        const operation = String(args.operation || '');
        if (operation !== 'workspaceSymbol' && !existsSync(path))
          throw new Error(`file not found: ${path}`);
        let server = this.servers[extname(path).toLowerCase()];
        if (!server && operation === 'workspaceSymbol')
          server = Object.values(this.servers).find((server) =>
            findExecutable(server.command),
          );
        if (!server || !findExecutable(server.command))
          throw new Error(
            `no LSP server available for ${extname(path) || 'workspace'}. Install pylsp / typescript-language-server / gopls / rust-analyzer.`,
          );
        const key = JSON.stringify(server);
        let client = this.clients.get(key);
        if (!client) {
          client = new LspClient(server, this.sandbox.workspace, this.timeout);
          this.clients.set(key, client);
        }
        await client.initialize(context.signal);
        if (existsSync(path) && operation !== 'workspaceSymbol')
          client.open(path);
        const position = {
          line: Math.max(0, (Number(args.line) || 1) - 1),
          character: Math.max(0, (Number(args.character) || 1) - 1),
        };
        const document = { uri: pathToFileURL(path).href };
        const methods: Record<string, [string, Record<string, unknown>]> = {
          goToDefinition: [
            'textDocument/definition',
            { textDocument: document, position },
          ],
          findReferences: [
            'textDocument/references',
            {
              textDocument: document,
              position,
              context: { includeDeclaration: true },
            },
          ],
          hover: ['textDocument/hover', { textDocument: document, position }],
          documentSymbol: [
            'textDocument/documentSymbol',
            { textDocument: document },
          ],
          workspaceSymbol: [
            'workspace/symbol',
            { query: String(args.query || '') },
          ],
          goToImplementation: [
            'textDocument/implementation',
            { textDocument: document, position },
          ],
        };
        const method = methods[operation];
        if (!method) throw new Error(`unsupported operation '${operation}'`);
        return JSON.stringify(
          (await client.request(method[0], method[1], context.signal)) ?? null,
          null,
          2,
        );
      },
    };
  }
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close()));
  }
}
