import type { Message } from '../types.js';
// What the screen showed at one moment: which session, which of its messages, and the notes
// under them. /undo and /redo put the screen back to one of these. They change only what is
// shown: the model keeps every message, as in the Python releases.
export interface ScreenSnapshot {
  sessionId: string;
  shown: Set<string>;
  notices: string[];
  noticeAnchors?: (string | undefined)[];
}
const LIMIT = 40;
export class UndoHistory {
  private undoStack: ScreenSnapshot[] = [];
  private redoStack: ScreenSnapshot[] = [];
  // Messages of the open session that are not drawn, because a turn was undone.
  private hidden = new Set<string>();
  visible(messages: Message[]): Message[] {
    return this.hidden.size
      ? messages.filter((message) => !this.hidden.has(message.id))
      : messages;
  }
  snapshot(
    sessionId: string,
    messages: Message[],
    notices: string[],
    noticeAnchors: (string | undefined)[] = [],
  ): ScreenSnapshot {
    return {
      sessionId,
      shown: new Set(this.visible(messages).map((message) => message.id)),
      notices: [...notices],
      noticeAnchors: [...noticeAnchors],
    };
  }
  // A turn starts: the screen before it is what /undo goes back to.
  push(snapshot: ScreenSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > LIMIT)
      this.undoStack.splice(0, this.undoStack.length - LIMIT);
    this.redoStack = [];
  }
  undo(current: ScreenSnapshot): ScreenSnapshot | undefined {
    const previous = this.undoStack.pop();
    if (previous) this.redoStack.push(current);
    return previous;
  }
  redo(current: ScreenSnapshot): ScreenSnapshot | undefined {
    const next = this.redoStack.pop();
    if (next) this.undoStack.push(current);
    return next;
  }
  // Show `messages` (the session's now) as `snapshot` showed them; later ones stay hidden.
  restore(snapshot: ScreenSnapshot, messages: Message[]): void {
    this.hidden = new Set(
      messages
        .map((message) => message.id)
        .filter((id) => !snapshot.shown.has(id)),
    );
  }
  // The screen was drawn again from the saved messages (another session, a branch).
  showAll(): void {
    this.hidden.clear();
  }
}
