interface Request {
  background: boolean;
  start(): Promise<void>;
  cancel(): void;
}
// A card waits until typing in the draft has been idle this long, so a key meant for the
// draft never answers it.
export const CARD_TYPING_IDLE_MS = 1000;
/** Own the whole card lifecycle, including QuestionCard and masked-entry state. */
export class InteractionQueue {
  private queue: Request[] = [];
  private active = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private lastKey = Number.NEGATIVE_INFINITY;
  constructor(
    private ready: (background: boolean) => boolean,
    private drafting: () => boolean = () => false,
  ) {}
  /** A key reached the session: a card that arrives now waits for typing to pause. */
  typed(): void {
    this.lastKey = Date.now();
  }
  /** The draft has text and a key came less than CARD_TYPING_IDLE_MS ago. */
  get typing(): boolean {
    return this.drafting() && Date.now() - this.lastKey < CARD_TYPING_IDLE_MS;
  }
  run<T>(
    action: () => Promise<T>,
    signal: AbortSignal,
    background = false,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Interrupted'));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        const index = this.queue.indexOf(request);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(signal.reason);
        }
        signal.removeEventListener('abort', abort);
      };
      const request: Request = {
        background,
        cancel: () => {
          signal.removeEventListener('abort', abort);
          reject(new Error('Interrupted'));
        },
        start: async () => {
          signal.removeEventListener('abort', abort);
          try {
            signal.throwIfAborted();
            resolve(await action());
          } catch (error) {
            reject(error);
          }
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(request);
      this.pump();
    });
  }
  private pump(): void {
    if (this.closed || this.active) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const request = this.typing
      ? undefined
      : (this.queue.find(
          (request) => !request.background && this.ready(false),
        ) ?? this.queue.find((request) => this.ready(request.background)));
    if (!request) {
      if (this.queue.length) this.timer = setTimeout(() => this.pump(), 50);
      return;
    }
    this.queue.splice(this.queue.indexOf(request), 1);
    this.active = true;
    void request.start().finally(() => {
      this.active = false;
      this.pump();
    });
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const request of this.queue.splice(0)) request.cancel();
  }
}
/** The draft a card set aside: its text and cursor come back when the card ends. */
export class ParkedDraft {
  private saved?: { text: string; cursor: number };
  park(state: { draft: string; draftCursor: number }): void {
    this.saved ??= { text: state.draft, cursor: state.draftCursor };
    state.draft = '';
    state.draftCursor = 0;
  }
  /** Whatever was typed under the card goes; the parked draft comes back whole. */
  restore(state: { draft: string; draftCursor: number }): void {
    if (!this.saved) return;
    state.draft = this.saved.text;
    state.draftCursor = Math.min(
      this.saved.cursor,
      Array.from(this.saved.text).length,
    );
    this.saved = undefined;
  }
}
