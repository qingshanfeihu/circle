import { parseColorSpec } from './theme.js';
export type InputEvent =
  | { type: 'key'; key: string; char: string }
  | { type: 'paste'; text: string }
  | { type: 'color'; slot: number; color: string }
  | { type: 'scheme'; dark: boolean }
  | {
      type: 'mouse';
      action: 'press' | 'release' | 'move' | 'wheel';
      button: number;
      x: number;
      y: number;
    }
  | { type: 'upload'; filename: string }
  | { type: 'switch'; id: string };
const CSI: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '2~': 'insert',
  '3~': 'delete',
  '4~': 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
  Z: 'shift+tab',
  '11~': 'f1',
  '12~': 'f2',
  '13~': 'f3',
  '14~': 'f4',
  '15~': 'f5',
  '17~': 'f6',
  '18~': 'f7',
  '19~': 'f8',
  '20~': 'f9',
  '21~': 'f10',
  '23~': 'f11',
  '24~': 'f12',
};
const key = (name: string, char = ''): InputEvent => ({
  type: 'key',
  key: name,
  char,
});
export class InputParser {
  private buffer = '';
  private paste: string | null = null;
  private timer?: NodeJS.Timeout;
  private stray = 0;
  constructor(private emit?: (event: InputEvent) => void) {}
  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }
  feed(data: string): InputEvent[] {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (
      this.stray &&
      Date.now() - this.stray <= 1000 &&
      /^\[(?:<\d+;\d+;\d+[Mm]|[0-9;?]*[A-Za-z~])$/.test(data)
    )
      data = '\x1b' + data;
    this.stray = 0;
    this.buffer += data;
    const events: InputEvent[] = [];
    while (this.buffer) {
      if (this.paste !== null) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) {
          const hold = Math.min(5, this.buffer.length);
          this.paste += this.buffer.slice(0, -hold);
          this.buffer = this.buffer.slice(-hold);
          break;
        }
        this.paste += this.buffer.slice(0, end);
        events.push({ type: 'paste', text: this.paste });
        this.paste = null;
        this.buffer = this.buffer.slice(end + 6);
        continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) {
        this.paste = '';
        this.buffer = this.buffer.slice(6);
        continue;
      }
      if (this.buffer[0] !== '\x1b') {
        const char = String.fromCodePoint(this.buffer.codePointAt(0)!);
        this.buffer = this.buffer.slice(char.length);
        const code = char.codePointAt(0)!;
        events.push(
          key(
            code === 13
              ? 'enter'
              : code === 9
                ? 'tab'
                : code === 127
                  ? 'backspace'
                  : code < 32
                    ? 'ctrl+' + String.fromCharCode(code + 96)
                    : char,
            code === 127 ? '' : char,
          ),
        );
        continue;
      }
      if (this.buffer.length === 1) break;
      if (this.buffer.startsWith('\x1b\x1b')) {
        events.push(key('escape'));
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.startsWith('\x1b]')) {
        const match = this.buffer.match(/^\x1b\]([\s\S]*?)(?:\x07|\x1b\\)/);
        if (!match) break;
        this.buffer = this.buffer.slice(match[0].length);
        const parts = match[1]!.split(';');
        const code = parts.shift()!;
        const color = parseColorSpec(parts.at(-1) || '');
        if ((code === '10' || code === '11' || code === '4') && color)
          events.push({
            type: 'color',
            slot: code === '4' ? Number(parts[0]) : Number(code),
            color,
          });
        else if (code === '7001' || code === '7003') {
          const payload = parts.join(';');
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
            const value = Buffer.from(payload, 'base64')
              .toString('utf8')
              .trim();
            if (value)
              events.push(
                code === '7001'
                  ? { type: 'upload', filename: value }
                  : { type: 'switch', id: value },
              );
          }
        }
        continue;
      }
      if (this.buffer.startsWith('\x1b[')) {
        const match = this.buffer.match(/^\x1b\[([0-?]*[ -/]*[@-~])/);
        if (!match) break;
        this.buffer = this.buffer.slice(match[0].length);
        const body = match[1]!;
        if (body.startsWith('?')) {
          if (/^\?997;[12]n$/.test(body))
            events.push({ type: 'scheme', dark: body === '?997;1n' });
          continue;
        }
        const mouse = body.match(/^<(\d+);(\d+);(\d+)([Mm])$/);
        if (mouse) {
          const code = Number(mouse[1]);
          events.push({
            type: 'mouse',
            action:
              code & 64
                ? 'wheel'
                : code & 32
                  ? 'move'
                  : mouse[4] === 'm'
                    ? 'release'
                    : 'press',
            button: code & 64 ? code & 1 : code & 3,
            x: Number(mouse[2]) - 1,
            y: Number(mouse[3]) - 1,
          });
          continue;
        }
        if (/^13;(?:2|3|4)u$/.test(body)) {
          events.push(key('shift+enter'));
          continue;
        }
        const modified = body.match(/^(\d+);(\d+)([A-Za-z~])$/);
        if (modified) {
          const modifier = Number(modified[2]) - 1;
          let name = CSI[modified[3]!] || CSI[modified[1] + '~'];
          if (name) {
            if (modifier & 1) name = 'shift+' + name;
            if (modifier & 2) name = 'alt+' + name;
            if (modifier & 4) name = 'ctrl+' + name;
            events.push(key(name));
          }
          continue;
        }
        if (CSI[body]) events.push(key(CSI[body]!));
        continue;
      }
      if (this.buffer.startsWith('\x1bO')) {
        if (this.buffer.length < 3) break;
        const char = this.buffer[2]!;
        const name =
          CSI[char] ||
          ({ P: 'f1', Q: 'f2', R: 'f3', S: 'f4' } as Record<string, string>)[
            char
          ];
        if (name) events.push(key(name));
        this.buffer = this.buffer.slice(3);
        continue;
      }
      const char = String.fromCodePoint(this.buffer.codePointAt(1)!);
      this.buffer = this.buffer.slice(1 + char.length);
      events.push(
        key(
          char === '\r' || char === '\n'
            ? 'shift+enter'
            : char === '\x7f'
              ? 'alt+backspace'
              : 'alt+' + char,
          char,
        ),
      );
    }
    if (this.buffer === '\x1b' && this.emit)
      this.timer = setTimeout(() => {
        this.buffer = '';
        this.stray = Date.now();
        this.emit!(key('escape'));
      }, 250);
    return events;
  }
}
