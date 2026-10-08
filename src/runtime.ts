import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ChatModel, Message, ToolCall } from './types.js';
import { GatewayModel, EFFORT_LEVELS } from './model.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import { defaultPolicy, DEFAULT_CREDENTIAL_FILES } from './approvals.js';
import { Sandbox } from './sandbox.js';
import { buildTools, type Todo } from './tools.js';
import { buildSystemPrompt } from './system_prompt.js';
import { Harness, type ApprovalDecision } from './harness.js';
import { EventBus } from './events.js';
import { defaultRunOptions, type RunOptions } from './run_options.js';
import type { CircleSettings } from './settings.js';
import { discoverSkills, loadSkillBody } from './skills.js';
import { fromJsonl } from './session_export.js';
import { projectDataDir } from './paths.js';
import { McpManager } from './mcp_loader.js';
import { ExtensionHost } from './extensions.js';
import { isFolderTrusted, loadSettings } from './settings.js';
import { BUILTIN_SLASH } from './tui/slash_commands.js';
import { discoverCustomCommands } from './commands.js';
import { LspManager } from './lsp_tool.js';
import type { Tool, ToolContext } from './types.js';
const BUILTIN_TOOL_NAMES = new Set([
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'write_todos',
  'task',
  'compact_conversation',
  'webfetch',
  'question',
  'skill',
  'websearch',
  'lsp',
  'apply_patch',
  'plan_enter',
  'plan_exit',
]);
const EXPLORE_TOOLS = new Set([
  'ls',
  'read_file',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'lsp',
  'skill',
]);
export interface RuntimeOptions {
  workspace: string;
  home: string;
  settings: CircleSettings;
  run?: RunOptions;
  session?: string;
  sessionId?: string;
  continue?: boolean;
  fork?: string;
  model?: ChatModel;
  headless?: boolean;
  approve?: (call: ToolCall, signal: AbortSignal) => Promise<ApprovalDecision>;
  question?: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
}
export class AgentRuntime {
  readonly store: CheckpointStore;
  readonly bus = new EventBus();
  readonly sandbox: Sandbox;
  readonly policy;
  readonly runOptions: RunOptions;
  readonly skills;
  readonly mcp: McpManager;
  readonly lsp: LspManager;
  extensions: ExtensionHost;
  private integrationsReady?: Promise<void>;
  private baseModel?: ChatModel;
  todos: Todo[] = [];
  session: Session;
  harness: Harness;
  constructor(readonly options: RuntimeOptions) {
    this.runOptions = options.run ?? defaultRunOptions();
    this.store = new CheckpointStore(
      this.runOptions.no_session ? undefined : options.home,
    );
    this.sandbox = new Sandbox(
      options.workspace,
      projectDataDir(options.workspace, options.home),
      [
        ...new Set([
          ...DEFAULT_CREDENTIAL_FILES,
          ...options.settings.credential_files,
        ]),
      ],
    );
    this.policy = defaultPolicy(
      options.workspace,
      options.home,
      this.sandbox.credentialFiles,
    );
    this.skills = discoverSkills(options.workspace, options.home);
    this.mcp = new McpManager(options.workspace);
    this.lsp = new LspManager(this.sandbox);
    this.extensions = this.extensionHost(new Set());
    let session: Session | undefined;
    if (options.session) {
      session = this.store.find(options.session);
      if (!session) throw new Error('unknown session');
      if (session.workspace !== options.workspace)
        session = this.store.fork(session.id, options.workspace);
    } else if (options.continue) {
      session = this.store.list(options.workspace)[0];
      if (!session) throw new Error('no saved session in this folder');
    } else if (options.fork) {
      const parent = this.store.find(options.fork);
      if (!parent) throw new Error('unknown session to fork');
      session = this.store.fork(parent.id, options.workspace);
    }
    this.session =
      session ??
      this.store.create(
        options.workspace,
        options.settings.auth.model,
        this.runOptions.session_name,
        options.sessionId,
      );
    if (this.runOptions.session_name)
      this.store.rename(this.session.id, this.runOptions.session_name);
    this.harness = this.createHarness(options.model);
    this.bus.setRunId(this.session.id);
    this.bus.subscribe((event) => {
      if (event.kind === 'run_start')
        this.extensions.emit('turn_start', {
          ...event.payload,
          session_id: event.run_id,
        });
      else if (event.kind === 'run_end')
        this.extensions.emit('turn_end', {
          ...event.payload,
          session_id: event.run_id,
          usage: event.usage,
        });
      else if (event.kind === 'tool_result')
        this.extensions.emit('tool_result', {
          ...event.payload,
          session_id: event.run_id,
        });
    });
  }
  private createHarness(modelOverride?: ChatModel): Harness {
    const model =
      modelOverride ??
      this.baseModel ??
      new GatewayModel(this.options.settings, this.options.home);
    this.baseModel = model;
    const system =
      buildSystemPrompt(
        this.options.workspace,
        model.model,
        this.options.settings.auth.protocol,
        this.runOptions,
      ) +
      (this.skills.length
        ? '\n\nAvailable skills:\n' +
          this.skills
            .map((skill) => `- ${skill.name}: ${skill.description}`)
            .join('\n')
        : '');
    let tools = buildTools(this.sandbox, {
      todos: (todos) => {
        this.todos = todos;
        this.bus.emit('todo_list', { payload: { todos } });
      },
      skill: async (name) => loadSkillBody(name, this.skills),
      ...(this.options.question
        ? {
            question: async (args, context) =>
              this.options.question!(args, context.signal),
          }
        : {}),
      plan: async (enabled) => {
        if (!enabled && !this.options.question)
          throw new Error('plan_exit requires an interactive answer');
        this.harness.planMode = enabled;
        return enabled ? 'Read-only mode enabled.' : 'Read-only mode disabled.';
      },
      compact: async (hint) => this.compact(hint),
      task: async (args, context) => {
        const name = String(args.subagent_type || 'general-purpose');
        const custom = this.extensions
          .subagents(this.harness.tools)
          .find((agent) => agent.spec.name === name);
        if (!custom && !['general-purpose', 'explore'].includes(name))
          throw new Error('unknown subagent type');
        const childModel = custom?.spec.model
          ? this.extensions.model(
              new GatewayModel(
                this.options.settings,
                this.options.home,
                custom.spec.model,
              ),
            )
          : this.harness.model;
        const session = this.store.create(
          this.options.workspace,
          childModel.model,
          String(args.description || '').slice(0, 80),
        );
        const childBus = new EventBus(session.id);
        childBus.subscribe((event) =>
          this.bus.emit(event.kind, {
            payload: event.payload,
            usage: event.usage,
            tags: { subagent: session.id, name },
            parent_run_id: this.session.id,
          }),
        );
        const childTools = (custom?.tools ?? this.harness.tools).filter(
          (tool) =>
            tool.name !== 'task' &&
            tool.name !== 'compact_conversation' &&
            tool.name !== 'plan_enter' &&
            tool.name !== 'plan_exit' &&
            (name !== 'explore' ||
              custom !== undefined ||
              EXPLORE_TOOLS.has(tool.name)),
        );
        const child = new Harness({
          model: childModel,
          tools: childTools,
          store: this.store,
          session,
          policy: this.policy,
          system:
            (custom?.spec.system_prompt ??
              readFileSync(
                join(
                  import.meta.dirname,
                  'prompts/agent',
                  name === 'explore' ? 'explore.md' : 'generate.md',
                ),
                'utf8',
              )) +
            '\n' +
            this.harness.system,
          bus: childBus,
          approve: this.options.approve,
          headless: this.options.headless,
          toolBoundary: (tool, args, context) =>
            this.extensionToolBoundary(tool, args, context),
        });
        child.planMode = this.harness.planMode || name === 'explore';
        this.policy.setYolo(
          session.id,
          this.policy.yoloEnabled(this.session.id),
        );
        const abort = (): void => {
          void child.cancel();
        };
        context.signal.addEventListener('abort', abort, { once: true });
        try {
          context.signal.throwIfAborted();
          return (await child.run(String(args.description || ''))).answer;
        } finally {
          context.signal.removeEventListener('abort', abort);
        }
      },
    });
    tools.push(this.lsp.tool());
    if (this.runOptions.tools !== null)
      tools = tools.filter(
        (tool) =>
          this.runOptions.tools!.includes(tool.name) ||
          tool.name === 'compact_conversation',
      );
    tools = tools.filter(
      (tool) =>
        !this.runOptions.exclude_tools.includes(tool.name) ||
        tool.name === 'compact_conversation',
    );
    tools = this.withIntegrationTools(tools);
    return new Harness({
      model: this.extensions.model(model),
      tools,
      store: this.store,
      session: this.session,
      policy: this.policy,
      system,
      bus: this.bus,
      headless: this.options.headless,
      approve: this.options.approve,
      beforeRun: (signal) => this.initialize(signal),
      toolBoundary: (tool, args, context) =>
        this.extensionToolBoundary(tool, args, context),
    });
  }
  private extensionHost(reservedTools: Set<string>): ExtensionHost {
    const commands = discoverCustomCommands(
      this.options.workspace,
      this.options.home,
    );
    return new ExtensionHost({
      home: this.options.home,
      workspace: this.options.workspace,
      trusted: isFolderTrusted(this.options.settings, this.options.workspace),
      settings: this.options.settings.extensions,
      reservedTools: new Set([...BUILTIN_TOOL_NAMES, ...reservedTools]),
      reservedCommands: new Set([
        ...BUILTIN_SLASH.flatMap((command) => [
          command.name,
          ...(command.aliases ?? []),
        ]),
        ...commands.map((command) => command.name),
      ]),
    });
  }
  private withIntegrationTools(tools: Tool[]): Tool[] {
    const names = new Set<string>();
    return [...tools, ...this.mcp.tools, ...this.extensions.tools()].filter(
      (tool) => {
        if (names.has(tool.name))
          throw new Error(`tool '${tool.name}' already exists`);
        if (tool.name !== 'compact_conversation') {
          if (
            this.runOptions.tools !== null &&
            !this.runOptions.tools.includes(tool.name)
          )
            return false;
          if (this.runOptions.exclude_tools.includes(tool.name)) return false;
        }
        names.add(tool.name);
        return true;
      },
    );
  }
  private async extensionToolBoundary(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const original = JSON.stringify(args);
    return this.extensions.toolBoundary(
      { tool, args, context },
      (invocation) => {
        if (
          invocation.tool !== tool ||
          invocation.context !== context ||
          JSON.stringify(invocation.args) !== original
        )
          throw new Error(
            'extension middleware cannot replace an approved tool invocation',
          );
        context.signal.throwIfAborted();
        return tool.run(invocation.args, context);
      },
    );
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.options.headless) return;
    if (!this.integrationsReady) {
      this.integrationsReady = (async () => {
        const base = this.harness.tools.filter(
          (tool) =>
            !this.mcp.tools.includes(tool) &&
            !this.extensions.tools().includes(tool),
        );
        await this.mcp.load(
          this.options.settings.mcp_servers,
          new Set(base.map((tool) => tool.name)),
          signal,
        );
        const host = this.extensionHost(
          new Set([...base, ...this.mcp.tools].map((tool) => tool.name)),
        );
        await host.load();
        signal?.throwIfAborted();
        this.extensions = host;
        this.harness.tools = this.withIntegrationTools(base);
        const subagents = new Map<string, string>([
          ['general-purpose', 'General coding tasks.'],
          ['explore', 'Read-only project exploration.'],
        ]);
        for (const agent of host.subagents(this.harness.tools))
          subagents.set(agent.spec.name, agent.spec.description);
        const task = this.harness.tools.find((tool) => tool.name === 'task');
        if (task)
          task.description =
            readFileSync(
              join(import.meta.dirname, 'prompts/tools/task.md'),
              'utf8',
            ).trim() +
            '\n\nAvailable subagents:\n' +
            [...subagents]
              .map(([name, description]) => `- ${name}: ${description}`)
              .join('\n');
        this.harness.model = host.model(this.baseModel!);
        this.harness.system += host.tools().length
          ? '\n\nExtension tools:\n' +
            host
              .tools()
              .map((tool) => `${tool.name}: ${tool.description}`)
              .join('\n')
          : '';
        host.emit('session_start', {
          workspace: this.options.workspace,
          session_id: this.session.id,
        });
      })().catch((error) => {
        this.integrationsReady = undefined;
        throw error;
      });
    }
    await this.integrationsReady;
  }
  async reloadIntegrations(): Promise<void> {
    if (this.harness.busy) throw new Error('reload after the current turn');
    this.options.settings = loadSettings(this.options.home);
    this.integrationsReady = undefined;
    await this.initialize();
  }
  setModel(model: string): void {
    if (this.harness.busy) throw new Error('a turn is running');
    if (!model.trim()) throw new Error('model ID is required');
    this.baseModel = new GatewayModel(
      this.options.settings,
      this.options.home,
      model,
    );
    this.harness.model = this.extensions.model(this.baseModel);
    this.harness.system = buildSystemPrompt(
      this.options.workspace,
      model,
      this.options.settings.auth.protocol,
      this.runOptions,
    );
  }
  get thinkingLevel(): string {
    return this.baseModel instanceof GatewayModel
      ? this.baseModel.effort
      : this.options.settings.default_thinking;
  }
  setThinkingLevel(level: string): void {
    if (this.harness.busy) throw new Error('a turn is running');
    if (!(EFFORT_LEVELS as readonly string[]).includes(level))
      throw new Error('unknown thinking depth');
    if (this.baseModel instanceof GatewayModel) this.baseModel.effort = level;
    else this.options.settings.default_thinking = level;
  }
  stats(): {
    messages: number;
    toolCalls: number;
    usage: import('./types.js').Usage;
  } {
    const messages = this.harness.messages;
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
    for (const message of messages)
      if (message.usage)
        for (const key of Object.keys(usage) as (keyof typeof usage)[])
          usage[key] += message.usage[key];
    return {
      messages: messages.length,
      toolCalls: messages.reduce(
        (sum, message) => sum + (message.tool_calls?.length || 0),
        0,
      ),
      usage,
    };
  }
  async compact(hint = ''): Promise<string> {
    const tree = this.store.tree(this.session.id);
    const messages = this.store.messages(this.session.id);
    if (messages.length < 8) return 'Nothing to compact yet';
    let end = messages.length - 6;
    while (end > 0) {
      try {
        this.store.requireBalancedTools(messages.slice(0, end));
        break;
      } catch {
        end--;
      }
    }
    if (!end) return 'Nothing to compact yet';
    const controller = new AbortController();
    const response = await this.harness.model.complete({
      system:
        'Summarize the conversation for continued coding. Preserve goals, constraints, decisions, files, results, and unresolved work. ' +
        hint,
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          content: JSON.stringify(messages.slice(0, end)),
        },
      ],
      tools: [],
      signal: controller.signal,
      token: () => {},
    });
    const checkpoint = tree.find(
      (checkpoint) => checkpoint.message.id === messages[end - 1]!.id,
    );
    if (!checkpoint || !response.message.content.trim())
      throw new Error('summary did not complete');
    this.store.setSummary(
      this.session.id,
      checkpoint.id,
      response.message.content,
    );
    return `Compacted ${end} messages. Raw history retained.`;
  }
  async newSession(): Promise<void> {
    if (this.harness.busy) throw new Error('a turn is running');
    this.session = this.store.create(
      this.options.workspace,
      this.harness.model.model,
    );
    this.todos = [];
    this.harness = this.createHarness(this.options.model);
    this.bus.setRunId(this.session.id);
    this.extensions.emit('session_start', {
      workspace: this.options.workspace,
      session_id: this.session.id,
    });
  }
  async switchSession(id: string): Promise<void> {
    if (this.harness.busy) throw new Error('a turn is running');
    let session = this.store.find(id);
    if (!session) throw new Error('unknown session');
    if (session.workspace !== this.options.workspace)
      session = this.store.fork(session.id, this.options.workspace);
    this.session = session;
    this.harness = this.createHarness(this.options.model);
    this.bus.setRunId(session.id);
  }
  async importSession(text: string): Promise<void> {
    const { header, messages } = fromJsonl(text);
    await this.newSession();
    this.store.append(this.session.id, messages);
    if (typeof header.title === 'string')
      this.store.rename(this.session.id, header.title);
  }
  async close(): Promise<void> {
    await this.harness.cancel();
    await this.integrationsReady?.catch(() => {});
    await this.mcp.close();
    await this.lsp.close();
    this.store.close();
  }
}
