import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ChatModel, Message, ToolCall } from './types.js';
import { GatewayModel } from './model.js';
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
  }
  private createHarness(modelOverride?: ChatModel): Harness {
    const model =
      modelOverride ??
      new GatewayModel(this.options.settings, this.options.home);
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
        if (!['general-purpose', 'explore'].includes(name))
          throw new Error('unknown subagent type');
        const session = this.store.create(
          this.options.workspace,
          model.model,
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
        const childTools = tools.filter(
          (tool) =>
            tool.name !== 'task' && tool.name !== 'compact_conversation',
        );
        const child = new Harness({
          model,
          tools: childTools,
          store: this.store,
          session,
          policy: this.policy,
          system:
            readFileSync(
              join(
                import.meta.dirname,
                'prompts/agent',
                name === 'explore' ? 'explore.md' : 'generate.md',
              ),
              'utf8',
            ) +
            '\n' +
            system,
          bus: childBus,
          approve: this.options.approve,
          headless: this.options.headless,
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
    return new Harness({
      model,
      tools,
      store: this.store,
      session: this.session,
      policy: this.policy,
      system,
      bus: this.bus,
      headless: this.options.headless,
      approve: this.options.approve,
    });
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
    this.store.close();
  }
}
