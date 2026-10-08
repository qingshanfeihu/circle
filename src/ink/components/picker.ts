import { palette, sgrJoin } from '../theme.js';
import { pad, truncate } from '../string_width.js';
export interface PickerItem {
  key: string;
  label: string;
  meta?: string;
  search?: string;
  current?: boolean;
}
export class Picker {
  query = '';
  focus = 0;
  constructor(
    readonly title: string,
    readonly items: PickerItem[],
    readonly pick: (item: PickerItem) => void,
    readonly close: () => void,
  ) {}
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
    if (key === 'up' && shown.length)
      this.focus = (this.focus - 1 + shown.length) % shown.length;
    else if (key === 'down' && shown.length)
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
    if (!shown.length) rows.push(p.faint + '   Nothing to show' + p.reset);
    return rows;
  }
}
