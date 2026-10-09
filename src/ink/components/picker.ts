import { palette, sgrJoin } from '../theme.js';
import { pad, truncate } from '../string_width.js';
export interface PickerItem {
  key: string;
  label: string;
  meta?: string;
  search?: string;
  current?: boolean;
}
export interface PickerOptions {
  keys?: Record<string, (item: PickerItem | undefined) => void | Promise<void>>;
  hint?: string;
  empty?: string;
  focusKey?: string;
}
export class Picker {
  query = '';
  focus = 0;
  constructor(
    readonly title: string,
    public items: PickerItem[],
    readonly pick: (item: PickerItem) => void,
    readonly close: () => void,
    readonly options: PickerOptions = {},
  ) {
    this.focus = Math.max(
      0,
      items.findIndex((item) =>
        options.focusKey ? item.key === options.focusKey : item.current,
      ),
    );
  }
  setItems(items: PickerItem[]): void {
    const key = this.matches()[this.focus]?.key;
    this.items = items;
    this.focus = Math.max(
      0,
      this.matches().findIndex((item) => item.key === key),
    );
  }
  matches(): PickerItem[] {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((item) =>
      words.every((word) =>
        `${item.label} ${item.meta || ''} ${item.search || ''}`
          .toLowerCase()
          .includes(word),
      ),
    );
  }
  handle(key: string, char: string): void {
    const shown = this.matches();
    if (this.options.keys?.[key]) {
      this.options.keys[key](shown[this.focus]);
      return;
    }
    if (['up', 'ctrl+p'].includes(key) && shown.length)
      this.focus = (this.focus - 1 + shown.length) % shown.length;
    else if (['down', 'ctrl+n'].includes(key) && shown.length)
      this.focus = (this.focus + 1) % shown.length;
    else if (key === 'enter') {
      const item = shown[this.focus];
      if (item) this.pick(item);
    } else if (key === 'escape') {
      if (this.query) {
        this.query = '';
        this.focus = 0;
      } else this.close();
    } else if (key === 'backspace') {
      this.query = Array.from(this.query).slice(0, -1).join('');
      this.focus = 0;
    } else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+')) {
      this.query += char;
      this.focus = 0;
    }
  }
  rows(width: number, maximum = 10): string[] {
    const p = palette();
    const shown = this.matches();
    const top = Math.max(0, this.focus - maximum + 1);
    const rows = [
      `   ${this.title}`,
      ...(this.options.hint ? [`   ${this.options.hint}`] : []),
      `   ${this.query ? 'search: ' + this.query : 'type to search'}`,
    ].map(
      (text) =>
        sgrJoin(p.panel_bg, p.faint) +
        pad(truncate(text, width), width) +
        p.reset,
    );
    shown
      .slice(top, top + maximum)
      .forEach((item, index) =>
        rows.push(
          sgrJoin(index + top === this.focus ? p.sel_bg : p.panel_bg, p.text) +
            pad(
              truncate(
                `   ${item.label}${item.current ? ' · current' : ''}  ${item.meta || ''}`,
                width,
              ),
              width,
            ) +
            p.reset,
        ),
      );
    if (!shown.length)
      rows.push(
        p.faint + '   ' + (this.options.empty ?? 'Nothing to show') + p.reset,
      );
    return rows;
  }
}
