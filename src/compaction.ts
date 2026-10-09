export type CompactionPhase =
  | 'start'
  | 'saving'
  | 'saved'
  | 'summarizing'
  | 'chunks'
  | 'summarized'
  | 'done'
  | 'error';
export interface CompactionEvent {
  sessionId: string;
  phase: CompactionPhase;
  trigger: 'auto' | 'overflow' | 'tool';
  chunks?: number;
  tokens_before?: number;
  tokens_after?: number;
  summarized?: number;
  kept?: number;
  file?: string;
  seconds?: number;
  message?: string;
}
const stages = {
  start: 'starting',
  saving: 'saving history',
  saved: 'history saved',
  summarizing: 'summarizing',
  summarized: 'summarized',
};
export class CompactionProgress {
  stage = 'starting';
  saved = false;
  summarized = false;
  chunks = 0;
  readonly started = Date.now();
  constructor(readonly trigger: CompactionEvent['trigger']) {}
  apply(event: CompactionEvent): void {
    if (event.phase === 'saved') this.saved = true;
    if (event.phase === 'summarized') this.summarized = true;
    if (event.phase === 'chunks')
      this.chunks = Math.max(this.chunks, event.chunks ?? 0);
    else if (event.phase in stages)
      this.stage = stages[event.phase as keyof typeof stages];
  }
  get label(): string {
    return this.trigger === 'tool' ? 'compacting' : 'auto-compacting';
  }
  fraction(): number {
    return Math.min(
      1,
      0.05 +
        (this.saved ? 0.1 : 0) +
        0.85 * (this.summarized ? 1 : 1 - Math.exp(-this.chunks / 400)),
    );
  }
  elapsed(now = Date.now()): number {
    return Math.max(0, (now - this.started) / 1000);
  }
}
const tokens = (n?: number): string =>
  n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function compactionDone(event: CompactionEvent): string {
  return `${event.trigger === 'tool' ? 'compacted' : 'auto-compacted'} · ~${tokens(event.tokens_before)} → ~${tokens(event.tokens_after)} tokens · summarized ${event.summarized ?? '?'} messages, kept ${event.kept ?? '?'}${event.seconds !== undefined ? ` · ${event.seconds.toFixed(0)}s` : ''}${event.file ? ` · history: ${event.file}` : ''}`;
}
