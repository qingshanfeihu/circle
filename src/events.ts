import { AsyncLocalStorage } from 'node:async_hooks';
export type EventKind =
  | 'job_started'
  | 'job_updated'
  | 'job_ended'
  | 'run_start'
  | 'run_end'
  | 'run_error'
  | 'tool_call'
  | 'tool_start'
  | 'tool_waiting'
  | 'tool_result'
  | 'tool_end'
  | 'llm_start'
  | 'llm_token'
  | 'llm_end'
  | 'todo_list'
  | 'ask_user_request'
  | 'ask_user_presented'
  | 'ask_user_answered'
  | 'ask_user_resolved'
  | 'error'
  | 'warn'
  | 'info'
  | 'steer';
export interface CircleEvent {
  run_id: string;
  parent_run_id: string | null;
  seq: number;
  ts: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  tags: Record<string, unknown>;
  usage?: Record<string, number>;
  elapsed_ms?: number;
}
export class EventBus {
  private seq = 0;
  private sinks = new Set<(event: CircleEvent) => void>();
  private tags: Record<string, unknown> = {};
  constructor(private runId = '') {}
  setRunId(id: string): void {
    this.runId = id;
  }
  setDefaultTags(tags: Record<string, unknown>): void {
    Object.assign(this.tags, tags);
  }
  subscribe(sink: (event: CircleEvent) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }
  emit(
    kind: EventKind,
    options: Partial<Omit<CircleEvent, 'kind' | 'seq' | 'ts' | 'run_id'>> = {},
  ): CircleEvent {
    const event: CircleEvent = {
      ...options,
      kind,
      run_id: this.runId,
      parent_run_id: options.parent_run_id ?? null,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      payload: options.payload ?? {},
      tags: { ...this.tags, ...options.tags },
    };
    for (const sink of [...this.sinks]) {
      try {
        sink(event);
      } catch {
        /* A display callback cannot stop the agent. */
      }
    }
    return event;
  }
}
const current = new AsyncLocalStorage<EventBus>();
const defaultBus = new EventBus();
export function getDefaultBus(): EventBus {
  return current.getStore() ?? defaultBus;
}
export function withEventBus<T>(bus: EventBus, action: () => T): T {
  return current.run(bus, action);
}
