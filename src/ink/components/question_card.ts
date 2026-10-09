import type { Question } from '../../questions.js';
import {
  printable,
  type Card,
  type CardLine,
  type CardResult,
  type DialogState,
} from './dialog_card.js';
// the typed answer's place in a question's selection
const OTHER = -1;
type Warning = 'submit' | 'switch' | 'cancel' | 'advance';
/**
 * The model's questions as one card. It collects one answer per question, a list of
 * labels (a typed answer is one more entry), and answers `null` when you drop the card
 * without answering. Several questions share the card: `←` `→` (or `tab`) move between
 * them, choosing one moves on, and `enter` on the last one sends them all. `esc` asks
 * first when it would drop a choice or an answer.
 */
export class QuestionCard implements Card<string[][] | null> {
  index = 0;
  private highlight = 0;
  private selected: Set<number>[];
  private typed = new Map<number, string>();
  private touched: boolean[];
  input: string | undefined;
  private emptyHint = false;
  private warning?: string;
  private warned?: Warning;
  private expanded = false;
  constructor(
    readonly questions: Question[],
    private origin = '',
  ) {
    this.selected = questions.map(() => new Set());
    this.touched = questions.map(() => false);
  }
  private get question(): Question {
    return this.questions[this.index]!;
  }
  private rows(): number {
    return this.question.options.length + (this.question.custom ? 1 : 0);
  }
  private otherHighlighted(): boolean {
    return (
      this.question.custom && this.highlight === this.question.options.length
    );
  }
  state(): DialogState {
    const question = this.question;
    const multiple = question.multiple;
    const selected = this.selected[this.index]!;
    const total = this.questions.length;
    let title =
      'The model has a question' +
      (total > 1 ? ` · ${this.index + 1}/${total}` : '');
    if (this.origin) title = `${this.origin} · ${title}`;
    const text = question.question.split('\n');
    const lines: CardLine[] =
      text.length > 6 && !this.expanded
        ? [
            ...text
              .slice(0, 4)
              .map((line) => ({ text: line, tone: 'em' as const })),
            { text: `… +${text.length - 5} lines · ctrl+o`, tone: 'dim' },
            { text: text.at(-1)!, tone: 'em' },
          ]
        : text.map((line) => ({ text: line, tone: 'em' as const }));
    if (question.header) lines.push({ text: question.header, tone: 'dim' });
    const options = question.options.map((option) => option.label);
    const notes: CardLine[] = [];
    const marks = question.options.map((_, index) =>
      multiple ? selected.has(index) : undefined,
    );
    const keys = question.options.map(() => '');
    if (question.custom) {
      options.push('Type your own');
      keys.push('o');
      marks.push(multiple ? selected.has(OTHER) : undefined);
      const typed = this.typed.get(this.index);
      if (typed) notes.push({ text: `→ ${typed}`, tone: 'text' });
      if (this.emptyHint)
        notes.push({
          text: "An answer can't be empty. Type something or press esc.",
          tone: 'warn',
        });
    }
    if (this.warning) notes.push({ text: this.warning, tone: 'warn' });
    return {
      title,
      body: '',
      lines,
      options,
      optionKeys: keys,
      optionNotes: question.options.map((option) => option.description),
      marks,
      notes,
      focus: Math.min(this.highlight, Math.max(0, options.length - 1)),
      tint: 'think_bg',
      ...(this.input !== undefined ? { input: this.input } : {}),
    };
  }
  handle(key: string, char: string): CardResult<string[][] | null> {
    if (this.input !== undefined) {
      if (key === 'enter') return this.submitTyped(this.input);
      if (key === 'escape') {
        this.emptyHint = false;
        this.input = undefined;
      } else if (key === 'backspace')
        this.input = Array.from(this.input).slice(0, -1).join('');
      else if (key.startsWith('ctrl+')) return 'pass';
      else this.input += printable(key, char);
      return undefined;
    }
    const rows = this.rows();
    if (
      key === 'up' ||
      key === 'ctrl+p' ||
      key === 'down' ||
      key === 'ctrl+n'
    ) {
      this.clearWarning();
      this.touched[this.index] = true;
      this.highlight =
        (this.highlight + (key === 'up' || key === 'ctrl+p' ? -1 : 1) + rows) %
        rows;
      return undefined;
    }
    if (/^[1-9]$/.test(key)) {
      const number = Number(key);
      if (number > rows) return undefined;
      if (this.warned === 'submit') {
        this.clearWarning();
        return this.submit();
      }
      this.clearWarning();
      this.touched[this.index] = true;
      this.highlight = number - 1;
      if (this.otherHighlighted()) {
        this.input = '';
        return undefined;
      }
      if (this.question.multiple) {
        this.toggle();
        return undefined;
      }
      this.selected[this.index] = new Set([this.highlight]);
      return this.advanceOrSubmit();
    }
    if (key === ' ' || key === 'space') {
      this.clearWarning();
      this.toggle();
      return undefined;
    }
    if (key === 'escape')
      return this.guardCancel() ? { answer: null } : undefined;
    if (this.questions.length > 1) {
      const step =
        key === 'left' || key === 'shift+tab'
          ? -1
          : key === 'right' || key === 'tab'
            ? 1
            : 0;
      if (step) {
        if (this.guardSwitch(this.index + step)) this.go(this.index + step);
        return undefined;
      }
    }
    if (key === 'ctrl+o' || key === 'ctrl+t') {
      this.expanded = !this.expanded;
      return undefined;
    }
    if (key === 'o' || key === 'O') {
      if (this.question.custom) {
        this.clearWarning();
        this.highlight = rows - 1;
        this.input = '';
      }
      return undefined;
    }
    if (key === 'enter') {
      if (this.warned === 'submit') {
        this.clearWarning();
        return this.submit();
      }
      return this.enter();
    }
    if (key.startsWith('ctrl+')) return 'pass';
    return undefined; // printable and everything else: swallowed
  }
  paste(text: string): void {
    if (this.input !== undefined)
      this.input += printable('paste', text.replace(/\s*\n\s*/g, ' '));
  }
  private uncommitted(): boolean {
    return this.touched[this.index]! && !this.selected[this.index]!.size;
  }
  private warnOnce(op: Warning, message: string): boolean {
    if (this.warned === op) {
      this.clearWarning();
      return true;
    }
    this.warned = op;
    this.warning = message;
    return false;
  }
  private clearWarning(): void {
    this.warning = undefined;
    this.warned = undefined;
  }
  private guardSwitch(target: number): boolean {
    if (target < 0 || target >= this.questions.length || !this.uncommitted())
      return true;
    return this.warnOnce(
      'switch',
      'Not chosen yet. Press enter to choose, or switch again to skip it.',
    );
  }
  private guardCancel(): boolean {
    if (this.uncommitted())
      return this.warnOnce(
        'cancel',
        'Not chosen yet. Press enter to choose, or esc again to drop the question.',
      );
    const answered = this.selected.filter((set) => set.size).length;
    if (answered)
      return this.warnOnce(
        'cancel',
        `${answered} answered. Press esc again to drop them all.`,
      );
    return true;
  }
  private toggle(): void {
    if (!this.question.multiple) return;
    this.touched[this.index] = true;
    const selected = this.selected[this.index]!;
    const key = this.otherHighlighted() ? OTHER : this.highlight;
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
  }
  private enter(): CardResult<string[][] | null> {
    if (this.otherHighlighted()) {
      this.clearWarning();
      this.input = '';
      return undefined;
    }
    if (!this.question.multiple)
      this.selected[this.index] = new Set([this.highlight]);
    else if (
      this.uncommitted() &&
      !this.warnOnce(
        'advance',
        'Nothing ticked yet. Tick with space, or press enter again to go on without.',
      )
    )
      return undefined;
    return this.advanceOrSubmit();
  }
  private submitTyped(text: string): CardResult<string[][] | null> {
    const answer = text.trim();
    if (!answer) {
      this.emptyHint = true;
      return undefined;
    }
    this.emptyHint = false;
    this.typed.set(this.index, answer);
    if (this.question.multiple) this.selected[this.index]!.add(OTHER);
    else this.selected[this.index] = new Set([OTHER]);
    this.input = undefined;
    return this.advanceOrSubmit();
  }
  private advanceOrSubmit(): CardResult<string[][] | null> {
    if (this.index < this.questions.length - 1) {
      this.go(this.index + 1);
      return undefined;
    }
    const missing = this.selected.filter((set) => !set.size).length;
    if (
      missing &&
      !this.warnOnce(
        'submit',
        this.questions.length > 1
          ? `${missing} unanswered. Press enter again to send them as empty.`
          : 'Nothing chosen. Press enter again to send an empty answer.',
      )
    )
      return undefined;
    return this.submit();
  }
  private go(index: number): void {
    if (index < 0 || index >= this.questions.length) return;
    this.index = index;
    const selected = this.selected[index]!;
    const first = this.questions[index]!.options.findIndex((_, option) =>
      selected.has(option),
    );
    this.highlight =
      first >= 0
        ? first
        : selected.has(OTHER) && this.questions[index]!.custom
          ? this.questions[index]!.options.length
          : 0;
    this.clearWarning();
  }
  /** The answer to question `index`: the chosen labels in their order, then a typed one. */
  answerFor(index: number): string[] {
    const selected = this.selected[index]!;
    const answer = this.questions[index]!.options.filter((_, option) =>
      selected.has(option),
    ).map((option) => option.label);
    const typed = this.typed.get(index)?.trim();
    if (selected.has(OTHER) && typed) answer.push(typed);
    return answer;
  }
  private submit(): CardResult<string[][] | null> {
    return { answer: this.questions.map((_, index) => this.answerFor(index)) };
  }
}
