import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatModel, Message, ModelNotice, Tool, Usage } from './types.js';
import { CheckpointStore, type ContextState } from './checkpoint_store.js';
import type { Todo } from './tools.js';
import {
  nextPruneState,
  pruneMessages,
  tokenLen,
  type PruneOptions,
} from './middleware/tool_result_prune.js';
import { planReminder } from './middleware/plan_tail.js';
import { loopReminder } from './middleware/loop_guard.js';
import { isRecord } from './settings.js';
import type { CompactionEvent } from './compaction.js';
import { redact } from './redact.js';
export interface ContextOptions {
  contextWindow?: number;
  autoCompact?: boolean;
  offloadChars?: number;
  prune?: PruneOptions;
  notice?: (event: ModelNotice) => void;
  progress?: (event: CompactionEvent) => void;
  priceUsage?: (
    model: string,
    usage: Usage,
  ) => import('./pricing.js').PriceReceipt;
}
export function messageTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      4 +
      tokenLen(
        message.provider_content
          ? JSON.stringify(message.provider_content)
          : message.content + (message.thinking || ''),
      ) +
      tokenLen(JSON.stringify(message.tool_calls ?? [])),
    0,
  );
}
export function restoredTodos(messages: Message[]): Todo[] {
  const completed = new Set(
    messages
      .filter(
        (message) => message.role === 'tool' && message.status !== 'error',
      )
      .map((message) => message.tool_call_id),
  );
  for (const message of [...messages].reverse())
    for (const call of [...(message.tool_calls ?? [])].reverse())
      if (
        call.name === 'write_todos' &&
        completed.has(call.id) &&
        Array.isArray(call.args.todos)
      ) {
        return call.args.todos
          .filter(isRecord)
          .filter(
            (todo) =>
              typeof todo.content === 'string' &&
              ['pending', 'in_progress', 'completed'].includes(
                String(todo.status),
              ),
          )
          .map((todo) => ({
            content: String(todo.content),
            status: todo.status as Todo['status'],
          }));
      }
  return [];
}
export function restoredPlanMode(messages: Message[]): boolean {
  for (const message of [...messages].reverse())
    if (message.role === 'user' && message.internal === 'mode-boundary') {
      const match = /^\[Circle system\] Plan mode is now (ON|OFF)\./.exec(
        message.content,
      );
      if (match) return match[1] === 'ON';
    }
  return false;
}
export class ContextManager {
  constructor(
    readonly store: CheckpointStore,
    readonly root: string,
    readonly options: ContextOptions = {},
  ) {}
  private recoverArtifacts(raw: Message[], state: ContextState): void {
    const restore = (virtual: string, body: string): void => {
      if (
        !/^\/(large_tool_results|conversation_history)\/[a-f0-9]{24}\.(txt|jsonl)$/.test(
          virtual,
        )
      )
        throw new Error('invalid context artifact path');
      const path = join(this.root, virtual.slice(1));
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(body)))
          throw new Error('context artifact does not match raw history');
        return;
      }
      mkdirSync(join(this.root, virtual.split('/')[1]!), { recursive: true });
      writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    };
    for (const message of raw) {
      const path = state.offloaded[message.id];
      if (path) restore(path, message.content);
    }
    if (state.summary?.historyPath) {
      const cutoff = raw.findIndex(
        (message) => message.id === state.summary!.cutoffMessageId,
      );
      if (cutoff >= 0)
        restore(
          state.summary.historyPath,
          raw
            .slice(0, cutoff + 1)
            .map((message) => JSON.stringify(message))
            .join('\n') + '\n',
        );
    }
  }
  private offload(
    messages: Message[],
    state: ContextState,
    sessionId: string,
  ): ContextState {
    let next = state;
    const changed: string[] = [];
    for (const message of messages) {
      if (
        message.role !== 'tool' ||
        ['question', 'skill'].includes(message.name || '') ||
        state.offloaded[message.id] ||
        Array.from(message.content).length <=
          (this.options.offloadChars ?? 80000)
      )
        continue;
      const name =
        createHash('sha256')
          .update(sessionId + ':' + message.id)
          .digest('hex')
          .slice(0, 24) + '.txt';
      const folder = join(this.root, 'large_tool_results');
      mkdirSync(folder, { recursive: true });
      const path = join(folder, name);
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(message.content)))
          throw new Error('offloaded tool output does not match raw history');
      } else writeFileSync(path, message.content, { mode: 0o600, flag: 'wx' });
      if (next === state) next = structuredClone(state);
      next.offloaded[message.id] = '/large_tool_results/' + name;
      changed.push(message.id);
    }
    if (changed.length) {
      const first = messages.findIndex((message) =>
        changed.includes(message.id),
      );
      next.stripThinkingIds = [
        ...new Set([
          ...next.stripThinkingIds,
          ...messages
            .slice(first + 1)
            .filter((message) => message.role === 'assistant')
            .map((message) => message.id),
        ]),
      ];
    }
    return next;
  }
  project(sessionId: string): Message[] {
    const state = this.store.contextState(sessionId);
    return this.projectWith(this.store.projectedMessages(sessionId), state);
  }
  private projectWith(messages: Message[], state: ContextState): Message[] {
    return pruneMessages(
      messages.map((message) => {
        const path = state.offloaded[message.id];
        if (message.role !== 'tool' || !path) return message;
        return {
          ...message,
          content: `Tool output is too large to include here. Full output saved at ${path}. Use read_file with offset and limit to recover it.\n\n${Array.from(message.content).slice(0, 1600).join('')}\n…`,
        };
      }),
      state,
    );
  }
  async prepare(
    sessionId: string,
    model: ChatModel,
    system: string,
    tools: Tool[],
    signal: AbortSignal,
    subagent = false,
  ): Promise<Message[]> {
    signal.throwIfAborted();
    const raw = this.store.messages(sessionId);
    const visible = this.store.projectedMessages(sessionId);
    const reminders = [
      planReminder(raw, visible, restoredTodos(raw), subagent),
      loopReminder(raw),
    ].filter((message): message is Message => message !== undefined);
    if (reminders.length) this.store.append(sessionId, reminders);
    let state = this.store.contextState(sessionId);
    const messages = this.store.projectedMessages(sessionId);
    this.recoverArtifacts(this.store.messages(sessionId), state);
    const offloaded = this.offload(messages, state, sessionId);
    const next = nextPruneState(
      this.projectWith(messages, offloaded),
      offloaded,
      this.options.prune,
    );
    if (next !== state) {
      this.store.setContextState(sessionId, next);
      state = next;
    }
    let projected = this.project(sessionId);
    const parsed = Number(process.env.CIRCLE_CONTEXT_WINDOW || 128000);
    const window =
      this.options.contextWindow ??
      model.contextWindow ??
      (Number.isFinite(parsed) && parsed > 0 ? parsed : 128000);
    const estimate =
      tokenLen(system) +
      tokenLen(JSON.stringify(tools.map(({ run: _run, ...tool }) => tool))) +
      messageTokens(projected);
    const budget = window * 0.95 - (model.outputBudget ?? 0);
    if (
      (this.options.autoCompact ?? true) &&
      (estimate >= window * 0.85 || estimate > budget)
    ) {
      await this.compact(sessionId, model, signal, '', {
        system,
        tools,
        trigger: estimate >= window * 0.85 ? 'auto' : 'overflow',
      });
      projected = this.project(sessionId);
    }
    return projected;
  }
  async compact(
    sessionId: string,
    model: ChatModel,
    signal: AbortSignal,
    hint = '',
    frame: {
      system?: string;
      tools?: Tool[];
      trigger?: CompactionEvent['trigger'];
    } = {},
  ): Promise<string> {
    signal.throwIfAborted();
    const visible = this.project(sessionId);
    if (visible.length < 2) return 'Nothing to compact yet';
    let end = visible.length - 6;
    if (model.contextWindow) {
      const keepTokens = model.contextWindow * 0.1;
      let kept = 0;
      end = visible.length;
      while (end > 0) {
        const size = messageTokens([visible[end - 1]!]);
        if (kept + size > keepTokens) break;
        kept += size;
        end--;
      }
      end = Math.min(end, visible.length - 1);
    }
    while (end > 0) {
      try {
        this.store.requireBalancedTools(visible.slice(0, end));
        break;
      } catch {
        end--;
      }
    }
    if (end <= 0) return 'Nothing to compact yet';
    const prefix = visible.slice(0, end);
    const initialHead = this.store.get(sessionId)!.head;
    const started = Date.now();
    const trigger = frame.trigger ?? 'tool';
    const overhead =
      tokenLen(frame.system ?? '') +
      tokenLen(
        JSON.stringify(
          (frame.tools ?? []).map(({ run: _run, ...tool }) => tool),
        ),
      );
    const tokensBefore = overhead + messageTokens(visible);
    const emit = (
      phase: CompactionEvent['phase'],
      extra: Partial<CompactionEvent> = {},
    ): void => {
      try {
        this.options.progress?.({ sessionId, phase, trigger, ...extra });
      } catch {
        /* Displays cannot interrupt compaction. */
      }
    };
    emit('start', {
      tokens_before: tokensBefore,
      summarized: prefix.length,
      kept: visible.length - end,
    });
    try {
      const stateBefore = this.store.contextState(sessionId);
      const cutoffMessage = visible[end - 1]!;
      const cutoffId =
        cutoffMessage.internal === 'summary'
          ? stateBefore.summary?.cutoffMessageId
          : cutoffMessage.id;
      const raw = this.store.messages(sessionId);
      const cutoff = raw.findIndex((message) => message.id === cutoffId);
      if (cutoff < 0)
        throw new Error('summary boundary is no longer on the active branch');
      const name =
        createHash('sha256')
          .update(sessionId + ':' + cutoffId)
          .digest('hex')
          .slice(0, 24) + '.jsonl';
      const folder = join(this.root, 'conversation_history');
      mkdirSync(folder, { recursive: true });
      const path = join(folder, name);
      const bytes =
        raw
          .slice(0, cutoff + 1)
          .map((message) => JSON.stringify(message))
          .join('\n') + '\n';
      emit('saving');
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(bytes)))
          throw new Error('summary history does not match raw conversation');
      } else writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      const virtualPath = '/conversation_history/' + name;
      emit('saved', { file: virtualPath });
      signal.throwIfAborted();
      emit('summarizing');
      let chunks = 0;
      const response = await model.complete({
        system:
          'Summarize the conversation so another coding agent can continue. Preserve exact goals, constraints, decisions, paths, completed results and unresolved tasks. Use these headings: Goal, Decisions, Files & paths, Open tasks, Notes. Reply with the summary only. ' +
          hint,
        messages: [
          { id: randomUUID(), role: 'user', content: JSON.stringify(prefix) },
        ],
        tools: [],
        signal,
        token: () => {
          chunks++;
          if (chunks === 1 || chunks % 8 === 0) emit('chunks', { chunks });
        },
        notice: this.options.notice,
      });
      signal.throwIfAborted();
      if (!response.message.content.trim() || response.message.truncated)
        throw new Error('summary did not complete');
      emit('summarized', { chunks });
      if (this.store.get(sessionId)?.head !== initialHead)
        throw new Error('conversation changed during compaction');
      const state = this.store.contextState(sessionId);
      response.message.cost ??= this.options.priceUsage?.(
        response.message.model || model.model,
        response.usage,
      );
      const priorCalls =
        state.compactionCalls ??
        (state.summary?.usage
          ? [
              {
                id: 'legacy-' + state.summary.cutoffMessageId,
                model: state.summary.model ?? '',
                usage: state.summary.usage,
                cost: state.summary.response?.cost,
              },
            ]
          : []);
      this.store.setContextState(sessionId, {
        ...state,
        compactionCalls: [
          ...priorCalls,
          {
            id: randomUUID(),
            model: response.message.model || model.model,
            usage: response.usage,
            cost: response.message.cost,
          },
        ],
        summary: {
          cutoffMessageId: cutoffId!,
          text: response.message.content,
          historyPath: virtualPath,
          usage: response.usage,
          response: response.message,
          model: model.model,
        },
      });
      emit('done', {
        tokens_before: tokensBefore,
        tokens_after: overhead + messageTokens(this.project(sessionId)),
        summarized: prefix.length,
        kept: visible.length - end,
        file: virtualPath,
        seconds: (Date.now() - started) / 1000,
      });
      this.options.notice?.({ event: 'compacted', messages: cutoff + 1 });
      return `Compacted ${cutoff + 1} messages. Raw history retained.`;
    } catch (error) {
      emit('error', {
        message: redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }
}
