import type { Message } from '../types.js';
export interface SubagentView {
  id: string;
  name: string;
  description: string;
  messages: Message[];
  state: 'running' | 'waiting' | 'done' | 'error' | 'interrupted';
  started: number;
  tokens: number;
  background?: boolean;
}
export class SubagentNavigation {
  selected?: string;
  detail?: string;
  handle(key: string, char: string, ids: string[], draft: string): boolean {
    if (this.detail) {
      if (key === 'escape' || key === 'backspace') {
        this.detail = undefined;
        return true;
      }
      if (key === 'left' || key === 'right') {
        const at = Math.max(0, ids.indexOf(this.detail));
        if (ids.length)
          this.detail =
            ids[(at + (key === 'left' ? -1 : 1) + ids.length) % ids.length];
        return true;
      }
      if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+')) {
        this.detail = undefined;
        this.selected = undefined;
      }
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
        this.detail = this.selected;
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
