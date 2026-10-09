import type { Message } from '../types.js';
export interface SubagentView {
  id: string;
  name: string;
  description: string;
  messages: Message[];
  state: 'running' | 'waiting' | 'done' | 'error' | 'interrupted';
  started: number;
  // When its session last changed: the end of a subagent that is no longer running.
  updated?: number;
  tokens: number;
  background?: boolean;
  // The job a background subagent runs as: its row in the strip is the job's.
  jobId?: string;
}
export class SubagentNavigation {
  selected?: string;
  detail?: string;
  // Opened with enter from the strip, a record goes back to the strip; opened with the
  // mouse, back to the conversation, with nothing left selected.
  private fromStrip = false;
  open(id: string, fromStrip = false): void {
    this.detail = id;
    this.selected = id;
    this.fromStrip = fromStrip;
  }
  // Leave the record: to the strip it was opened from, else to the conversation.
  close(): void {
    this.detail = undefined;
    if (!this.fromStrip) this.selected = undefined;
    this.fromStrip = false;
  }
  clear(): void {
    this.detail = this.selected = undefined;
    this.fromStrip = false;
  }
  // A selection whose subagent no longer runs goes with it; an open record stays.
  prune(running: string[]): void {
    if (!this.detail && this.selected && !running.includes(this.selected))
      this.selected = undefined;
  }
  handle(key: string, char: string, ids: string[], draft: string): boolean {
    if (this.detail) {
      if (key === 'escape' || key === 'backspace') {
        this.close();
        return true;
      }
      if (key === 'left' || key === 'right') {
        const at = Math.max(0, ids.indexOf(this.detail));
        if (ids.length) {
          this.detail =
            ids[(at + (key === 'left' ? -1 : 1) + ids.length) % ids.length];
          this.selected = this.detail;
        }
        return true;
      }
      if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
        this.clear();
      return false;
    }
    if (this.selected) {
      const at = Math.max(0, ids.indexOf(this.selected));
      if ((key === 'up' || key === 'down') && ids.length) {
        this.selected =
          ids[(at + (key === 'up' ? -1 : 1) + ids.length) % ids.length];
        return true;
      }
      if (key === 'enter') {
        this.open(this.selected, true);
        return true;
      }
      if (key === 'escape') {
        this.selected = undefined;
        return true;
      }
      if (char) this.selected = undefined;
    } else if (key === 'down' && !draft && ids.length) {
      this.selected = ids[0];
      return true;
    }
    return false;
  }
}
