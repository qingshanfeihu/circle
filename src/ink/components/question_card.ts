import type { Question } from '../../questions.js';
import type { DialogState } from './dialog_card.js';
export class QuestionCard {
  focus = 0;
  selected = new Set<number>();
  input: string | undefined;
  constructor(readonly question: Question) {
    if (!question.options.length) this.input = '';
  }
  get options(): string[] {
    return [
      ...this.question.options.map(
        (option) =>
          option.label + (option.description ? ' — ' + option.description : ''),
      ),
      ...(this.question.custom ? ['type your own answer'] : []),
    ];
  }
  state(): DialogState {
    return {
      title: this.question.header || 'question',
      body: this.question.question,
      options: this.options.map(
        (option, index) =>
          (this.question.multiple && index < this.question.options.length
            ? this.selected.has(index)
              ? '[x] '
              : '[ ] '
            : '') + option,
      ),
      focus: this.focus,
      ...(this.input !== undefined ? { input: this.input } : {}),
    };
  }
  handle(key: string, char: string): string[] | undefined {
    if (key === 'escape' || key === 'ctrl+c') return [];
    if (this.input !== undefined) {
      if (key === 'enter')
        return [
          ...this.chosen(),
          ...(this.input.trim() ? [this.input.trim()] : []),
        ];
      if (key === 'backspace')
        this.input = Array.from(this.input).slice(0, -1).join('');
      else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
        this.input += char;
      return undefined;
    }
    if (key === 'up' || key === 'down') {
      if (this.options.length)
        this.focus =
          (this.focus + (key === 'up' ? -1 : 1) + this.options.length) %
          this.options.length;
      return undefined;
    }
    if (/^[1-9]$/.test(key) && Number(key) <= this.options.length) {
      this.focus = Number(key) - 1;
      return this.choose();
    }
    if (
      key === ' ' &&
      this.question.multiple &&
      this.focus < this.question.options.length
    ) {
      if (this.selected.has(this.focus)) this.selected.delete(this.focus);
      else this.selected.add(this.focus);
      return undefined;
    }
    if (key === 'enter') return this.choose();
    return undefined;
  }
  paste(text: string): void {
    if (this.input === undefined && this.question.custom) this.input = '';
    if (this.input !== undefined) this.input += text;
  }
  private chosen(): string[] {
    return [...this.selected]
      .sort((a, b) => a - b)
      .map((index) => this.question.options[index]!.label);
  }
  private choose(): string[] | undefined {
    if (this.question.custom && this.focus === this.question.options.length) {
      this.input = '';
      return undefined;
    }
    if (this.question.multiple) return this.chosen();
    const option = this.question.options[this.focus];
    return option ? [option.label] : [];
  }
}
