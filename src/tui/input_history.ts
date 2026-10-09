import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export class InputHistory {
  private values: string[] = [];
  private cursor?: number;
  private draft = '';
  query?: string;
  private at = -1;
  constructor(
    readonly path: string,
    readonly maximum = 1000,
  ) {
    try {
      const body = readFileSync(path, 'utf8');
      if (body.startsWith('{"format":"circle-history"')) {
        const data: unknown = JSON.parse(body);
        if (
          data &&
          typeof data === 'object' &&
          'items' in data &&
          Array.isArray(data.items)
        )
          this.values = data.items
            .filter(
              (item): item is string =>
                typeof item === 'string' && Boolean(item.trim()),
            )
            .slice(-maximum);
      } else
        this.values = body
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .slice(-maximum);
    } catch {
      /* An unavailable history file must not prevent typing. */
    }
  }
  static forHome(home: string): InputHistory {
    return new InputHistory(
      process.env.CIRCLE_HISTORY_PATH || join(home, 'history'),
    );
  }
  get items(): string[] {
    return [...this.values];
  }
  add(text: string): void {
    text = text.trimEnd();
    if (!text.trim()) return;
    if (this.values.at(-1) !== text)
      this.values = [...this.values, text].slice(-this.maximum);
    this.reset();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify({
          format: 'circle-history',
          version: 1,
          items: this.values,
        }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      /* Keep the in-memory history usable. */
    }
  }
  reset(): void {
    this.cursor = undefined;
    this.draft = '';
  }
  up(current: string): string | undefined {
    if (!this.values.length) return undefined;
    if (this.cursor === undefined) {
      this.draft = current;
      this.cursor = this.values.length - 1;
    } else this.cursor = Math.max(0, this.cursor - 1);
    return this.values[this.cursor];
  }
  down(): string | undefined {
    if (this.cursor === undefined) return undefined;
    if (this.cursor < this.values.length - 1) return this.values[++this.cursor];
    this.cursor = undefined;
    return this.draft;
  }
  beginSearch(current: string): string | undefined {
    this.draft = current;
    this.query = current;
    this.at = -1;
    return this.next();
  }
  update(query: string): string | undefined {
    this.query = query;
    this.at = -1;
    return this.next();
  }
  next(): string | undefined {
    if (!this.query) return undefined;
    const matches = [...this.values]
      .reverse()
      .filter((item) =>
        item.toLocaleLowerCase().includes(this.query!.toLocaleLowerCase()),
      );
    if (!matches.length) return undefined;
    this.at = (this.at + 1) % matches.length;
    return matches[this.at];
  }
  endSearch(restore: boolean): string {
    this.query = undefined;
    this.at = -1;
    return restore ? this.draft : '';
  }
}
