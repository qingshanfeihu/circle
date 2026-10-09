import {
  buildPalette,
  COLOR_QUERY,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  fallbackColors,
  hexToRgb,
  palette,
  relativeLuminance,
  setPalette,
  type RGB,
} from './theme.js';
import type { InputEvent } from './parse_keypress.js';
export class ThemeWatch {
  private fg?: string;
  private bg?: string;
  private slots: Record<number, RGB> = {};
  private polls = 0;
  private timer?: NodeJS.Timeout;
  private settle?: NodeJS.Timeout;
  private reading = '';
  // `changed` runs when the terminal reports different colours, with `dark` or `light`
  // when the palette flipped between the two (the footer flashes `Theme → …`).
  constructor(
    public mode: 'auto' | 'dark' | 'light',
    private output: (text: string) => void,
    private changed: (flip?: 'dark' | 'light') => void,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  start(): void {
    this.apply();
    this.output('\x1b[?2031h');
    this.query();
    this.timer = setInterval(() => this.query(), 2000);
  }
  private query(): void {
    if (this.mode === 'auto' && (this.polls++ < 3 || this.bg))
      this.output(COLOR_QUERY);
  }
  feed(event: InputEvent): void {
    if (event.type === 'scheme' && this.mode === 'auto') this.query();
    if (event.type !== 'color') return;
    if (event.slot === 10) this.fg = event.color;
    else if (event.slot === 11) this.bg = event.color;
    else this.slots[event.slot] = hexToRgb(event.color);
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      const reading = JSON.stringify([this.fg, this.bg, this.slots]);
      if (reading === this.reading) return;
      const first = !this.reading;
      this.reading = reading;
      const wasDark = palette().is_dark;
      this.apply();
      const dark = palette().is_dark;
      // The first answer only replaces the guess made before the terminal was asked.
      this.changed(
        !first && dark !== wasDark ? (dark ? 'dark' : 'light') : undefined,
      );
    }, 150);
  }
  apply(): void {
    const dark = this.bg ? relativeLuminance(this.bg) < 0.5 : true;
    const matches = this.mode === 'auto' || (this.mode === 'dark') === dark;
    const fallback =
      this.mode === 'light'
        ? DEFAULT_LIGHT
        : this.mode === 'dark'
          ? DEFAULT_DARK
          : fallbackColors(this.env);
    setPalette(
      this.fg && this.bg && matches
        ? buildPalette(this.fg, this.bg, this.slots)
        : buildPalette(...fallback),
    );
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.settle) clearTimeout(this.settle);
    this.output('\x1b[?2031l');
  }
}
