import { spawn } from 'node:child_process';

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\';

/** Runs a program with `input` on its stdin. Resolves to its exit code, -1 when it was
 * stopped or ran past `timeout` milliseconds, and null when it could not be started. */
export type CommandRunner = (
  command: string,
  args: string[],
  input: Buffer,
  timeout: number,
) => Promise<number | null>;

export const runCommand: CommandRunner = (command, args, input, timeout) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeout);
    child.once('error', () => finish(null));
    // xclip and wl-copy stay behind to serve the selection: their exit is enough
    child.once('exit', (code) => finish(code ?? -1));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

/** OSC 52: the terminal puts the text on the system clipboard, also over ssh. */
export function osc52(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, 'utf8').toString('base64')}${BEL}`;
}

/** tmux's DCS passthrough. Inner ESCs are doubled. tmux drops it unless
 * `set -g allow-passthrough on`. */
export function tmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
}

const LINUX_TOOLS: [string, string[]][] = [
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
];
const COPY_TOOLS: [string, string[]][] = [
  ['pbcopy', []],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
];

/** clip.exe reads its input in the OEM code page unless it starts with a UTF-16 mark. */
function windowsText(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf16le'),
  ]);
}

export interface ClipboardOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Writes to the terminal. */
  write?: (sequence: string) => void;
}

export class Clipboard {
  private env: NodeJS.ProcessEnv;
  private platform: NodeJS.Platform;
  private run: CommandRunner;
  private write: (sequence: string) => void;
  /** The Linux tool that started last time; '' when none did. */
  private linuxTool?: string;
  /** The local tool started by the last copySelection, for tests to wait on. */
  pending: Promise<void> = Promise.resolve();
  constructor(options: ClipboardOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
    this.write = options.write ?? ((text) => process.stdout.write(text));
  }
  /** A mouse selection: a local tool when this is not an ssh session, tmux's buffer inside
   * tmux, and always OSC 52 to the terminal (through tmux when its buffer took the text).
   * Resolves to the sequence written; '' for empty text. */
  async copySelection(text: string): Promise<string> {
    if (!text) return '';
    const raw = osc52(text);
    if (!this.env.SSH_CONNECTION) this.pending = this.copyLocal(text);
    const sequence = (await this.tmuxLoadBuffer(text))
      ? tmuxPassthrough(raw)
      : raw;
    this.write(sequence);
    return sequence;
  }
  /** `/copy`: the first local tool that takes the text. False when none did. */
  async copyNative(text: string): Promise<boolean> {
    if (this.platform === 'win32')
      return (await this.run('clip', [], windowsText(text), 2000)) === 0;
    const input = Buffer.from(text, 'utf8');
    for (const [command, args] of COPY_TOOLS)
      if ((await this.run(command, args, input, 2000)) === 0) return true;
    return false;
  }
  private async copyLocal(text: string): Promise<void> {
    if (this.platform === 'darwin') {
      await this.run('pbcopy', [], Buffer.from(text, 'utf8'), 2000);
      return;
    }
    if (this.platform === 'win32') {
      await this.run('clip', [], windowsText(text), 2000);
      return;
    }
    if (this.platform !== 'linux' || this.linuxTool === '') return;
    const input = Buffer.from(text, 'utf8');
    const known = LINUX_TOOLS.find(([command]) => command === this.linuxTool);
    if (known) {
      await this.run(known[0], known[1], input, 2000);
      return;
    }
    for (const [command, args] of LINUX_TOOLS)
      if ((await this.run(command, args, input, 2000)) !== null) {
        this.linuxTool = command;
        return;
      }
    this.linuxTool = '';
  }
  private async tmuxLoadBuffer(text: string): Promise<boolean> {
    if (!this.env.TMUX) return false;
    // -w passes the buffer on to the outer terminal; 0.5.0 left it out under iTerm2
    const args =
      this.env.LC_TERMINAL === 'iTerm2'
        ? ['load-buffer', '-']
        : ['load-buffer', '-w', '-'];
    return (
      (await this.run('tmux', args, Buffer.from(text, 'utf8'), 2000)) === 0
    );
  }
}
