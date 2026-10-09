import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
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
import { fromJsonl, toSessionBundle } from './session_export.js';
import { projectDataDir, circleHome, normalizeWorkspace } from './paths.js';
import { McpManager } from './mcp_loader.js';
import { ExtensionHost } from './extensions.js';
import { isFolderTrusted, loadSettings } from './settings.js';
import { BUILTIN_SLASH } from './tui/slash_commands.js';
import { discoverCustomCommands } from './commands.js';
import { LspManager } from './lsp_tool.js';
import type { Tool, ToolContext } from './types.js';
import {
  ContextManager,
  restoredTodos,
  restoredPlanMode,
} from './context_middleware.js';
import { migrateLegacy } from './migration.js';
import type { MigrationReport } from './legacy_sessions.js';
import { askQuestions } from './questions.js';
import type { SecretRequest } from './secret_prompt.js';
import { JobRegistry, jobLine, type Job } from './jobs.js';
import { ModelCatalog } from './model_catalog.js';
import {
  priceCall,
  messageCosts,
  UsageCostTotals,
  type CostSummary,
} from './pricing.js';
import { addUsage, emptyUsage } from './types.js';
import { UserShells } from './user_shell.js';
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
  'list_jobs',
  'stop_job',
  'wait_jobs',
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
  'list_jobs',
  'stop_job',
  'wait_jobs',
]);
export interface InteractionContext {
  jobId?: string;
  name?: string;
}
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
  catalog?: ModelCatalog;
  extraTools?: Tool[];
  headless?: boolean;
  approve?: (
    call: ToolCall,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<ApprovalDecision>;
  question?: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<string>;
  secret?: (
    request: SecretRequest,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<void>;
}
export class AgentRuntime {
  readonly migration: MigrationReport;
  readonly options: RuntimeOptions;
  readonly store: CheckpointStore;
  readonly bus = new EventBus();
  readonly sandbox: Sandbox;
  readonly jobs: JobRegistry;
  readonly catalog: ModelCatalog;
  private childJobOwners = new Map<string, import('./jobs.js').JobOwner>();
  private closing = false;
  private closingPromise?: Promise<void>;
  readonly policy;
  readonly runOptions: RunOptions;
  readonly skills;
  readonly mcp: McpManager;
  readonly lsp: LspManager;
  readonly context: ContextManager;
  private compactionController?: AbortController;
  private activeCompaction?: Promise<string>;
  extensions: ExtensionHost;
  private integrationsReady?: Promise<void>;
  private baseModel?: ChatModel;
  private coreTools: Tool[] = [];
  get allTools(): Tool[] {
    return this.withIntegrationTools(this.coreTools, false);
  }
  todos: Todo[] = [];
  readonly userShells: UserShells;
  session: Session;
  harness: Harness;
  constructor(options: RuntimeOptions) {
    this.options = {
      ...options,
      workspace: normalizeWorkspace(options.workspace),
      home: circleHome(options.home),
    };
    options = this.options;
    this.runOptions = options.run ?? defaultRunOptions();
    this.catalog = options.catalog ?? new ModelCatalog(options.home);
    this.store = new CheckpointStore(
      this.runOptions.no_session ? undefined : options.home,
    );
    this.migration = this.runOptions.no_session
      ? { imported: [], skipped: [], errors: [] }
      : migrateLegacy(options.home, this.store);
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
      (path) => this.sandbox.resolvePath(path),
    );
    this.jobs = new JobRegistry(this.sandbox, (kind, job) => {
      if (kind === 'job_ended') this.userShells?.ended(job);
      this.bus.emit(kind, {
        payload: { job },
        tags: { session_id: job.sessionId },
      });
    });
    this.userShells = new UserShells(this.jobs, this.store, {
      sessionId: () => this.session.id,
      busy: () => this.busy,
      modelBusy: () => this.harness.busy,
      planMode: () => this.harness.planMode,
      changed: () => this.bus.emit('info', { payload: { user_shell: true } }),
    });
    this.skills = discoverSkills(options.workspace, options.home);
    this.mcp = new McpManager(options.workspace);
    this.lsp = new LspManager(this.sandbox);
    this.context = new ContextManager(this.store, this.sandbox.offloadRoot!, {
      progress: (event) =>
        this.bus.emit('compaction', { payload: { ...event } }),
      runningJobs: (sessionId) =>
        this.jobs
          .list(sessionId)
          .filter(
            (job) => job.status === 'running' && job.startedBy !== 'user',
          ),
      priceUsage: (model, usage) =>
        priceCall(this.catalog.facts(model, this.options.settings), usage),
      notice: (event) =>
        this.bus.emit('info', { payload: { model_notice: event } }),
    });
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
    this.todos = restoredTodos(this.harness.messages);
    this.bus.setRunId(this.session.id);
    if (!options.model)
      void this.catalog.refreshIfStale(() =>
        this.bus.emit('info', { payload: { model_catalog_refreshed: true } }),
      );
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
      new GatewayModel(
        this.options.settings,
        this.options.home,
        undefined,
        {},
        this.catalog,
      );
    this.baseModel = model;
    const system =
      buildSystemPrompt(
        this.options.workspace,
        model.model,
        this.options.settings.auth.protocol,
        this.runOptions,
        this.options.home,
      ) +
      (this.skills.length
        ? '\n\nAvailable skills:\n' +
          this.skills
            .map((skill) => `- ${skill.name}: ${skill.description}`)
            .join('\n')
        : '');
    let tools = buildTools(this.sandbox, {
      jobs: this.jobs,
      todos: (todos) => {
        this.todos = todos;
        this.bus.emit('todo_list', { payload: { todos } });
      },
      skill: async (name) => loadSkillBody(name, this.skills),
      question: async (args, context) =>
        askQuestions(this.options.home, this.sandbox, args, context.signal, {
          ask: this.options.question,
          secret: this.options.secret,
        }),
      plan: async (enabled, context) => {
        if (!enabled && !this.options.question)
          throw new Error('plan_exit requires an interactive answer');
        if (!enabled) {
          const reply = await this.options.question!(
            {
              questions: [
                {
                  question: 'Implement the completed plan?',
                  header: 'plan',
                  options: [
                    {
                      label: 'implement plan',
                      description: 'Leave read-only mode',
                    },
                    {
                      label: 'continue planning',
                      description: 'Stay in read-only mode',
                    },
                  ],
                  multiple: false,
                  custom: false,
                },
              ],
            },
            context.signal,
          );
          context.signal.throwIfAborted();
          let answers: unknown;
          try {
            answers = JSON.parse(reply);
          } catch {
            answers = undefined;
          }
          const chosen = Array.isArray(answers) ? answers.flat() : [];
          if (!chosen.includes('implement plan'))
            return 'The user kept read-only mode active. Continue planning.';
        }
        this.setPlanMode(enabled);
        return enabled ? 'Read-only mode enabled.' : 'Read-only mode disabled.';
      },
      compact: async (hint, context) => this.compact(hint, context.signal),
      task: async (args, context) => {
        const parentHarness = this.harness;
        const parentSessionId = context.sessionId;
        const name = String(args.subagent_type || 'general-purpose');
        const custom = this.extensions
          .subagents(this.allTools)
          .find((agent) => agent.spec.name === name);
        if (!custom && !['general-purpose', 'explore'].includes(name))
          throw new Error('unknown subagent type');
        const childModel = custom?.spec.model
          ? this.extensions.model(
              new GatewayModel(
                this.options.settings,
                this.options.home,
                custom.spec.model,
                {},
                this.catalog,
              ),
            )
          : parentHarness.model;
        const session = this.store.create(
          this.options.workspace,
          childModel.model,
          `${name}: ${String(args.description || '')}`.slice(0, 160),
          undefined,
          parentSessionId,
        );
        const parentState = this.store.contextState(parentSessionId);
        this.childJobOwners.set(session.id, {
          sessionId: parentSessionId,
          parent: session.id,
          startedBy: 'model',
        });
        this.store.setContextState(parentSessionId, {
          ...parentState,
          subagentSessionIds: [
            ...new Set([...(parentState.subagentSessionIds ?? []), session.id]),
          ],
        });
        const childBus = new EventBus(session.id);
        let backgroundJob: Job | undefined;
        let backgroundLog: ((text: string) => void) | undefined;
        const interact = async <T>(
          action: (origin: InteractionContext) => Promise<T>,
        ): Promise<T> => {
          if (backgroundJob)
            this.jobs.activity(backgroundJob.id, 'waiting for you');
          try {
            return await action({ jobId: backgroundJob?.id, name });
          } finally {
            if (backgroundJob) this.jobs.activity(backgroundJob.id, 'working');
          }
        };
        childBus.subscribe((event) => {
          if (event.kind === 'tool_call')
            backgroundLog?.(
              `${event.payload.name}(${JSON.stringify(event.payload.args)})`,
            );
          if (event.kind === 'llm_end')
            backgroundLog?.(
              String((event.payload.message as Message)?.content || ''),
            );
          this.bus.emit(event.kind, {
            payload: event.payload,
            usage: event.usage,
            tags: {
              subagent: session.id,
              name,
              ...(backgroundJob ? { job_id: backgroundJob.id } : {}),
            },
            parent_run_id: parentSessionId,
          });
        });
        const childTools = (custom?.tools ?? this.allTools).filter(
          (tool) =>
            tool.name !== 'task' &&
            tool.name !== 'compact_conversation' &&
            tool.name !== 'plan_enter' &&
            tool.name !== 'plan_exit' &&
            (name !== 'explore' ||
              custom !== undefined ||
              EXPLORE_TOOLS.has(tool.name)),
        );
        const jobTools = buildTools(this.sandbox, {
          jobs: this.jobs,
          jobOwner: () => ({
            sessionId: parentSessionId,
            parent: backgroundJob?.id ?? session.id,
            startedBy: 'model',
          }),
          question: (args, context) =>
            askQuestions(
              this.options.home,
              this.sandbox,
              args,
              context.signal,
              {
                ask: this.options.question
                  ? (args, signal) =>
                      interact((origin) =>
                        this.options.question!(args, signal, origin),
                      )
                  : undefined,
                secret: this.options.secret
                  ? (request, signal) =>
                      interact((origin) =>
                        this.options.secret!(request, signal, origin),
                      )
                  : undefined,
              },
            ),
        });
        const ownedChildTools = childTools.map((tool) =>
          tool.name === 'write_todos'
            ? {
                ...tool,
                run: async (args: Record<string, unknown>) => {
                  childBus.emit('todo_list', {
                    payload: { todos: args.todos },
                  });
                  return 'Updated todo list.';
                },
              }
            : [
                  'execute',
                  'list_jobs',
                  'stop_job',
                  'wait_jobs',
                  'question',
                ].includes(tool.name)
              ? jobTools.find((jobTool) => jobTool.name === tool.name)!
              : tool,
        );
        const child = new Harness({
          model: childModel,
          tools: ownedChildTools,
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
            parentHarness.system,
          bus: childBus,
          approve: this.options.approve
            ? (call, signal) =>
                interact((origin) =>
                  this.options.approve!(call, signal, origin),
                )
            : undefined,
          headless: this.options.headless,
          approvalSessionId: parentSessionId,
          priceUsage: (model, usage) =>
            priceCall(this.catalog.facts(model, this.options.settings), usage),
          parentPlanMode: () => this.harness.planMode,
          toolBoundary: (tool, args, context) =>
            this.extensionToolBoundary(tool, args, context),
          prepareMessages: (signal) =>
            this.context.prepare(
              session.id,
              child.model,
              child.system,
              child.tools,
              signal,
              true,
            ),
        });
        child.planMode = name === 'explore';
        const runChild = async (signal: AbortSignal): Promise<string> => {
          const abort = (): void => {
            void child.cancel();
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            return (await child.run(String(args.description || ''))).answer;
          } finally {
            signal.removeEventListener('abort', abort);
            await this.jobs.stopOwned(backgroundJob?.id ?? session.id);
            this.childJobOwners.delete(session.id);
          }
        };
        if (args.background === true) {
          context.signal.throwIfAborted();
          const job = this.jobs.startAgent(
            `${name}: ${String(args.description || '')}`,
            { sessionId: parentSessionId, startedBy: 'model' },
            async (signal, log, job) => {
              backgroundJob = job;
              this.childJobOwners.set(session.id, {
                sessionId: parentSessionId,
                parent: job.id,
                startedBy: 'model',
              });
              backgroundLog = log;
              return runChild(signal);
            },
          );
          return `In background: ${jobLine(job)}. The subagent report will arrive as a notice; do not poll or sleep.`;
        }
        return runChild(context.signal);
      },
    });
    tools.push(this.lsp.tool());
    tools.push(...(this.options.extraTools ?? []));
    this.coreTools = tools;
    tools = this.withIntegrationTools(
      tools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    const harness = new Harness({
      model: this.extensions.model(model),
      tools,
      store: this.store,
      session: this.session,
      policy: this.policy,
      system,
      bus: this.bus,
      headless: this.options.headless,
      approve: this.options.approve,
      priceUsage: (model, usage) =>
        priceCall(this.catalog.facts(model, this.options.settings), usage),
      beforeRun: async (signal) => {
        if (this.userShells.busy) throw new Error('a user command is running');
        if (this.activeCompaction) throw new Error('a compaction is running');
        await this.initialize(signal);
      },
      beforeStep: () => {
        this.userShells.flush();
        const messages = this.jobs.takeNotices(this.harness.sessionId);
        if (messages.length)
          this.store.append(this.harness.sessionId, messages);
      },
      toolBoundary: (tool, args, context) =>
        this.extensionToolBoundary(tool, args, context),
      prepareMessages: (signal) =>
        this.context.prepare(
          this.session.id,
          this.harness.model,
          this.harness.system,
          this.harness.tools,
          signal,
        ),
      planFileMutation: (call) => {
        if (['write_file', 'edit_file', 'delete'].includes(call.name)) {
          const path = this.sandbox.resolvePath(
            String(call.args.file_path || call.args.path || ''),
          );
          return ['plan.md', 'plan'].includes(basename(path).toLowerCase());
        }
        if (call.name !== 'apply_patch') return false;
        const paths = [
          ...String(call.args.patchText || '').matchAll(
            /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm,
          ),
        ].map((match) => this.sandbox.resolvePath(match[1]!));
        return (
          paths.length > 0 &&
          paths.every((path) =>
            ['plan.md', 'plan'].includes(basename(path).toLowerCase()),
          )
        );
      },
    });
    harness.planMode = restoredPlanMode(harness.messages);
    return harness;
  }
  private extensionHost(reservedTools: Set<string>): ExtensionHost {
    const commands = discoverCustomCommands(
      this.options.workspace,
      this.options.home,
    );
    return new ExtensionHost({
      jobs: this.jobs,
      jobOwner: (context) =>
        this.childJobOwners.get(context.sessionId) ?? {
          sessionId: context.sessionId,
          startedBy: 'model',
        },
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
  private withIntegrationTools(tools: Tool[], limits = true): Tool[] {
    const names = new Set<string>();
    return [...tools, ...this.mcp.tools, ...this.extensions.tools()].filter(
      (tool) => {
        if (names.has(tool.name))
          throw new Error(`tool '${tool.name}' already exists`);
        if (limits && tool.name !== 'compact_conversation') {
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
        const base = this.coreTools;
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
        this.harness.tools = this.withIntegrationTools(
          base.filter((tool) => tool.name !== 'wait_jobs'),
        );
        const subagents = new Map<string, string>([
          ['general-purpose', 'General coding tasks.'],
          ['explore', 'Read-only project exploration.'],
        ]);
        for (const agent of host.subagents(this.allTools))
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
    if (this.busy) throw new Error('reload after the current turn');
    this.options.settings = loadSettings(this.options.home);
    this.integrationsReady = undefined;
    await this.initialize();
  }
  setPlanMode(enabled: boolean): void {
    if (this.harness.planMode === enabled) return;
    this.harness.planMode = enabled;
    this.store.append(this.session.id, [
      {
        id: randomUUID(),
        role: 'user',
        internal: 'mode-boundary',
        content: enabled
          ? '[Circle system] Plan mode is now ON. Do not create/edit/delete project files except plan.md; do not run shell commands. Research and update the plan only.'
          : '[Circle system] Plan mode is now OFF. Previous plan-mode constraints no longer apply. Implement changes subject to normal approval.',
      },
    ]);
  }
  setModel(model: string): void {
    if (this.busy) throw new Error('a turn is running');
    if (!model.trim()) throw new Error('model ID is required');
    const effort = this.thinkingLevel;
    const nextModel = new GatewayModel(
      this.options.settings,
      this.options.home,
      model,
      {},
      this.catalog,
    );
    nextModel.effort = effort;
    this.baseModel = nextModel;
    this.harness.model = this.extensions.model(this.baseModel);
    this.harness.system = buildSystemPrompt(
      this.options.workspace,
      model,
      this.options.settings.auth.protocol,
      this.runOptions,
      this.options.home,
    );
  }
  get thinkingLevel(): string {
    return this.baseModel instanceof GatewayModel
      ? this.baseModel.effort
      : this.options.settings.default_thinking;
  }
  setThinkingLevel(level: string): void {
    if (this.busy) throw new Error('a turn is running');
    if (!(EFFORT_LEVELS as readonly string[]).includes(level))
      throw new Error('unknown thinking depth');
    if (this.baseModel instanceof GatewayModel) this.baseModel.effort = level;
    this.options.settings.default_thinking = level;
  }
  stats(): {
    messages: number;
    toolCalls: number;
    usage: import('./types.js').Usage;
    costs: CostSummary;
  } {
    const messages = this.harness.messages;
    const usage = emptyUsage();
    for (const message of messages)
      if (message.usage) addUsage(usage, message.usage);
    const costs = messageCosts(messages);
    const compactions = new UsageCostTotals();
    const state = this.store.contextState(this.session.id);
    for (const id of state.subagentSessionIds ?? []) {
      if (!this.store.get(id)) continue;
      const messages = this.store.messages(id);
      for (const message of messages)
        if (message.usage) {
          addUsage(usage, message.usage);
          compactions.add(message.cost);
        }
      const childState = this.store.contextState(id);
      const calls =
        childState.compactionCalls ??
        (childState.summary?.usage
          ? [
              {
                usage: childState.summary.usage,
                cost: childState.summary.response?.cost,
              },
            ]
          : []);
      for (const call of calls) {
        addUsage(usage, call.usage);
        compactions.add(call.cost);
      }
    }
    const calls =
      state.compactionCalls ??
      (state.summary?.usage
        ? [{ usage: state.summary.usage, cost: state.summary.response?.cost }]
        : []);
    for (const call of calls) {
      addUsage(usage, call.usage);
      compactions.add(call.cost);
    }
    const summary = compactions.snapshot();
    for (const [currency, amount] of Object.entries(summary.amounts))
      costs.amounts[currency] = (costs.amounts[currency] ?? 0) + amount;
    costs.calls += summary.calls;
    costs.unpriced_calls += summary.unpriced_calls;
    return {
      messages: messages.length,
      toolCalls: messages.reduce(
        (sum, message) => sum + (message.tool_calls?.length || 0),
        0,
      ),
      usage,
      costs,
    };
  }
  async compact(hint = '', signal?: AbortSignal): Promise<string> {
    if (signal)
      return this.context.compact(
        this.session.id,
        this.harness.model,
        signal,
        hint,
        { system: this.harness.system, tools: this.harness.tools },
      );
    if (this.activeCompaction || this.harness.busy)
      throw new Error('a turn is running');
    this.compactionController = new AbortController();
    this.activeCompaction = this.context.compact(
      this.session.id,
      this.harness.model,
      this.compactionController.signal,
      hint,
      { system: this.harness.system, tools: this.harness.tools },
    );
    try {
      return await this.activeCompaction;
    } finally {
      this.activeCompaction = undefined;
      this.compactionController = undefined;
    }
  }
  get busy(): boolean {
    return (
      this.harness.busy ||
      this.userShells.busy ||
      Boolean(this.activeCompaction)
    );
  }
  async cancel(): Promise<void> {
    this.compactionController?.abort(new Error('Interrupted'));
    await Promise.allSettled([
      this.activeCompaction,
      this.harness.cancel(),
      this.userShells.cancel(),
    ]);
  }
  async newSession(): Promise<void> {
    if (this.busy) throw new Error('a turn is running');
    this.session = this.store.create(
      this.options.workspace,
      this.harness.model.model,
    );
    this.todos = [];
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.bus.setRunId(this.session.id);
    this.extensions.emit('session_start', {
      workspace: this.options.workspace,
      session_id: this.session.id,
    });
  }
  async switchSession(id: string): Promise<void> {
    if (this.busy) throw new Error('a turn is running');
    let session = this.store.find(id);
    if (!session) throw new Error('unknown session');
    if (session.workspace !== this.options.workspace)
      session = this.store.fork(session.id, this.options.workspace);
    this.session = session;
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.bus.setRunId(session.id);
  }
  async importSession(text: string): Promise<void> {
    if (this.busy) throw new Error('a turn is running');
    const { header, messages, graph } = fromJsonl(text);
    if (graph) {
      const session = this.store.importGraph(graph, this.options.workspace);
      this.session = session;
      this.harness = this.createHarness(this.options.model);
      this.todos = restoredTodos(this.harness.messages);
      this.bus.setRunId(session.id);
      this.extensions.emit('session_start', {
        workspace: this.options.workspace,
        session_id: session.id,
      });
      return;
    }
    await this.newSession();
    this.store.append(this.session.id, messages);
    this.harness.planMode = restoredPlanMode(messages);
    this.todos = restoredTodos(messages);
    if (typeof header.title === 'string')
      this.store.rename(this.session.id, header.title);
  }
  exportSession(): string {
    if (
      this.busy ||
      this.jobs
        .list(this.session.id)
        .some((job) => job.kind === 'agent' && job.status === 'running')
    )
      throw new Error(
        'export after the current turn and background subagents finish',
      );
    return toSessionBundle(this.store, this.session.id);
  }
  async close(saveJobNotes = true): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closingPromise = this.closeResources(saveJobNotes);
    return this.closingPromise;
  }
  private async closeResources(saveJobNotes: boolean): Promise<void> {
    await this.catalog.close();
    this.compactionController?.abort(new Error('Interrupted'));
    await this.activeCompaction?.catch(() => {});
    await this.harness.cancel();
    await this.userShells.cancel();
    const stopped = await this.jobs.close();
    this.userShells.flush();
    for (const sessionId of saveJobNotes
      ? new Set(stopped.map((job) => job.sessionId))
      : []) {
      const notices = this.jobs.takeNotices(sessionId);
      if (notices.length && this.store.get(sessionId))
        this.store.append(sessionId, notices);
    }
    await this.integrationsReady?.catch(() => {});
    await this.mcp.close();
    await this.lsp.close();
    this.store.close();
  }
  async runJobNotices(): Promise<string | undefined> {
    if (
      this.closing ||
      this.busy ||
      !this.jobs.hasNotices(this.session.id, true)
    )
      return undefined;
    return (await this.harness.run()).answer;
  }
}
