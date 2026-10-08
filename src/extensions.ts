import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  ChatModel,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolContext,
} from './types.js';
import { isRecord } from './settings.js';

export class ToolError extends Error {}
export class ExtensionError extends Error {}
export interface CommandContext {
  workspace: string;
  toast(message: string): void;
  append(message: string): void;
  sendUserMessage(message: string): void;
}
export interface ExtensionCommand {
  name: string;
  description: string;
  handler(args: string, context: CommandContext): void | Promise<void>;
}
export interface SubagentSpec {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
}
export interface ToolInvocation {
  tool: Tool;
  args: Record<string, unknown>;
  context: ToolContext;
}
export type ModelMiddleware = (
  request: ModelRequest,
  next: (request: ModelRequest) => Promise<ModelResponse>,
) => Promise<ModelResponse>;
export type ToolMiddleware = (
  request: ToolInvocation,
  next: (request: ToolInvocation) => Promise<string>,
) => Promise<string>;
export type AfterModelMiddleware = (
  response: ModelResponse,
  request: ModelRequest,
) => ModelResponse | void | Promise<ModelResponse | void>;
export type ExtensionMiddleware =
  | { slot: 'model_call'; handler: ModelMiddleware }
  | { slot: 'tool_boundary'; handler: ToolMiddleware }
  | { slot: 'after_model'; handler: AfterModelMiddleware };
type ExtensionEvent =
  'session_start' | 'turn_start' | 'turn_end' | 'tool_result';
