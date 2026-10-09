import { randomUUID } from 'node:crypto';
import type {
  ChatModel,
  Message,
  Tool,
  ToolCall,
  Usage,
  MediaAttachment,
} from './types.js';
import { emptyUsage, addUsage } from './types.js';
import { EventBus } from './events.js';
import { ApprovalPolicy, wildcard } from './approvals.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import { attachPrompt } from './mentions.js';
import { prepareToolCall, RecoverableToolError } from './tool_call_compat.js';
import { redact } from './redact.js';
import { httpStatus } from './model_guard.js';
import { validateAttachments } from './media.js';
export type ApprovalDecision =
  | 'approve'
  | 'reject'
  | 'always'
  | 'prefix'
  // a rejection with the user's reason, which the model reads in the tool result
  | { decision: 'reject'; message: string };
export interface HarnessOptions {
  model: ChatModel;
  tools: Tool[];
  store: CheckpointStore;
  session: Session;
  policy: ApprovalPolicy;
  system: string;
  bus?: EventBus;
  approve?: (call: ToolCall, signal: AbortSignal) => Promise<ApprovalDecision>;
  maxSteps?: number;
  headless?: boolean;
  beforeRun?: (signal: AbortSignal) => Promise<void>;
  beforeStep?: () => void;
  priceUsage?: (
    model: string,
    usage: Usage,
  ) => import('./pricing.js').PriceReceipt;
  toolBoundary?: (
    tool: Tool,
    args: Record<string, unknown>,
    context: import('./types.js').ToolContext,
  ) => Promise<string>;
  prepareMessages?: (signal: AbortSignal) => Promise<Message[]>;
  approvalSessionId?: string;
  parentPlanMode?: () => boolean;
  planFileMutation?: (call: ToolCall) => boolean;
}
export class Harness {
  private promptFileAllowed(path: string): boolean {
    const name = path.replaceAll('\\', '/').split('/').at(-1)!;
    return !this.options.policy.credentialFiles.some((pattern) =>
      wildcard(pattern, name),
    );
  }
  readonly bus: EventBus;
  readonly sessionId: string;
  tools: Tool[];
  model: ChatModel;
  system: string;
  planMode = false;
  private controller?: AbortController;
  private steering: string[] = [];
  private followUps: string[] = [];
  /** How the input box showed a prompt the model reads in full: long pastes stay folded on screen. */
  readonly shown = new Map<
    string,
    { display: string; pastes?: Record<string, string> }
  >();
  private active?: Promise<{ answer: string; usage: Usage }>;
  constructor(readonly options: HarnessOptions) {
    this.sessionId = options.session.id;
    this.bus = options.bus ?? new EventBus(this.sessionId);
    this.tools = options.tools;
    this.model = options.model;
    this.system = options.system;
    options.store.repairInterrupted(this.sessionId);
  }
  get busy(): boolean {
    return Boolean(this.active);
  }
  get pendingMessageCount(): number {
    return this.steering.length + this.followUps.length;
  }
  get messages(): Message[] {
    return this.options.store.messages(this.sessionId);
  }
  private get readOnly(): boolean {
    return this.planMode || this.options.parentPlanMode?.() === true;
  }
  queue(message: string, mode: 'steer' | 'followUp' = 'steer'): void {
    (mode === 'steer' ? this.steering : this.followUps).push(message);
  }
  get queuedMessages(): { steering: string[]; followUp: string[] } {
    return { steering: [...this.steering], followUp: [...this.followUps] };
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    const result = {
      steering: this.steering.splice(0),
      followUp: this.followUps.splice(0),
    };
    for (const message of [...result.steering, ...result.followUp])
      this.shown.delete(message);
    return result;
  }
  // Stop the turn. `keepQueue`, as esc in 0.5.0: the messages it had not read yet stay, each
  // to be sent as a turn of its own (the steering ones first), and nothing starts them here.
  async cancel(options: { keepQueue?: boolean } = {}): Promise<void> {
    if (options.keepQueue) this.followUps.unshift(...this.steering.splice(0));
    else {
      this.followUps = [];
      this.steering = [];
      this.shown.clear();
    }
    this.controller?.abort(new Error('Interrupted'));
    try {
      await this.active;
    } catch {
      /* run_error and persisted results record the stop. */
    }
  }
  private save(message: Message): void {
    this.options.store.append(this.sessionId, [message]);
  }
  private shownAs(prompt: string): Pick<Message, 'display' | 'pastes'> {
    const shown = this.shown.get(prompt);
    this.shown.delete(prompt);
    return shown ?? { display: prompt };
  }
  // `display` is what the conversation shows for the prompt when it differs from the text
  // the model gets (`circle "question" @file`).
  async run(
    prompt?: string,
    display?: string,
  ): Promise<{ answer: string; usage: Usage }> {
    if (this.active) throw new Error('a turn is already running');
    if (prompt !== undefined && display !== undefined && display !== prompt)
      this.shown.set(prompt, { display });
    this.controller = new AbortController();
    this.active = this.runQueued(prompt, this.controller.signal);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
      this.controller = undefined;
    }
  }
  private async runQueued(
    prompt: string | undefined,
    signal: AbortSignal,
  ): Promise<{ answer: string; usage: Usage }> {
    await this.options.beforeRun?.(signal);
    signal.throwIfAborted();
    const total = emptyUsage();
    let answer = '';
    let next: string | undefined =
      prompt ?? this.steering.shift() ?? this.followUps.shift();
    do {
      const result = await this.runTurn(next, signal);
      answer = result.answer;
      addUsage(total, result.usage);
      next = this.followUps.shift();
    } while (next !== undefined);
    return { answer, usage: total };
  }
  private async runTurn(
    prompt: string | undefined,
    signal: AbortSignal,
  ): Promise<{ answer: string; usage: Usage }> {
    const start = Date.now();
    const usage = emptyUsage();
    let answer = '';
    const shown = prompt === undefined ? undefined : this.shownAs(prompt);
    if (prompt !== undefined)
      this.save({
        id: randomUUID(),
        role: 'user',
        ...(await attachPrompt(
          prompt,
          this.options.session.workspace,
          signal,
          (path) => this.promptFileAllowed(path),
        )),
        ...shown,
      });
    const session = this.options.store.get(this.sessionId)!;
    if (!session.title && shown?.display !== undefined)
      this.options.store.rename(
        this.sessionId,
        shown.display.split('\n')[0]!.slice(0, 100),
      );
    this.bus.emit('run_start', { payload: { message: prompt } });
    try {
      for (let step = 0; step < (this.options.maxSteps ?? 9999); step++) {
        signal.throwIfAborted();
        for (const message of this.steering.splice(0)) {
          this.save({
            id: randomUUID(),
            role: 'user',
            ...(await attachPrompt(message, session.workspace, signal, (path) =>
              this.promptFileAllowed(path),
            )),
            ...this.shownAs(message),
          });
          this.bus.emit('steer', { payload: { message } });
        }
        this.options.beforeStep?.();
        this.bus.emit('llm_start');
        const response = await this.model.complete({
          system:
            this.system +
            (this.readOnly
              ? this.options.planFileMutation
                ? '\nRead-only mode: inspect and plan; only plan.md or plan files may be changed, subject to approval. Do not run shell commands.'
                : '\nRead-only mode: inspect and plan; do not change files or run commands.'
              : ''),
          messages: this.options.prepareMessages
            ? await this.options.prepareMessages(signal)
            : this.options.store.projectedMessages(this.sessionId),
          tools: this.tools,
          signal,
          notice: (event) =>
            this.bus.emit('info', { payload: { model_notice: event } }),
          token: (text, thinking) =>
            this.bus.emit('llm_token', {
              payload: { text, thinking: Boolean(thinking) },
            }),
        });
        signal.throwIfAborted();
        const message = {
          ...response.message,
          request_model: this.model.model,
          usage: response.usage,
          cost:
            response.message.cost ??
            this.options.priceUsage?.(
              response.message.model || this.model.model,
              response.usage,
            ),
        };
        this.save(message);
        addUsage(usage, response.usage);
        this.bus.emit('llm_end', {
          payload: { message },
          usage: { ...response.usage },
        });
        const calls = response.message.tool_calls ?? [];
        if (!calls.length) {
          answer = response.message.content;
          if (!answer.trim()) throw new Error('model ended without an answer');
          if (this.steering.length) continue;
          this.bus.emit('run_end', {
            payload: { answer },
            usage: { ...usage },
            elapsed_ms: Date.now() - start,
          });
          return { answer, usage };
        }
        // As in 0.5.0, the subagents of task calls next to each other run at the same time;
        // every other call runs on its own, in order. Results are stored in the order of the
        // calls, each once those before it are in.
        for (let index = 0; index < calls.length;) {
          let end = index + 1;
          if (this.parallel(calls[index]!))
            while (end < calls.length && this.parallel(calls[end]!)) end++;
          const batch = calls.slice(index, end);
          const results: (Message | undefined)[] = [];
          let stored = 0;
          const settled = await Promise.allSettled(
            batch.map(async (call, at) => {
              results[at] = await this.runCall(call, signal);
              while (results[stored]) this.finishCall(results[stored++]!);
            }),
          );
          for (const outcome of settled)
            if (outcome.status === 'rejected') throw outcome.reason;
          index = end;
        }
        signal.throwIfAborted();
      }
      throw new Error('maximum model steps reached');
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      this.bus.emit('run_error', {
        payload: {
          message: redact(
            failure instanceof Error ? failure.message : String(failure),
          ),
          interrupted: signal.aborted,
          // 401 or 403: the endpoint turned the key down
          status: signal.aborted ? undefined : httpStatus(failure),
        },
        usage: { ...usage },
        elapsed_ms: Date.now() - start,
      });
      throw failure;
    }
  }
  // A task call (its name as the tool table resolves it): its subagent can run beside others.
  private parallel(call: ToolCall): boolean {
    try {
      return prepareToolCall(call, this.tools).tool.name === 'task';
    } catch {
      return false;
    }
  }
  // One call: checked, approved when it must be, and run. The result comes back to be stored
  // by the caller, which keeps the results in the order of the calls.
  private async runCall(
    original: ToolCall,
    signal: AbortSignal,
  ): Promise<Message> {
    let call = original;
    let content = '';
    let status: 'success' | 'error' = 'success';
    let recoverable = false;
    let attachments: MediaAttachment[] = [];
    let acceptingAttachments = true;
    this.bus.emit('tool_call', { payload: { ...call } });
    try {
      signal.throwIfAborted();
      const prepared = prepareToolCall(call, this.tools);
      call = prepared.call;
      const tool = prepared.tool;
      if (
        this.readOnly &&
        tool.effect !== 'read' &&
        !this.options.planFileMutation?.(call)
      )
        throw new Error('read-only mode: this tool cannot run');
      const found = this.options.policy.review(call.name, call.args);
      if (found.verdict === 'DENY')
        throw new Error(found.message || found.reason);
      if (
        tool.effect !== 'read' &&
        tool.approval !== false &&
        (this.options.policy.needsApproval(
          call.name,
          call.args,
          this.options.approvalSessionId ?? this.sessionId,
        ) ||
          (this.options.headless && found.verdict === 'ASK_FORCED'))
      ) {
        this.bus.emit('tool_waiting', {
          payload: { ...call, reason: found.reason },
        });
        if (!this.options.approve)
          throw new Error(
            found.verdict === 'ASK_FORCED'
              ? 'not run: this operation always asks'
              : 'not run: needs --yolo or approval',
          );
        const decision = await this.options.approve(call, signal);
        signal.throwIfAborted();
        const reason =
          typeof decision === 'string' ? '' : decision.message.trim();
        if (
          !this.options.policy.remember(
            this.options.approvalSessionId ?? this.sessionId,
            call.name,
            call.args,
            typeof decision === 'string' ? decision : decision.decision,
          )
        )
          throw new Error(
            'The user rejected this tool call.' +
              (reason ? ` The user said: ${reason}` : ''),
          );
      }
      signal.throwIfAborted();
      if (
        this.readOnly &&
        tool.effect !== 'read' &&
        !this.options.planFileMutation?.(call)
      )
        throw new Error('read-only mode: this tool cannot run');
      this.bus.emit('tool_start', { payload: { ...call } });
      const context = {
        signal,
        sessionId: this.sessionId,
        emitAttachments: (items: MediaAttachment[]) => {
          if (!acceptingAttachments)
            throw new Error('tool attachment channel is closed');
          signal.throwIfAborted();
          validateAttachments(items);
          attachments.push(...structuredClone(items));
          validateAttachments(attachments);
        },
      };
      const guardedTool: Tool = {
        ...tool,
        run: async (args, context) => {
          signal.throwIfAborted();
          if (
            this.readOnly &&
            tool.effect !== 'read' &&
            !this.options.planFileMutation?.(call)
          )
            throw new Error('read-only mode: this tool cannot run');
          return tool.run(args, context);
        },
      };
      content = this.options.toolBoundary
        ? await this.options.toolBoundary(guardedTool, call.args, context)
        : await guardedTool.run(call.args, context);
      if (typeof content !== 'string') throw new Error('tool must return text');
      signal.throwIfAborted();
    } catch (error) {
      status = 'error';
      recoverable = error instanceof RecoverableToolError;
      attachments = [];
      content = redact(error instanceof Error ? error.message : String(error));
    } finally {
      acceptingAttachments = false;
    }
    return {
      id: randomUUID(),
      role: 'tool',
      content,
      tool_call_id: call.id,
      name: call.name,
      status,
      ...(attachments.length ? { attachments } : {}),
      ...(recoverable ? { recoverable: true } : {}),
    };
  }
  // The result of a call goes into the conversation and onto the bus.
  private finishCall(result: Message): void {
    this.save(result);
    const status = result.status ?? 'success';
    this.bus.emit('tool_result', {
      payload: {
        id: result.tool_call_id,
        name: result.name,
        status,
        output: result.content,
      },
    });
    this.bus.emit('tool_end', { payload: { id: result.tool_call_id, status } });
  }
}
