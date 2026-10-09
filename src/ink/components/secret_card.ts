import {
  printable,
  type Card,
  type CardResult,
  type DialogState,
} from './dialog_card.js';
// The longest value the entry takes, in characters.
export const SECRET_MAX_CHARS = 512;
/**
 * The masked entry of a secret. The value stays in memory and goes straight to the
 * request's answer file; it never reaches the conversation. `enter` sends it (an empty
 * value is refused and the card stays), `esc` and `ctrl+c` answer `null`. A request that
 * asks for no mask (a user name) shows what is typed.
 */
export class SecretCard implements Card<string | null> {
  private value = '';
  private empty = false;
  constructor(
    private body: string,
    private masked = true,
  ) {}
  state(): DialogState {
    return {
      title: 'secret',
      body: this.body,
      options: [],
      focus: 0,
      input: this.value,
      masked: this.masked,
      ...(this.empty
        ? { notes: [{ text: "A secret can't be empty.", tone: 'warn' }] }
        : {}),
    };
  }
  handle(key: string, char: string): CardResult<string | null> {
    if (key === 'enter') {
      if (!this.value) {
        this.empty = true;
        return undefined;
      }
      const value = this.value;
      this.value = '';
      return { answer: value };
    }
    if (key === 'escape' || key === 'ctrl+c') {
      this.value = '';
      return { answer: null };
    }
    if (key === 'backspace')
      this.value = Array.from(this.value).slice(0, -1).join('');
    else if (printable(key, char)) this.add(char);
    return undefined;
  }
  paste(text: string): void {
    this.add(text);
  }
  private add(raw: string): void {
    // a value is taken as typed, without control characters (a pasted line break)
    const text = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (!text) return;
    this.empty = false;
    this.value = Array.from(this.value + text)
      .slice(0, SECRET_MAX_CHARS)
      .join('');
  }
}