export interface Extension {
  name: string;
  source: 'user' | 'project';
  path: string;
  enabled: boolean;
  error: string;
  warnings: string[];
  tools: Tool[];
  commands: ExtensionCommand[];
  middleware: ExtensionMiddleware[];
  subagents: { spec: SubagentSpec; tools: string[] }[];
  renderers: Map<string, (update: Record<string, unknown>) => string[]>;
  handlers: Map<
    ExtensionEvent,
    ((event: Record<string, unknown>) => void | Promise<void>)[]
  >;
}
export class ExtensionAPI {
  readonly ToolError = ToolError;
  constructor(
    private ext: Extension,
    private reservedTools: Set<string>,
    private reservedCommands: Set<string>,
  ) {}
  get name(): string {
    return this.ext.name;
  }
  registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (
      args: Record<string, unknown>,
      context: ToolContext,
    ) => unknown | Promise<unknown>,
    options: { readOnly?: boolean; approval?: boolean } = {},
  ): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new ExtensionError(`invalid tool name '${name}'`);
    if (
      this.reservedTools.has(name) ||
      this.ext.tools.some((tool) => tool.name === name)
    )
      throw new ExtensionError(`tool '${name}' already exists`);
    if (!isRecord(parameters) || parameters.type !== 'object')
      throw new ExtensionError(
        `tool '${name}': parameters must be a JSON Schema object`,
      );
    if (typeof execute !== 'function')
      throw new ExtensionError(`tool '${name}': execute must be callable`);
    this.ext.tools.push({
      name,
      description: description || name,
      parameters,
      effect: options.readOnly ? 'read' : 'unknown',
      approval: options.approval ?? !options.readOnly,
      run: async (args, context) => {
        const result = await execute(args, context);
        return typeof result === 'string'
          ? result
          : JSON.stringify(result ?? null);
      },
    });
  }
  registerCommand(
    name: string,
    description: string,
    handler: ExtensionCommand['handler'],
  ): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
      throw new ExtensionError(`invalid command name '${name}'`);
    if (
      this.reservedCommands.has(name) ||
      this.ext.commands.some((command) => command.name === name)
    )
      throw new ExtensionError(`command /${name} already exists`);
    if (typeof handler !== 'function')
      throw new ExtensionError('command handler must be callable');
    this.ext.commands.push({ name, description, handler });
  }
  registerMiddleware(
    handler: ModelMiddleware | ToolMiddleware | AfterModelMiddleware,
    slot: ExtensionMiddleware['slot'] = 'tool_boundary',
  ): void {
    if (!['model_call', 'tool_boundary', 'after_model'].includes(slot))
      throw new ExtensionError(`unknown middleware slot '${slot}'`);
    if (typeof handler !== 'function')
      throw new ExtensionError('middleware must be callable');
    this.ext.middleware.push({ slot, handler } as ExtensionMiddleware);
  }
  registerSubagent(spec: SubagentSpec, tools: string[] = []): void {
    if (
      !isRecord(spec) ||
      !['name', 'description', 'system_prompt'].every(
        (key) => typeof spec[key] === 'string' && String(spec[key]).trim(),
      )
    )
      throw new ExtensionError(
        'subagent spec needs name, description and system_prompt',
      );
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec.name))
      throw new ExtensionError('invalid subagent name');
    if (
      !Array.isArray(tools) ||
      !tools.every((tool) => typeof tool === 'string')
    )
      throw new ExtensionError('subagent tools must be names');
    this.ext.subagents.push({ spec: { ...spec }, tools: [...tools] });
  }
  registerRenderer(
    kind: string,
    renderer: (update: Record<string, unknown>) => string[],
  ): void {
    if (!/^tool_result:.+/.test(kind) || typeof renderer !== 'function')
      throw new ExtensionError('renderer kind must be tool_result:<tool name>');
    this.ext.renderers.set(kind, renderer);
  }
  on(
    event: ExtensionEvent,
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void {
    if (
      !['session_start', 'turn_start', 'turn_end', 'tool_result'].includes(
        event,
      ) ||
      typeof handler !== 'function'
    )
      throw new ExtensionError(`unknown event '${event}'`);
    this.ext.handlers.set(event, [
      ...(this.ext.handlers.get(event) ?? []),
      handler,
    ]);
  }
}
export interface ExtensionHostOptions {
  home: string;
  workspace: string;
  trusted: boolean;
  settings?: Record<string, Record<string, unknown>>;
  reservedTools?: Set<string>;
  reservedCommands?: Set<string>;
}
export class ExtensionHost {
  extensions: Extension[] = [];
  constructor(readonly options: ExtensionHostOptions) {}
  discover(): Pick<Extension, 'name' | 'source' | 'path'>[] {
    const found = new Map<
      string,
      Pick<Extension, 'name' | 'source' | 'path'>
    >();
    const roots: ['user' | 'project', string][] = [
      ['user', join(this.options.home, 'extensions')],
    ];
    if (this.options.trusted)
      roots.push([
        'project',
        join(this.options.workspace, '.circle', 'extensions'),
      ]);
    for (const [source, root] of roots) {
      if (!existsSync(root)) continue;
      for (const directory of readdirSync(root, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (
          !directory.isDirectory() ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(directory.name)
        )
          continue;
        const entry = ['extension.ts', 'extension.mjs', 'extension.js']
          .map((file) => join(root, directory.name, file))
          .find((path) => existsSync(path));
        if (entry)
          found.set(directory.name, {
            name: directory.name,
            source,
            path: entry,
          });
      }
    }
    return [...found.values()];
  }
  async load(): Promise<this> {
    const loaded: Extension[] = [];
    const tools = new Set(this.options.reservedTools);
    const commands = new Set(this.options.reservedCommands);
    for (const discovered of this.discover()) {
      const ext: Extension = {
        ...discovered,
        enabled: this.options.settings?.[discovered.name]?.enabled !== false,
        error: '',
        warnings: [],
        tools: [],
        commands: [],
        middleware: [],
        subagents: [],
        renderers: new Map(),
        handlers: new Map(),
      };
      loaded.push(ext);
      if (!ext.enabled) continue;
      try {
        const module: unknown = await import(
          pathToFileURL(ext.path).href + '?reload=' + randomUUID()
        );
        if (!isRecord(module) || typeof module.register !== 'function')
          throw new ExtensionError('extension defines no register(api)');
        await module.register(new ExtensionAPI(ext, tools, commands));
        for (const tool of ext.tools) tools.add(tool.name);
        for (const command of ext.commands) commands.add(command.name);
      } catch (error) {
        ext.error =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        ext.tools = [];
        ext.commands = [];
        ext.middleware = [];
        ext.subagents = [];
        ext.renderers.clear();
        ext.handlers.clear();
      }
    }
    this.extensions = loaded;
    return this;
  }
  private loaded(): Extension[] {
    return this.extensions.filter((ext) => ext.enabled && !ext.error);
  }
  tools(): Tool[] {
    return this.loaded().flatMap((ext) => ext.tools);
  }
  commands(): Map<string, ExtensionCommand> {
    return new Map(
      this.loaded()
        .flatMap((ext) => ext.commands)
        .map((command) => [command.name, command]),
    );
  }
  subagents(available: Tool[]): { spec: SubagentSpec; tools: Tool[] }[] {
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    const agents = new Map<string, { spec: SubagentSpec; tools: Tool[] }>();
    for (const ext of this.loaded())
      for (const agent of ext.subagents) {
        const missing = agent.tools.filter((name) => !byName.has(name));
        if (missing.length) {
          const warning = `subagent ${agent.spec.name} names tools that do not exist ${missing.join(', ')}; skipped`;
          if (!ext.warnings.includes(warning)) ext.warnings.push(warning);
          continue;
        }
        agents.set(agent.spec.name, {
          spec: agent.spec,
          tools: agent.tools.map((name) => byName.get(name)!),
        });
      }
    return [...agents.values()];
  }
  model(base: ChatModel): ChatModel {
    const middleware = this.loaded().flatMap((ext) => ext.middleware);
    return {
      model: base.model,
      complete: async (request) => {
        let next = (request: ModelRequest) => base.complete(request);
        for (const item of middleware
          .filter((item) => item.slot === 'model_call')
          .reverse()) {
          const downstream = next;
          next = (request) => item.handler(request, downstream);
        }
        let response = await next(request);
        for (const item of middleware)
          if (item.slot === 'after_model')
            response = (await item.handler(response, request)) ?? response;
        return response;
      },
    };
  }
  async toolBoundary(
    request: ToolInvocation,
    run: (request: ToolInvocation) => Promise<string>,
  ): Promise<string> {
    let next = run;
    for (const item of this.loaded()
      .flatMap((ext) => ext.middleware)
      .filter((item) => item.slot === 'tool_boundary')
      .reverse()) {
      const downstream = next;
      next = (request) => item.handler(request, downstream);
    }
    return next(request);
  }
  renderer(
    name: string,
  ): ((update: Record<string, unknown>) => string[]) | undefined {
    return this.loaded()
      .map((ext) => ext.renderers.get('tool_result:' + name))
      .find((renderer) => renderer !== undefined);
  }
  emit(event: ExtensionEvent, payload: Record<string, unknown>): void {
    for (const ext of this.loaded())
      for (const handler of ext.handlers.get(event) ?? []) {
        try {
          Promise.resolve(handler({ ...payload })).catch((error) =>
            this.warn(ext, event, error),
          );
        } catch (error) {
          this.warn(ext, event, error);
        }
      }
  }
  private warn(ext: Extension, event: string, error: unknown): void {
    const note = `${event} handler failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!ext.warnings.includes(note)) ext.warnings.push(note);
  }
  describe(): string {
    if (!this.extensions.length)
      return 'No extensions. Put an extension.ts or extension.js in each extension folder.';
    return this.extensions
      .map(
        (ext) =>
          `${ext.name} (${ext.source}) · ${!ext.enabled ? 'off' : ext.error ? 'failed to load: ' + ext.error : `${ext.tools.length} tools · ${ext.commands.length} commands`}${ext.warnings.length ? '\n  ' + ext.warnings.join('\n  ') : ''}`,
      )
      .join('\n');
  }
}
