import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime, type RuntimeOptions } from '../runtime.js';
import type { CircleSettings } from '../settings.js';
import {
  saveCredentials,
  saveSettings,
  loadCredentials,
  loadSettings,
  trustFolder,
  isFolderTrusted,
  clearCredentials,
  withConnection,
} from '../settings.js';
import { defaultAuth } from '../settings.js';
import { normalizeBaseUrl, resolveEndpoint } from '../probe.js';
import { InputParser, type InputEvent } from '../ink/parse_keypress.js';
import { ThemeWatch } from '../ink/theme_watch.js';
import { Picker, type PickerItem } from '../ink/components/picker.js';
import { welcomeRows } from '../ink/components/welcome.js';
import { renderScreen, type ScreenState } from './render.js';
import { currentBranch } from '../git_info.js';
import { loadRemap, ACTIONS } from '../keybindings.js';
import { emptyUsage, type ToolCall } from '../types.js';
import { ScreenRenderer } from '../ink/screen.js';
import { type ApprovalDecision } from '../harness.js';
import { BUILTIN_SLASH, parseSlash } from './slash_commands.js';
import { GatewayModel, EFFORT_LEVELS } from '../model.js';
import { exportKind, toHtml, toJsonl, toMarkdown } from '../session_export.js';
import {
  discoverCustomCommands,
  expandCommandTemplate,
  splitArguments,
} from '../commands.js';
import { loadSkillBody } from '../skills.js';
import { complete } from '../mentions.js';
export const VERSION = '0.1.0-dev';
interface DialogPending {
  complete: (answer: string) => void;
  abort?: () => void;
}
export class SessionApp {
  runtime?: AgentRuntime;
  readonly state: ScreenState;
  private input = new InputParser((event) => this.handle(event));
  private screen = new ScreenRenderer((text) => process.stdout.write(text));
  private theme: ThemeWatch;
  private remap: Record<string, string>;
  private pending?: DialogPending;
  private ended = false;
  private animation?: NodeJS.Timeout;
  private flashTimer?: NodeJS.Timeout;
  private done!: (code: number) => void;
  private completion: Promise<number>;
  private previousSession = '';
  private lastEscape = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draftBeforeHistory = '';
  private off?: () => void;
  private shared?: string;
  private dataListener = (data: string): void => {
    for (const event of this.input.feed(data)) this.handle(event);
  };
  private resizeListener = (): void => this.repaint();
  private signalListener = (): void => {
    if (this.runtime?.harness.busy) void this.runtime.harness.cancel();
    else this.exit(0);
  };
  constructor(
    readonly workspace: string,
    readonly home: string,
    public settings: CircleSettings,
  ) {
    this.remap = loadRemap(home).remap;
    this.state = {
      messages: [],
      notices: [],
      welcome: [],
      draft: '',
      draftCursor: 0,
      model: settings.auth.model || '',
      workspace,
      version: VERSION,
      busy: false,
      waiting: false,
      planMode: false,
      autoMode: false,
      todos: [],
      showThinking: !settings.hide_thinking,
      showTools: false,
      streaming: '',
      thinking: '',
      usage: emptyUsage(),
      flash: '',
      started: Date.now(),
      scroll: 0,
      hiddenTurns: 0,
    };
    this.theme = new ThemeWatch(
      settings.theme,
      (text) => process.stdout.write(text),
      () => this.repaint(),
    );
    this.completion = new Promise((resolve) => {
      this.done = resolve;
    });
    try {
      this.history = readFileSync(join(home, 'history'), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      /* No history yet. */
    }
    this.historyIndex = this.history.length;
  }
  start(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', this.dataListener);
    process.stdout.on('resize', this.resizeListener);
    process.on('SIGINT', this.signalListener);
    process.stdout.write(
      '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h',
    );
    this.theme.start();
    this.animation = setInterval(() => {
      if (this.state.busy || this.state.waiting) this.repaint();
    }, 160);
    this.repaint();
  }
  private repaint(): void {
    if (this.ended) return;
    if (this.runtime) {
      this.state.messages = this.runtime.harness.messages;
      this.state.todos = this.runtime.todos;
      this.state.model = this.runtime.harness.model.model;
      this.state.planMode = this.runtime.harness.planMode;
      this.state.autoMode = this.runtime.policy.yoloEnabled(
        this.runtime.session.id,
      );
      this.state.busy = this.runtime.harness.busy;
      this.state.renderToolResult = (message) => {
        const renderer = this.runtime!.extensions.renderer(message.name || '');
        if (!renderer) return undefined;
        try {
          const rows = renderer({
            tool_name: message.name,
            tool_call_id: message.tool_call_id,
            status: message.status,
            output: message.content,
            content: message.content,
          });
          if (
            !Array.isArray(rows) ||
            !rows.every((row) => typeof row === 'string')
          )
            throw new Error('renderer must return text lines');
          return rows;
        } catch (error) {
          const note =
            '✖ Extension renderer failed: ' +
            (error instanceof Error ? error.message : String(error));
          if (!this.state.notices.includes(note)) this.state.notices.push(note);
          return undefined;
        }
      };
    }
    this.state.welcome = welcomeRows(process.stdout.columns || 80, {
      version: VERSION,
      model: this.state.model,
      endpoint: this.settings.auth.base_url
        ? new URL(this.settings.auth.base_url).hostname
        : '',
      workspace: this.workspace,
      branch: currentBranch(this.workspace),
      resources: [
        existsSync(join(this.workspace, 'AGENTS.md'))
          ? 'instructions  AGENTS.md'
          : '',
        this.runtime?.skills.length
          ? `skills        ${this.runtime.skills.length}`
          : '',
      ].filter(Boolean),
      recent:
        this.runtime?.store
          .list(this.workspace)
          .filter((session) => session.id !== this.runtime!.session.id)
          .slice(0, 3)
          .map((session) => session.title || session.id) ?? [],
    });
    const rows = renderScreen(
      this.state,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );
    this.screen.render(rows);
  }
  private flash(text: string): void {
    this.state.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.state.flash = '';
      this.repaint();
    }, 1800);
    this.repaint();
  }
  private notice(text: string): void {
    this.state.notices.push(text);
    this.repaint();
  }
  private fail(error: unknown): void {
    this.notice(
      '✖ ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  private setDraft(text: string): void {
    this.state.draft = text;
    this.state.draftCursor = Array.from(text).length;
  }
  async initialize(force = false): Promise<boolean> {
    if (force || !this.settings.initialized) {
      const url = await this.askText(
        'connect',
        'API base URL',
        this.settings.auth.base_url,
      );
      if (this.ended || !url) return false;
      const old = loadCredentials(this.home);
      const key = await this.askText(
        'connect',
        'API key',
        old[this.settings.auth.api_key_ref] || old.api_key || '',
        true,
      );
      if (this.ended || !key) return false;
      const result = await resolveEndpoint(url, key);
      const protocol = result.inferred
        ? await this.askChoice('protocol', 'Choose the API protocol', [
            'openai',
            'anthropic',
          ])
        : result.protocol;
      if (this.ended || !protocol) return false;
      const model = await this.askText(
        'model',
        result.models.length
          ? 'Model ID (' + result.models.slice(0, 5).join(', ') + ')'
          : 'Model ID',
        this.settings.auth.model,
      );
      if (this.ended || !model) return false;
      const auth = {
        ...defaultAuth(),
        protocol,
        base_url: normalizeBaseUrl(url, protocol),
        model,
      };
      const settings = withConnection(auth, this.home);
      saveCredentials({ api_key: key }, this.home);
      saveSettings(settings, this.home);
      this.settings = settings;
    }
    if (!isFolderTrusted(this.settings, this.workspace)) {
      const answer = await this.askChoice(
        'trust',
        `${this.workspace}\nThis folder can supply instructions, skills, commands and extensions. Extensions execute code.`,
        ['trust this folder', 'quit'],
      );
      if (answer !== 'trust this folder') return false;
      this.settings = trustFolder(this.settings, this.workspace);
      saveSettings(this.settings, this.home);
    }
    return !this.ended;
  }
  async attach(
    options: Omit<RuntimeOptions, 'approve' | 'question'>,
  ): Promise<void> {
    this.runtime = new AgentRuntime({
      ...options,
      settings: this.settings,
      approve: (call, signal) => this.approve(call, signal),
      question: async (args, signal) => {
        if (!Array.isArray(args.questions))
          throw new Error('invalid questions');
        const answers: string[] = [];
        for (const question of args.questions as {
          question: string;
          options?: { label: string; description?: string }[];
        }[]) {
          const choices = question.options?.map((option) => option.label) ?? [];
          answers.push(
            choices.length
              ? await this.askChoice(
                  'question',
                  question.question,
                  choices,
                  signal,
                )
              : await this.askText(
                  'question',
                  question.question,
                  '',
                  false,
                  signal,
                ),
          );
        }
        return JSON.stringify(answers);
      },
    });
    this.off = this.runtime.bus.subscribe((event) => {
      if (event.kind === 'run_start') {
        this.state.started = Date.now();
        this.state.hiddenTurns = 0;
        this.state.scroll = 0;
      } else if (event.kind === 'llm_start') {
        this.state.streaming = '';
        this.state.thinking = '';
      } else if (event.kind === 'llm_token') {
        if (event.payload.thinking)
          this.state.thinking += String(event.payload.text);
        else this.state.streaming += String(event.payload.text);
      } else if (event.kind === 'llm_end') {
        this.state.streaming = '';
        this.state.thinking = '';
        for (const key of Object.keys(
          this.state.usage,
        ) as (keyof typeof this.state.usage)[])
          this.state.usage[key] += event.usage?.[key] ?? 0;
      } else if (event.kind === 'run_error')
        this.state.notices.push('✖ ' + String(event.payload.message));
      else if (event.kind === 'info' && event.payload.model_notice) {
        const notice = event.payload.model_notice as {
          event: string;
          [key: string]: unknown;
        };
        if (notice.event === 'retry')
          this.flash(
            `Retry ${notice.attempt}/${notice.max} in ${(Number(notice.wait_ms) / 1000).toFixed(1)}s`,
          );
        else if (notice.event === 'param_dropped')
          this.notice(
            `Endpoint does not support ${notice.param}; continuing without it`,
          );
        else if (
          ['repeat_retry', 'stall_retry', 'missing_finish_retry'].includes(
            notice.event,
          )
        ) {
          this.state.streaming = '';
          this.state.thinking = '';
          this.flash('Retrying model request');
        } else if (notice.event === 'compacted')
          this.notice(`Compacted ${notice.messages} messages`);
        else if (notice.event === 'output_budget_exhausted')
          this.notice('✖ Model output budget exhausted before an answer');
        else if (notice.event === 'missing_finish' && notice.truncated)
          this.notice('Model response may be truncated');
        else if (notice.event === 'repetition_stopped')
          this.notice('Model output was repeating; stopped the stream');
      }
      this.repaint();
    });
    await this.runtime.initialize();
    this.repaint();
  }
  private askChoice(
    title: string,
    body: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dialog({ title, body, options, focus: 0 }, signal);
  }
  private askText(
    title: string,
    body: string,
    initial = '',
    masked = false,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dialog(
      { title, body, options: [], focus: 0, input: initial, masked },
      signal,
    );
  }
  private dialog(
    state: NonNullable<ScreenState['dialog']>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.pending)
      return Promise.reject(new Error('another question is waiting'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.state.dialog = state;
    this.state.waiting = true;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending = undefined;
        this.state.dialog = undefined;
        this.state.waiting = false;
        this.repaint();
        reject(signal?.reason || new Error('Interrupted'));
      };
      this.pending = {
        complete: (answer) => {
          signal?.removeEventListener('abort', abort);
          this.pending = undefined;
          this.state.dialog = undefined;
          this.state.waiting = false;
          this.repaint();
          resolve(answer);
        },
        abort,
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.repaint();
    });
  }
  private async approve(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const review = this.runtime!.policy.review(call.name, call.args);
    const choices = ['allow this call'];
    const decisions: ApprovalDecision[] = ['approve'];
    if (review.prefix.length && review.verdict === 'ASK') {
      choices.push(`allow "${review.prefix.join(' ')} …" for this session`);
      decisions.push('prefix');
    }
    if (review.pattern && review.verdict === 'ASK') {
      choices.push(`allow ${review.scope} for this session`);
      decisions.push('always');
    }
    choices.push('reject');
    decisions.push('reject');
    const answer = await this.askChoice(
      'approval',
      `${call.name}\n${JSON.stringify(call.args, null, 2)}`,
      choices,
      signal,
    );
    return decisions[choices.indexOf(answer)] || 'reject';
  }
  private handle(event: InputEvent): void {
    if (this.ended) return;
    this.theme.feed(event);
    if (event.type === 'color' || event.type === 'scheme') return;
    if (event.type === 'mouse') {
      if (event.action === 'wheel')
        this.state.scroll = Math.max(
          0,
          this.state.scroll + (event.button === 0 ? 3 : -3),
        );
      this.repaint();
      return;
    }
    if (event.type === 'switch') {
      if (this.runtime)
        void this.runtime.switchSession(event.id).then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
      return;
    }
    if (event.type === 'upload') {
      this.setDraft(this.state.draft + ' @' + event.filename);
      this.repaint();
      return;
    }
    if (event.type === 'paste') {
      if (this.state.dialog?.input !== undefined)
        this.state.dialog.input += event.text;
      else this.insert(event.text);
      this.repaint();
      return;
    }
    const key = this.remap[event.key] || event.key;
    const char = event.char;
    if (this.state.dialog) {
      const dialog = this.state.dialog;
      if (key === 'escape' || key === 'ctrl+c')
        this.pending?.complete(dialog.options.at(-1) || '');
      else if (dialog.input !== undefined) {
        if (key === 'enter') this.pending?.complete(dialog.input);
        else if (key === 'backspace')
          dialog.input = Array.from(dialog.input).slice(0, -1).join('');
        else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
          dialog.input += char;
      } else if (key === 'up' || key === 'down')
        dialog.focus =
          (dialog.focus + (key === 'up' ? -1 : 1) + dialog.options.length) %
          dialog.options.length;
      else if (key === 'enter')
        this.pending?.complete(dialog.options[dialog.focus] || '');
      else if (/^[1-9]$/.test(key) && dialog.options[Number(key) - 1])
        this.pending?.complete(dialog.options[Number(key) - 1]!);
      else if (key === 'y') this.pending?.complete(dialog.options[0] || '');
      else if (key === 'n') this.pending?.complete(dialog.options.at(-1) || '');
      this.repaint();
      return;
    }
    if (this.state.picker && !['ctrl+c', 'ctrl+d'].includes(key)) {
      this.state.picker.handle(key, char);
      this.repaint();
      return;
    }
    if (key === 'ctrl+d' && !this.state.draft) {
      this.exit(0);
      return;
    }
    if (key === 'ctrl+c') {
      if (this.runtime?.harness.busy) void this.runtime.harness.cancel();
      else this.setDraft('');
    } else if (key === 'escape') {
      if (this.runtime?.harness.busy) void this.runtime.harness.cancel();
      else if (
        !this.state.draft &&
        Date.now() - this.lastEscape < 600 &&
        this.settings.double_escape !== 'none'
      )
        void this.command(this.settings.double_escape, '');
      this.lastEscape = Date.now();
    } else if (key === 'ctrl+o') {
      this.state.showTools = !this.state.showTools;
      this.flash(this.state.showTools ? 'Tools expanded' : 'Tools folded');
    } else if (key === 'ctrl+t') {
      this.state.showThinking = !this.state.showThinking;
      this.flash(
        this.state.showThinking ? 'Thinking shown' : 'Thinking hidden',
      );
    } else if (key === 'ctrl+l')
      void this.command('models', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+g')
      void this.command('editor', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+x')
      void this.command('copy', '').catch((error) => this.fail(error));
    else if (
      key === 'ctrl+q' &&
      this.runtime?.harness.busy &&
      this.state.draft.trim()
    ) {
      this.runtime.harness.queue(this.state.draft, 'followUp');
      this.setDraft('');
      this.flash('Queued follow-up');
    } else if (key === 'shift+enter' || key === 'ctrl+j') this.insert('\n');
    else if (key === 'enter') {
      const message = this.state.draft.trim();
      if (message) {
        this.setDraft('');
        this.history.push(message);
        this.historyIndex = this.history.length;
        mkdirSync(this.home, { recursive: true });
        writeFileSync(
          join(this.home, 'history'),
          this.history.slice(-1000).join('\n') + '\n',
        );
        void this.submit(message).catch((error) => this.fail(error));
      }
    } else if (key === 'tab') this.completeDraft();
    else if (key === 'backspace') {
      const chars = Array.from(this.state.draft);
      if (this.state.draftCursor > 0) chars.splice(--this.state.draftCursor, 1);
      this.state.draft = chars.join('');
    } else if (key === 'delete' || key === 'ctrl+d') {
      const chars = Array.from(this.state.draft);
      chars.splice(this.state.draftCursor, 1);
      this.state.draft = chars.join('');
    } else if (key === 'left')
      this.state.draftCursor = Math.max(0, this.state.draftCursor - 1);
    else if (key === 'right')
      this.state.draftCursor = Math.min(
        Array.from(this.state.draft).length,
        this.state.draftCursor + 1,
      );
    else if (key === 'home' || key === 'ctrl+a') this.state.draftCursor = 0;
    else if (key === 'end' || key === 'ctrl+e')
      this.state.draftCursor = Array.from(this.state.draft).length;
    else if (key === 'up' || key === 'down') {
      if (this.historyIndex === this.history.length)
        this.draftBeforeHistory = this.state.draft;
      this.historyIndex = Math.max(
        0,
        Math.min(
          this.history.length,
          this.historyIndex + (key === 'up' ? -1 : 1),
        ),
      );
      this.setDraft(this.history[this.historyIndex] || this.draftBeforeHistory);
    } else if (key === 'pageup')
      this.state.scroll += Math.max(1, (process.stdout.rows || 24) - 8);
    else if (key === 'pagedown')
      this.state.scroll = Math.max(
        0,
        this.state.scroll - Math.max(1, (process.stdout.rows || 24) - 8),
      );
    else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
      this.insert(char);
    this.repaint();
  }
  private insert(text: string): void {
    const chars = Array.from(this.state.draft);
    chars.splice(this.state.draftCursor, 0, ...Array.from(text));
    this.state.draftCursor += Array.from(text).length;
    this.state.draft = chars.join('');
  }
  private completeDraft(): void {
    if (this.state.draft.startsWith('/') && !this.state.draft.includes(' ')) {
      const matches = BUILTIN_SLASH.filter((command) =>
        command.name.startsWith(this.state.draft.slice(1)),
      );
      if (matches[0]) this.setDraft('/' + matches[0].name + ' ');
    } else {
      const match = this.state.draft.match(/@([^\s]*)$/);
      if (match) {
        const matches = complete(match[1]!, this.workspace);
        if (matches[0])
          this.setDraft(
            this.state.draft.slice(0, match.index) + '@' + matches[0],
          );
      }
    }
  }
  async submit(message: string): Promise<void> {
    if (message === '?') {
      await this.command('hotkeys', '');
      return;
    }
    const slash = parseSlash(message);
    if (slash) {
      await this.command(slash.name, slash.args);
      return;
    }
    if (!this.runtime) return;
    if (this.runtime.harness.busy) {
      this.runtime.harness.queue(message);
      this.flash('Queued steering');
    } else {
      try {
        await this.runtime.harness.run(message);
      } catch {
        /* Run error is already displayed by the event bus. */
      }
      this.repaint();
    }
  }
  private picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
  ): void {
    this.state.picker = new Picker(
      title,
      items,
      (item) => {
        this.state.picker = undefined;
        Promise.resolve(choose(item)).then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
      },
      () => {
        this.state.picker = undefined;
        this.repaint();
      },
    );
    this.repaint();
  }
  async command(name: string, args: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    if (name === 'exit') {
      this.exit(0);
      return;
    }
    if (name === 'help') {
      this.notice(
        BUILTIN_SLASH.map(
          (command) => `/${command.name}  ${command.description}`,
        ).join('\n'),
      );
      return;
    }
    if (name === 'hotkeys') {
      this.notice(
        Object.entries(ACTIONS)
          .map(([action, key]) => `${key.padEnd(14)} ${action}`)
          .join('\n'),
      );
      return;
    }
    if (name === 'plan') {
      runtime.harness.planMode =
        args === 'on' || (args !== 'off' && !runtime.harness.planMode);
      this.notice(
        runtime.harness.planMode ? 'Read-only mode on' : 'Read-only mode off',
      );
      return;
    }
    if (name === 'yolo') {
      runtime.policy.setYolo(runtime.session.id, args !== 'off');
      this.notice(args === 'off' ? 'Auto mode off' : 'Auto mode on');
      return;
    }
    if (name === 'thinking' && !args) {
      this.state.showThinking = !this.state.showThinking;
      this.repaint();
      return;
    }
    if (name === 'details') {
      this.state.showTools = !this.state.showTools;
      this.repaint();
      return;
    }
    if (name === 'themes') {
      if (!args) {
        this.notice(`Theme: ${this.settings.theme}`);
        return;
      }
      if (!['auto', 'dark', 'light'].includes(args))
        throw new Error('use /themes auto|dark|light');
      this.settings.theme = args as CircleSettings['theme'];
      saveSettings(this.settings, this.home);
      this.theme.mode = this.settings.theme;
      this.theme.apply();
      this.repaint();
      return;
    }
    if (name === 'name') {
      runtime.store.rename(runtime.session.id, args);
      this.notice('Session renamed');
      return;
    }
    if (name === 'session') {
      const session = runtime.store.get(runtime.session.id)!;
      this.notice(
        `${session.id}\n${session.title}\n${this.workspace}\n${runtime.harness.model.model}\n${runtime.harness.messages.length} messages`,
      );
      return;
    }
    if (name === 'approvals') {
      if (args.startsWith('revoke '))
        runtime.policy.store.revoke(
          runtime.session.id,
          Number(args.slice(7)) - 1,
        );
      this.notice(
        runtime.policy.store
          .rules(runtime.session.id)
          .map((rule, index) => `${index + 1}. ${rule.tool}: ${rule.label}`)
          .join('\n') || 'No session rules',
      );
      return;
    }
    if (name === 'mcp' || name === 'extensions') {
      if (args === 'reload') {
        if (runtime.harness.busy) {
          this.flash(
            `reload ${name === 'mcp' ? 'MCP' : 'extensions'} after the current turn`,
          );
          return;
        }
        await runtime.reloadIntegrations();
      }
      this.notice(
        name === 'mcp' ? runtime.mcp.describe() : runtime.extensions.describe(),
      );
      return;
    }
    if (name === 'trust') {
      this.settings = trustFolder(this.settings, this.workspace);
      saveSettings(this.settings, this.home);
      this.notice('Folder trusted');
      return;
    }
    if (name === 'undo') {
      this.state.hiddenTurns = Math.min(40, this.state.hiddenTurns + 1);
      this.repaint();
      return;
    }
    if (name === 'redo') {
      this.state.hiddenTurns = Math.max(0, this.state.hiddenTurns - 1);
      this.repaint();
      return;
    }
    if (name === 'new') {
      this.previousSession = runtime.session.id;
      await runtime.newSession();
      this.state.notices = [];
      this.state.hiddenTurns = 0;
      this.state.usage = emptyUsage();
      this.repaint();
      return;
    }
    if (name === 'continue') {
      if (!this.previousSession) throw new Error('no previous session');
      const current = runtime.session.id;
      await runtime.switchSession(this.previousSession);
      this.previousSession = current;
      this.repaint();
      return;
    }
    if (name === 'resume') {
      const sessions = runtime.store.list(this.workspace);
      const choose = async (id: string): Promise<void> => {
        this.previousSession = runtime.session.id;
        await runtime.switchSession(id);
        this.state.hiddenTurns = 0;
        this.state.notices = [];
      };
      if (args)
        await choose(
          /^\d+$/.test(args) ? sessions[Number(args) - 1]?.id || '' : args,
        );
      else
        this.picker(
          'sessions',
          sessions.map((session) => ({
            key: session.id,
            label: session.title || session.id,
            meta: session.id,
            current: session.id === runtime.session.id,
          })),
          (item) => choose(item.key),
        );
      return;
    }
    if (name === 'tree' || name === 'fork') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      const tree = runtime.store.tree(runtime.session.id);
      const choices = tree
        .filter((checkpoint) => !checkpoint.message.internal)
        .filter(
          (checkpoint) => name !== 'fork' || checkpoint.message.role === 'user',
        )
        .filter(
          (checkpoint) =>
            !args ||
            checkpoint.message.content
              .toLowerCase()
              .includes(args.toLowerCase()),
        );
      this.picker(
        name,
        choices.map((checkpoint) => ({
          key: checkpoint.id,
          label: `${checkpoint.message.role}: ${checkpoint.message.display || checkpoint.message.content || '(tool call)'}`,
          current:
            checkpoint.id === runtime.store.get(runtime.session.id)?.head,
        })),
        async (item) => {
          const checkpoint = runtime.store.checkpoint(item.key)!;
          const head =
            checkpoint.message.role === 'user'
              ? checkpoint.parent
              : checkpoint.id;
          if (name === 'fork') {
            const session = runtime.store.fork(
              runtime.session.id,
              this.workspace,
              head,
            );
            await runtime.switchSession(session.id);
          } else runtime.store.select(runtime.session.id, head);
          if (checkpoint.message.role === 'user')
            this.setDraft(
              checkpoint.message.display || checkpoint.message.content,
            );
          this.state.notices = [];
          this.state.hiddenTurns = 0;
        },
      );
      return;
    }
    if (name === 'clone') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      const session = runtime.store.fork(runtime.session.id, this.workspace);
      await runtime.switchSession(session.id);
      this.repaint();
      return;
    }
    if (name === 'models') {
      const choose = (model: string): void => {
        if (runtime.harness.busy) throw new Error('a turn is running');
        runtime.setModel(model);
        this.notice(`Model → ${model}`);
      };
      if (args) choose(args);
      else {
        const credentials = loadCredentials(this.home);
        const result = await resolveEndpoint(
          this.settings.auth.base_url,
          credentials[this.settings.auth.api_key_ref] || '',
          { protocol: this.settings.auth.protocol },
        );
        if (result.status === 'failed') throw new Error(result.detail);
        this.picker(
          'models',
          result.models.map((model) => ({
            key: model,
            label: model,
            current: model === runtime.harness.model.model,
          })),
          (item) => choose(item.key),
        );
      }
      return;
    }
    if (name === 'effort' || name === 'thinking') {
      const choose = (effort: string): void => {
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort))
          throw new Error('unknown thinking depth');
        runtime.setThinkingLevel(effort);
        this.notice(`Thinking → ${effort}`);
      };
      if (args) choose(args);
      else
        this.picker(
          'thinking depth',
          EFFORT_LEVELS.map((level) => ({ key: level, label: level })),
          (item) => choose(item.key),
        );
      return;
    }
    if (name === 'skill' || name.startsWith('skill:')) {
      const value = name.startsWith('skill:')
        ? name.slice(6)
        : args.split(/\s+/)[0];
      if (!value)
        this.notice(
          runtime.skills
            .map((skill) => `${skill.name}  ${skill.description}`)
            .join('\n') || 'No skills found',
        );
      else
        await this.submit(loadSkillBody(value, runtime.skills) + '\n' + args);
      return;
    }
    if (name === 'compact') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      this.notice(await runtime.compact(args));
      return;
    }
    if (name === 'init') {
      await runtime.harness.run(
        'Read the repository and write an AGENTS.md contributor guide. ' + args,
      );
      return;
    }
    if (name === 'export' || name === 'share') {
      const kind = name === 'share' ? 'md' : exportKind(args);
      const directory = join(
        this.home,
        name === 'share' ? 'shares' : 'exports',
      );
      mkdirSync(directory, { recursive: true });
      const path =
        args && !['html', 'jsonl', 'md'].includes(args)
          ? resolve(this.workspace, args)
          : join(directory, runtime.session.id + '.' + kind);
      const session = runtime.store.get(runtime.session.id)!;
      const meta = {
        thread_id: session.id,
        title: session.title,
        workspace: session.workspace,
        model: runtime.harness.model.model,
      };
      const messages = runtime.harness.messages;
      writeFileSync(
        path,
        kind === 'html'
          ? toHtml(messages, meta)
          : kind === 'jsonl'
            ? toJsonl(messages, meta)
            : toMarkdown(messages, meta),
      );
      if (name === 'share') {
        this.shared = path;
        await this.copy(path);
      }
      this.notice(`Exported ${path}`);
      return;
    }
    if (name === 'unshare') {
      if (this.shared && existsSync(this.shared)) unlinkSync(this.shared);
      this.shared = undefined;
      this.notice('Local share removed');
      return;
    }
    if (name === 'import') {
      if (!args) throw new Error('use /import <path>');
      const text = readFileSync(resolve(this.workspace, args), 'utf8');
      if (args.endsWith('.jsonl')) await runtime.importSession(text);
      else {
        await runtime.newSession();
        runtime.store.append(runtime.session.id, [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: text.slice(0, 8000),
            display: text,
          },
        ]);
      }
      this.repaint();
      return;
    }
    if (name === 'copy') {
      await this.copy(
        runtime.harness.messages
          .filter((message) => message.role === 'assistant' && message.content)
          .at(-1)?.content || '',
      );
      this.flash('Copied answer');
      return;
    }
    if (name === 'editor') {
      await this.editor();
      return;
    }
    if (name === 'settings') {
      this.notice(JSON.stringify(this.settings, null, 2));
      return;
    }
    if (name === 'logout') {
      if (runtime.harness.busy) await runtime.harness.cancel();
      clearCredentials(this.home);
      this.settings.initialized = false;
      saveSettings(this.settings, this.home);
      this.exit(0);
      return;
    }
    if (name === 'login') {
      if (args === 'anthropic' || args === 'openai')
        throw new Error('OAuth sign-in is not available yet');
      if (runtime.harness.busy) throw new Error('a turn is running');
      if (await this.initialize(true)) {
        runtime.options.settings = this.settings;
        runtime.setModel(this.settings.auth.model);
      }
      return;
    }
    if (name === 'reload') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      await runtime.reloadIntegrations();
      this.settings = runtime.options.settings;
      runtime.setModel(this.settings.auth.model);
      this.notice('Settings and integrations reloaded');
      return;
    }
    const custom = discoverCustomCommands(this.workspace, this.home).find(
      (command) => command.name === name,
    );
    if (custom) {
      const prompt = await expandCommandTemplate(
        custom.template,
        args,
        runtime.sandbox,
        new AbortController().signal,
      );
      await this.submit(prompt);
      return;
    }
    const extensionCommand = runtime.extensions.commands().get(name);
    if (extensionCommand) {
      await extensionCommand.handler(args, {
        workspace: this.workspace,
        toast: (message) => this.notice(message),
        append: (message) => {
          runtime.store.append(runtime.session.id, [
            { id: crypto.randomUUID(), role: 'assistant', content: message },
          ]);
          this.repaint();
        },
        sendUserMessage: (message) => {
          void this.submit(message).catch((error) => this.fail(error));
        },
      });
      return;
    }
    throw new Error(`command not available: /${name}`);
  }
  private async copy(text: string): Promise<void> {
    const program =
      process.platform === 'darwin'
        ? 'pbcopy'
        : process.platform === 'win32'
          ? 'clip'
          : 'wl-copy';
    await new Promise<void>((resolveCopy) => {
      const child = spawn(program, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => {
        const path = join(this.home, 'exports', 'clipboard.txt');
        mkdirSync(join(this.home, 'exports'), { recursive: true });
        writeFileSync(path, text);
        resolveCopy();
      });
      child.once('close', () => resolveCopy());
      child.stdin.end(text);
    });
  }
  private async editor(): Promise<void> {
    const words = splitArguments(
      process.env.VISUAL ||
        process.env.EDITOR ||
        (process.platform === 'win32' ? 'notepad' : 'vi'),
    );
    const directory = mkdtempSync(join(tmpdir(), 'circle-editor-'));
    const path = join(directory, 'draft.md');
    writeFileSync(path, this.state.draft);
    process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    try {
      await new Promise<void>((resolveEditor, reject) => {
        const child = spawn(words[0]!, [...words.slice(1), path], {
          stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0
            ? resolveEditor()
            : reject(new Error(`editor exited ${code}`)),
        );
      });
      this.setDraft(readFileSync(path, 'utf8'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.stdin.setRawMode(true);
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      this.repaint();
    }
  }
  exit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.pending?.abort?.();
    this.done(code);
  }
  async wait(): Promise<number> {
    return this.completion;
  }
  async close(): Promise<void> {
    this.ended = true;
    this.off?.();
    this.input.close();
    this.theme.close();
    if (this.animation) clearInterval(this.animation);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    process.stdin.off('data', this.dataListener);
    process.stdout.off('resize', this.resizeListener);
    process.off('SIGINT', this.signalListener);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(
      '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l',
    );
    await this.runtime?.close();
  }
}
export async function runTui(
  options: Omit<RuntimeOptions, 'approve' | 'question'> & {
    init?: boolean;
    pickSession?: boolean;
    prompts?: string[];
  },
): Promise<number> {
  const app = new SessionApp(options.workspace, options.home, options.settings);
  app.start();
  try {
    if (!(await app.initialize(options.init))) return 0;
    await app.attach(options);
    if (options.pickSession) await app.command('resume', '');
    for (const prompt of options.prompts ?? []) void app.submit(prompt);
    return await app.wait();
  } finally {
    await app.close();
  }
}
