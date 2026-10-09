// The slash commands of the full-screen interface, as the Python releases had them (up to
// 0.5.0). SessionApp keeps /models, /login, /reload and /editor, which use its own state, and
// routes every command through runCommand.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { AgentRuntime } from '../runtime.js';
import {
  clearCredentials,
  defaultAuth,
  isFolderTrusted,
  loadSettings,
  saveSettingsChange,
  type CircleSettings,
} from '../settings.js';
import type { PickerItem, PickerOptions } from '../ink/components/picker.js';
import { palette } from '../ink/theme.js';
import { stripAnsi } from '../ink/string_width.js';
import { transcriptRows, type ScreenState } from './render.js';
import { elapsed, type Job } from '../jobs.js';
import { emptyUsage } from '../types.js';
import { EFFORT_LEVELS } from '../model.js';
import { exportKind, toHtml } from '../session_export.js';
import { discoverCustomCommands, expandCommandTemplate } from '../commands.js';
import { discoverSkills, loadSkillBody } from '../skills.js';
import { readPrompt } from '../system_prompt.js';
import { helpText, hotkeysText } from './slash_commands.js';
import type { ScreenSnapshot, UndoHistory } from './undo_history.js';

export interface CommandHost {
  readonly runtime: AgentRuntime;
  readonly home: string;
  readonly workspace: string;
  settings: CircleSettings;
  readonly state: ScreenState;
  readonly undo: UndoHistory;
  // The local share copy /share wrote, which /unshare deletes.
  shared?: string;
  previousSession: string;
  notice(text: string): void;
  flash(text: string, ttl?: number): void;
  fail(error: unknown): void;
  repaint(): void;
  picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
    options?: PickerOptions,
  ): void;
  closePicker(): void;
  askChoice(title: string, body: string, options: string[]): Promise<string>;
  askText(title: string, body: string, initial?: string): Promise<string>;
  // The box's text, with the long pastes its placeholders stand for.
  setDraft(text: string, pastes?: Record<string, string>): void;
  // A finished job does not start a turn of its own until you send something.
  snoozeJobs(): void;
  // A message for the model, never read as a command.
  send(text: string): Promise<void>;
  command(name: string, args: string): Promise<void>;
  setTheme(mode: CircleSettings['theme']): void;
  trustWorkspace(): void;
  clipboard(text: string): Promise<boolean>;
}
type Handler = (host: CommandHost, args: string) => Promise<void> | void;

// What may run while a turn is running; the rest wait for it to end.
const BUSY_OK = new Set([
  'yolo',
  'approvals',
  'settings',
  'session',
  'themes',
  'mcp',
  'copy',
  'export',
  'share',
  'unshare',
  'thinking',
  'details',
  'name',
  'tree',
  'jobs',
]);
const BUSY_WORDS: Record<string, string> = {
  models: 'Busy · switch models when the turn has finished',
  effort: 'Busy · change the thinking depth when the turn has finished',
  resume: 'Busy · switch sessions when the turn has finished',
};
const THEMES = ['auto', 'dark', 'light'] as const;
const DOUBLE_ESCAPE = ['tree', 'fork', 'none'] as const;
const DEPTH_NOTES: Record<string, string> = {
  minimal: '~1k tokens',
  low: '~2k',
  medium: '~8k',
  high: '~16k',
  xhigh: '~32k',
  max: 'as much as the model allows',
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export function shortPath(path: string): string {
  const home = homedir();
  return path === home ||
    path.startsWith(home + '/') ||
    path.startsWith(home + '\\')
    ? '~' + path.slice(home.length)
    : path;
}
// `…/code/app`: the end of a path, which is what tells folders apart.
// `https://gateway.example/v1` as `gateway.example/v1`: short enough for a list.
export function endpointName(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
}
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/');
}
// `3m`, `5h`, `2d`: how long ago, for lists.
export function sessionAge(updated: number, now = Date.now()): string {
  const gone = Math.max(0, (now - updated) / 1000);
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const)
    if (gone >= size) return `${Math.floor(gone / size)}${unit}`;
  return 'now';
}
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? join(homedir(), path.slice(1))
    : path;
}
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
// The time in UTC as the Python releases wrote it into export names: 20261009-142501.
function stamp(now = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-` +
    `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`
  );
}
function sessionTitle(host: CommandHost): string {
  return host.runtime.store.get(host.runtime.session.id)?.title || 'new';
}

// Help, hotkeys and exit first; then custom commands, which may replace a built-in one and
// are queued like any message; then the turn check, then extension commands. Returns false
// for a built-in command that is not handled here.
export async function runCommand(
  host: CommandHost,
  name: string,
  args: string,
  exit: () => void,
): Promise<boolean> {
  if (name === 'exit') {
    exit();
    return true;
  }
  if (name === 'help' || name === 'hotkeys') {
    HANDLERS[name]!(host, args);
    return true;
  }
  const runtime = host.runtime;
  const custom = discoverCustomCommands(host.workspace, host.home).find(
    (command) => command.name === name,
  );
  if (custom) {
    const prompt = await expandCommandTemplate(
      custom.template,
      args,
      runtime.sandbox,
      new AbortController().signal,
    );
    await host.send(prompt);
    return true;
  }
  if (!BUSY_OK.has(name) && runtime.busy) {
    host.flash(
      BUSY_WORDS[name] ?? 'Busy · wait for the current turn to finish',
    );
    return true;
  }
  const extension = runtime.extensions.commands().get(name);
  if (extension) {
    try {
      await extension.handler(args, {
        workspace: host.workspace,
        toast: (message) => host.notice(message),
        // A line on screen; the model does not see it.
        append: (message) => host.notice(message),
        sendUserMessage: (message) => {
          void host.send(message).catch((error) => host.fail(error));
        },
      });
    } catch (error) {
      host.fail(`/${name} failed: ${reason(error)}`);
    }
    return true;
  }
  const handler = HANDLERS[name];
  if (!handler) return false;
  try {
    await handler(host, args);
  } catch (error) {
    host.fail(`/${name} failed: ${reason(error)}`);
  }
  return true;
}

function help(host: CommandHost): void {
  const custom: [string, string][] = discoverCustomCommands(
    host.workspace,
    host.home,
  ).map((command) => [
    `${command.name} ${command.argument_hint}`.trim(),
    command.description,
  ]);
  for (const command of host.runtime.extensions.commands().values())
    custom.push([command.name, command.description]);
  host.notice(helpText(custom));
}

function plan(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const token = args.trim().toLowerCase();
  let want: boolean;
  if (['on', '1', 'true', 'enable'].includes(token)) want = true;
  else if (['off', '0', 'false', 'disable'].includes(token)) want = false;
  else if (!token) want = !runtime.harness.planMode;
  else {
    host.flash('Usage: /plan [on|off]');
    return;
  }
  if (want === runtime.harness.planMode) {
    host.flash(`Read-only is already ${want ? 'on' : 'off'}`);
    return;
  }
  runtime.setPlanMode(want);
  host.notice(
    want
      ? 'Read-only on · writes and shell are blocked, /plan.md is allowed'
      : 'Read-only off',
  );
}

function yolo(host: CommandHost, args: string): void {
  const enabled = !['off', '0', 'false', 'no'].includes(
    args.trim().toLowerCase(),
  );
  host.runtime.policy.setYolo(host.runtime.session.id, enabled);
  host.notice(
    enabled
      ? 'Auto on · tool calls run without asking'
      : 'Auto off · asking for each call again',
  );
}

function thinking(host: CommandHost, args: string): void {
  if (args.trim()) {
    effort(host, args);
    return;
  }
  host.state.showThinking = !host.state.showThinking;
  host.flash(`Thinking ${host.state.showThinking ? 'shown' : 'hidden'}`, 1200);
}

function details(host: CommandHost): void {
  host.state.showTools = !host.state.showTools;
  host.flash(
    `Tool output ${host.state.showTools ? 'expanded' : 'collapsed'}`,
    1200,
  );
}

function themes(host: CommandHost, args: string): void {
  let name = args.trim().toLowerCase();
  if (name === 'terminal') name = 'auto'; // the old name of auto
  const available = THEMES.join(', ');
  if (!name) {
    host.notice(`Theme: ${host.settings.theme} · available: ${available}`);
    return;
  }
  if (!(THEMES as readonly string[]).includes(name)) {
    host.fail(`Unknown theme '${name}' · available: ${available}`);
    return;
  }
  const theme = name as CircleSettings['theme'];
  host.settings.theme = theme;
  saveSettingsChange(host.home, (saved) => {
    saved.theme = theme;
  });
  host.setTheme(theme);
  host.notice(
    theme === 'auto'
      ? `Theme → auto (${palette().is_dark ? 'dark' : 'light'})`
      : `Theme → ${theme}`,
  );
}

function name(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const title = args.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!title) {
    host.notice(`Session name: ${sessionTitle(host)}`);
    host.flash('/name <title> renames it', 4000);
    return;
  }
  runtime.store.rename(runtime.session.id, title);
  host.notice(`Session name → ${title}`);
}

function session(host: CommandHost): void {
  const runtime = host.runtime;
  const messages = runtime.harness.messages;
  const mine = messages.filter(
    (message) => message.role === 'user' && !message.internal,
  ).length;
  const answers = messages.filter((message) => message.role === 'assistant');
  const calls = answers.reduce(
    (sum, message) => sum + (message.tool_calls?.length ?? 0),
    0,
  );
  const results = messages.filter((message) => message.role === 'tool').length;
  const depth = runtime.thinkingLevel;
  const model =
    runtime.harness.model.model +
    ((EFFORT_LEVELS as readonly string[]).includes(depth) ? ` • ${depth}` : '');
  const kept = runtime.runOptions.no_session
    ? 'in memory only (--no-session)'
    : shortPath(join(host.home, 'circle.sqlite'));
  const used = host.state.usage;
  const cached =
    used.input_tokens && used.cache_read_tokens
      ? ` · ${Math.round((used.cache_read_tokens / used.input_tokens) * 100)}% cached`
      : '';
  const title = runtime.store.get(runtime.session.id)?.title;
  const rows = [
    `session  ${runtime.session.id}${title ? ` · ${title}` : ''}`,
    `folder   ${shortPath(host.workspace)}`,
    `model    ${model}`,
    `kept     ${kept}`,
    `messages ${messages.length} · ${mine} yours · ${answers.length} from the model · ` +
      `${calls} tool calls · ${results} results`,
    `tokens   ↑ ${used.input_tokens.toLocaleString('en-US')}${cached} · ` +
      `↓ ${used.output_tokens.toLocaleString('en-US')} in this run`,
  ];
  if (host.shared) rows.push(`shared   ${host.shared}`);
  host.notice(rows.join('\n'));
}

const APPROVAL_WORDS: Record<string, string> = {
  once: 'allowed once',
  always: 'allowed for session',
  reject: 'rejected',
  revoke: 'revoked',
};
function approvals(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const store = runtime.policy.store;
  const thread = runtime.session.id;
  const parts = args.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    approvalsList(host);
    return;
  }
  if (parts[0] === 'revoke') {
    if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) {
      host.flash('Usage: /approvals revoke <number>');
      return;
    }
    const rule = store.revoke(thread, Number(parts[1]) - 1);
    if (!rule) {
      host.flash(`No rule number ${parts[1]}`);
      return;
    }
    host.notice(`Revoked · ${rule.tool} · ${rule.label}`);
  }
  const rules = store.rules(thread);
  const lines = [
    rules.length
      ? 'Always-allow rules this session:'
      : 'No always-allow rules this session.',
    ...rules.map(
      (rule, index) =>
        `  ${index + 1}. ${rule.tool} · ${rule.label || rule.pattern}`,
    ),
  ];
  const recent = store.log(thread).slice(-5);
  if (recent.length)
    lines.push(
      'Recent approvals:',
      ...recent.map(
        (entry) =>
          `  ${APPROVAL_WORDS[entry.kind] ?? entry.kind} · ${entry.tool}`,
      ),
    );
  if (rules.length) lines.push('Revoke one: /approvals revoke <number>');
  host.notice(lines.join('\n'));
}
// /approvals with nothing after it: the rules as a list; enter on one revokes it.
function approvalsList(host: CommandHost): void {
  const runtime = host.runtime;
  const store = runtime.policy.store;
  const thread = runtime.session.id;
  const rules = store.rules(thread);
  const recent = store.log(thread).slice(-5);
  const items: PickerItem[] = rules.map((rule, index) => {
    const label = rule.label || rule.pattern;
    return {
      key: `revoke:${index}`,
      label: `${index + 1}. Revoke: ${label.slice(0, 40)}`,
      meta: `always · ${rule.tool}`,
    };
  });
  items.push({ key: 'close', label: `${items.length + 1}. Close` });
  const choose = (item: PickerItem): void => {
    if (!item.key.startsWith('revoke:')) return;
    const rule = store.revoke(thread, Number(item.key.slice(7)));
    if (rule)
      host.notice(
        `Revoked · ${rule.tool} · ${rule.label || rule.pattern} · the next call like it will ask again`,
      );
  };
  const move = (step: number) => (): void => {
    const picker = host.state.picker;
    const shown = picker?.matches().length ?? 0;
    if (picker && shown) picker.focus = (picker.focus + step + shown) % shown;
  };
  const keys: PickerOptions['keys'] = { j: move(1), k: move(-1) };
  items.slice(0, 9).forEach((item, index) => {
    keys[String(index + 1)] = () => {
      host.closePicker();
      choose(item);
    };
  });
  host.picker('Session approvals', items, choose, {
    hint: [
      rules.length ? '' : 'No always-allow rules this session.',
      recent.length
        ? 'recent: ' +
          recent
            .map(
              (entry) =>
                `${APPROVAL_WORDS[entry.kind] ?? entry.kind} ${entry.tool}`,
            )
            .join(' · ')
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    keys,
  });
}

async function mcp(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  if (['reload', 'refresh', 'connect'].includes(args.trim().toLowerCase())) {
    if (runtime.busy) {
      host.flash('Busy · reload MCP after the current turn');
      return;
    }
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      host.fail(`MCP reload failed: ${reason(error)}`);
      return;
    }
    host.notice(`MCP reloaded · ${runtime.mcp.tools.length} tools`);
    return;
  }
  host.notice(runtime.mcp.describe());
}

async function extensions(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  if (['reload', 'refresh'].includes(args.trim().toLowerCase())) {
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      host.fail(`Extension reload failed: ${reason(error)}`);
      return;
    }
    host.notice(
      `Extensions reloaded · ${runtime.extensions.tools().length} tools`,
    );
  }
  host.notice(runtime.extensions.describe());
}

function trust(host: CommandHost): void {
  if (!isFolderTrusted(host.settings, host.workspace)) host.trustWorkspace();
  host.notice(`Trusted ${host.workspace}`);
}

function current(host: CommandHost): ScreenSnapshot {
  return host.undo.snapshot(
    host.runtime.session.id,
    host.runtime.harness.messages,
    host.state.notices,
  );
}
async function showSnapshot(
  host: CommandHost,
  snapshot: ScreenSnapshot,
): Promise<void> {
  const runtime = host.runtime;
  if (snapshot.sessionId !== runtime.session.id) {
    host.previousSession = runtime.session.id;
    await runtime.switchSession(snapshot.sessionId);
  }
  host.undo.restore(snapshot, runtime.harness.messages);
  host.state.notices = [...snapshot.notices];
}
// The screen as it was before the last turn. Only the screen: the model still has the turn.
async function undo(host: CommandHost): Promise<void> {
  const previous = host.undo.undo(current(host));
  if (!previous) {
    host.flash('Nothing to undo');
    return;
  }
  await showSnapshot(host, previous);
  host.notice('Undid the last turn');
}
async function redo(host: CommandHost): Promise<void> {
  const next = host.undo.redo(current(host));
  if (!next) {
    host.flash('Nothing to redo');
    return;
  }
  await showSnapshot(host, next);
  host.notice('Redid the turn');
}

async function init(host: CommandHost, args: string): Promise<void> {
  let template: string;
  try {
    template = readPrompt('commands', 'initialize.md');
  } catch {
    host.fail('Missing prompts/commands/initialize.md');
    return;
  }
  await host.send(template.replaceAll('$ARGUMENTS', args.trim() || '(none)'));
}

// The conversation as Markdown, as it is on screen, under a few lines that say what it is.
function screenMarkdown(host: CommandHost): string {
  const runtime = host.runtime;
  const rows = transcriptRows(
    {
      ...host.state,
      messages: host.undo.visible(runtime.harness.messages),
      welcome: [],
      streaming: '',
      thinking: '',
    },
    process.stdout.columns || 80,
  ).map((row) => stripAnsi(row).trimEnd());
  return (
    [
      `# Circle session \`${runtime.session.id}\``,
      '',
      `- workspace: \`${host.workspace}\``,
      `- model: \`${runtime.harness.model.model}\``,
      `- title: \`${sessionTitle(host)}\``,
      `- exported: \`${stamp()}\``,
      '',
      '---',
      '',
      ...rows,
    ].join('\n') + '\n'
  );
}
function write(host: CommandHost, path: string, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return true;
  } catch (error) {
    host.fail(`Could not write ${path}: ${reason(error)}`);
    return false;
  }
}
// /export [html|jsonl|md|path]: Markdown of the screen by default, HTML to read in a
// browser, JSONL with every message for /import.
function exportSession(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const raw = args.trim();
  const kind = raw ? exportKind(raw) : 'md';
  const path =
    raw && raw.toLowerCase() !== kind
      ? resolve(host.workspace, expandHome(raw))
      : join(
          host.home,
          'exports',
          `circle-${runtime.session.id}-${stamp()}.${kind}`,
        );
  let text: string;
  if (kind === 'md') text = screenMarkdown(host);
  else {
    const messages = runtime.harness.messages;
    if (!messages.length) {
      host.flash('Nothing to export yet');
      return;
    }
    text =
      kind === 'html'
        ? toHtml(messages, {
            thread_id: runtime.session.id,
            title: runtime.store.get(runtime.session.id)?.title ?? '',
            workspace: host.workspace,
            model: runtime.harness.model.model,
          })
        : runtime.exportSession();
  }
  if (write(host, path, text)) host.notice(`Exported ${path}`);
}

async function share(host: CommandHost): Promise<void> {
  const path = join(host.home, 'shares', `${host.runtime.session.id}.md`);
  if (!write(host, path, screenMarkdown(host))) return;
  host.shared = path;
  const copied = await host.clipboard(path);
  host.notice(`Local share copy: ${path}${copied ? ' · path copied' : ''}`);
}

function unshare(host: CommandHost): void {
  let path = host.shared;
  if (!path) {
    const candidate = join(
      host.home,
      'shares',
      `${host.runtime.session.id}.md`,
    );
    path = isFile(candidate) ? candidate : undefined;
  }
  if (!path || !isFile(path)) {
    host.flash('No active share file');
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    host.fail(`Delete failed: ${reason(error)}`);
    return;
  }
  host.shared = undefined;
  host.notice(`Unshared ${path}`);
}

async function importSession(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  const raw = args.trim();
  if (!raw) {
    host.flash('Usage: /import <file.jsonl or file.md>');
    return;
  }
  let path = resolve(host.workspace, expandHome(raw));
  if (!isFile(path)) {
    const saved = join(host.home, 'exports', raw);
    if (isFile(saved)) path = saved;
  }
  if (!isFile(path)) {
    host.fail(`No such file: ${raw}`);
    return;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    host.fail(
      error instanceof TypeError
        ? `${basename(path)} is not a text file`
        : `Could not read ${path}: ${reason(error)}`,
    );
    return;
  }
  const previous = runtime.session.id;
  if (extname(path).toLowerCase() === '.jsonl') {
    try {
      await runtime.importSession(text);
    } catch (error) {
      host.fail(
        `${basename(path)} is not a Circle JSONL export: ${reason(error)}`,
      );
      return;
    }
    host.previousSession = previous;
    host.undo.showAll();
    host.state.notices = [];
    host.notice(`Imported ${path} → ${runtime.session.id}`);
    return;
  }
  // Any other file: its text on screen, and the start of it for the model.
  host.undo.push(current(host));
  await runtime.newSession();
  host.previousSession = previous;
  runtime.store.rename(
    runtime.session.id,
    basename(path, extname(path)).slice(0, 60),
  );
  runtime.store.append(runtime.session.id, [
    {
      id: randomUUID(),
      role: 'user',
      content:
        'Imported prior transcript for continuity.\n' + text.slice(0, 8000),
      display: text,
    },
  ]);
  host.undo.showAll();
  host.state.notices = [];
  host.notice(`Imported ${path}`);
}

async function copy(host: CommandHost): Promise<void> {
  let text = (
    host.undo
      .visible(host.runtime.harness.messages)
      .filter((message) => message.role === 'assistant' && message.content)
      .at(-1)?.content ?? ''
  ).trim();
  // no answer yet: the last line of the transcript that is not yours, as 0.5.0 did
  if (!text)
    text =
      transcriptRows(
        { ...host.state, welcome: [] },
        process.stdout.columns || 80,
      )
        .map((row) => stripAnsi(row).trim())
        .findLast(
          (row) => row && !row.startsWith('>') && !row.startsWith('›'),
        ) ?? '';
  if (!text) {
    host.flash('No assistant message to copy');
    return;
  }
  if (await host.clipboard(text)) {
    host.flash(`Copied ${Array.from(text).length} chars`);
    return;
  }
  const path = join(host.home, 'exports', 'last-copy.txt');
  if (write(host, path, text + '\n'))
    host.notice(`No clipboard tool · wrote ${path}`);
}

// A list of the settings, as pi's /settings: enter changes the marked one, and the change is
// saved at once, that key alone. Rows that open their own list say so.
function settingsList(host: CommandHost, focusKey?: string): void {
  const runtime = host.runtime;
  const following = <T extends string>(options: readonly T[], value: T): T =>
    options[(options.indexOf(value) + 1) % options.length] ?? options[0]!;
  const auth = host.settings.auth;
  const items: PickerItem[] = [
    { key: 'theme', label: 'theme', meta: host.settings.theme },
    {
      key: 'thinking',
      label: 'show thinking',
      meta: host.state.showThinking ? 'on' : 'off',
    },
    {
      key: 'double_escape',
      label: 'esc esc opens',
      meta: host.settings.double_escape,
    },
    {
      key: 'model',
      label: 'model',
      meta: `${runtime.harness.model.model} · /models`,
    },
    {
      key: 'depth',
      label: 'thinking depth',
      meta: `${runtime.thinkingLevel || 'default'} · /effort`,
    },
    {
      key: 'endpoint',
      label: 'endpoint',
      meta: `${auth.protocol} · ${auth.base_url || '—'}`,
    },
    {
      key: 'trusted',
      label: 'trusted folders',
      meta: String(host.settings.trusted_folders.length),
    },
    {
      key: 'mcp',
      label: 'mcp servers',
      meta: `${host.settings.mcp_servers.length} · /mcp`,
    },
    { key: 'home', label: 'data folder', meta: shortPath(host.home) },
  ];
  const change = async (item: PickerItem): Promise<void> => {
    const opens: Record<string, [string, string]> = {
      model: ['models', ''],
      depth: ['effort', ''],
      mcp: ['mcp', ''],
      endpoint: ['login', ''],
    };
    if (opens[item.key]) {
      await host.command(...opens[item.key]!);
      return;
    }
    if (item.key === 'theme')
      themes(host, following(THEMES, host.settings.theme));
    else if (item.key === 'thinking') {
      const show = !host.state.showThinking;
      host.state.showThinking = show;
      host.settings.hide_thinking = !show;
      saveSettingsChange(host.home, (saved) => {
        saved.hide_thinking = !show;
      });
    } else if (item.key === 'double_escape') {
      const next = following(DOUBLE_ESCAPE, host.settings.double_escape);
      host.settings.double_escape = next;
      saveSettingsChange(host.home, (saved) => {
        saved.double_escape = next;
      });
    }
    // The list stays open on the row, showing the new value.
    settingsList(host, item.key);
  };
  host.picker('Settings', items, change, {
    hint: 'enter changes it, saved at once · esc closes',
    focusKey,
  });
}

function setThinking(host: CommandHost, level: string, saved = false): void {
  host.runtime.setThinkingLevel(level);
  const shown = host.runtime.thinkingLevel || level;
  host.flash(
    `Thinking depth → ${shown}` +
      (shown === level
        ? ''
        : ` (the closest this model supports to ${level})`) +
      (saved ? ' · saved as the default' : ''),
    3000,
  );
}
// shift+tab: the next depth, for this session.
export function cycleThinking(host: CommandHost): void {
  if (host.runtime.busy) {
    host.flash(BUSY_WORDS.effort!);
    return;
  }
  const levels = EFFORT_LEVELS as readonly string[];
  const at = levels.indexOf(host.runtime.thinkingLevel);
  setThinking(host, levels[(at + 1) % levels.length]!);
}
function effort(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const level = args.trim().toLowerCase();
  if (level) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      host.fail(
        `Unknown depth '${level}' · choose ${EFFORT_LEVELS.join(', ')}`,
      );
      return;
    }
    setThinking(host, level);
    host.notice(`Thinking depth → ${runtime.thinkingLevel || level}`);
    return;
  }
  const now = runtime.thinkingLevel;
  let saved = '';
  try {
    saved = loadSettings(host.home).default_thinking;
  } catch {
    /* An unreadable settings.json marks no default. */
  }
  host.picker(
    'Thinking depth',
    EFFORT_LEVELS.map((level) => ({
      key: level,
      label: level,
      current: level === now,
      meta: [DEPTH_NOTES[level] ?? '', level === saved ? 'default' : '']
        .filter(Boolean)
        .join(' · '),
    })),
    (item) => setThinking(host, item.key),
    {
      hint: 'enter uses it in this session · ctrl+s also makes it the default · shift+tab cycles',
      focusKey: now || undefined,
      keys: {
        'ctrl+s': (item) => {
          if (!item) return;
          host.closePicker();
          saveSettingsChange(host.home, (file) => {
            file.default_thinking = item.key;
          });
          setThinking(host, item.key, true);
        },
      },
    },
  );
}

function logout(host: CommandHost): void {
  clearCredentials(host.home);
  host.settings.auth = defaultAuth();
  host.settings.initialized = false;
  saveSettingsChange(host.home, (saved) => {
    saved.auth = defaultAuth();
    saved.initialized = false;
  });
  host.notice(
    'Signed out · credentials cleared · /login or `circle --init` before the next turn',
  );
}

// `done`, `failed · exit 1`, `failed · timeout`, `stopped`.
function outcome(job: Job): string {
  if (job.status === 'done') return 'done';
  if (job.status === 'failed')
    return job.reason && job.reason !== 'exit'
      ? `failed · ${job.reason}`
      : job.exitCode !== undefined
        ? `failed · exit ${job.exitCode}`
        : 'failed';
  return job.status || 'ended';
}
// /jobs: every background job, running ones first; enter opens one's page, ctrl+d stops a
// running one (after asking) or removes one that has ended.
function jobs(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  if (args.trim()) {
    const job = runtime.jobs.get(args.trim());
    if (!job) {
      host.fail(`No job ${args.trim()} · /jobs lists them`);
      return;
    }
    host.state.jobDetail = job;
    host.repaint();
    return;
  }
  const rows = (): PickerItem[] => {
    const all = runtime.jobs.list();
    const running = all.filter((job) => job.status === 'running');
    const ended = all.filter((job) => job.status !== 'running').reverse();
    return [...running, ...ended].map((job) => ({
      key: job.id,
      label: `${job.id} ${job.title}`,
      meta:
        (job.status === 'running'
          ? job.detail === 'waiting for you'
            ? 'waiting for you'
            : `running · ${elapsed(job)}`
          : `${outcome(job)} · ${elapsed(job)}`) +
        (job.sessionId !== runtime.session.id ? ' · other session' : ''),
      search: `${job.kind} ${job.source ?? ''}`,
    }));
  };
  const stop = async (item: PickerItem | undefined): Promise<void> => {
    const job = item ? runtime.jobs.get(item.key) : undefined;
    if (!job) return;
    if (job.status === 'running') {
      const answer = await host.askChoice(
        `stop ${job.id}`,
        `Stop ${job.id} ${job.title.slice(0, 40)}?`,
        ['stop job', 'keep running'],
      );
      if (answer === 'stop job') await runtime.jobs.stop(job.id, 'user');
    } else runtime.jobs.remove(job.id);
    host.state.picker?.setItems(rows());
  };
  host.picker(
    'Background jobs',
    rows(),
    (item) => {
      host.state.jobDetail = runtime.jobs.get(item.key);
    },
    {
      hint: 'enter opens · ctrl+d stops',
      empty: 'No jobs',
      keys: { 'ctrl+d': stop },
    },
  );
}

function skill(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const skills = discoverSkills(host.workspace, host.home);
  const token = args.trim();
  if (!token) {
    host.notice(
      skills.length
        ? [
            'Skills:',
            '',
            ...skills.map(
              (skill) =>
                `  ${skill.name.padEnd(20)} ${skill.description.slice(0, 80)}${skill.source_label ? ` (${skill.source_label})` : ''}`,
            ),
            '',
            'Load with /skill <name>',
          ].join('\n')
        : 'No skills found. Install with `npx skills add … -a amp` (writes .agents/skills), or add SKILL.md under ~/.circle/skills / .agent/skills.',
    );
    return;
  }
  const name = token.split(/\s/, 1)[0]!;
  const skillArgs = token.slice(name.length).trim();
  let body: string;
  try {
    body = loadSkillBody(name, skills);
  } catch (error) {
    host.fail(`Error: ${reason(error)}`);
    return;
  }
  // Into the conversation without a turn: the model reads it with your next message.
  runtime.store.append(runtime.session.id, [
    {
      id: randomUUID(),
      role: 'user',
      internal: 'skill',
      content:
        `[Circle system] Skill \`${name}\` loaded via /skill.` +
        (skillArgs ? `\nUser arguments: ${skillArgs}\n` : '\n') +
        `Follow it for subsequent requests until the user says otherwise.\n\n${body}`,
    },
  ]);
  host.notice(
    `Loaded skill \`${name}\`` + (skillArgs ? ` args='${skillArgs}'` : ''),
  );
}

async function compact(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  if (runtime.harness.messages.length < 2) {
    host.flash('Nothing to compact yet');
    return;
  }
  let result: string;
  try {
    result = await runtime.compact(args.trim());
  } catch (error) {
    host.fail(`Compact failed: ${reason(error)}`);
    return;
  }
  if (result === 'Nothing to compact yet')
    host.flash(
      'Nothing to compact yet · the conversation fits in the context',
      4000,
    );
  host.repaint();
}

// The screen is drawn again from the saved messages of the session now open.
function redrawn(host: CommandHost, note: string): void {
  host.undo.showAll();
  host.state.notices = [];
  host.notice(note);
}
async function newSession(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  host.previousSession = runtime.session.id;
  await runtime.newSession();
  host.state.usage = emptyUsage();
  redrawn(host, `New session ${runtime.session.id}`);
}
async function continueSession(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  const previous = host.previousSession;
  if (!previous || previous === runtime.session.id) {
    host.flash('No previous session');
    return;
  }
  host.previousSession = runtime.session.id;
  await runtime.switchSession(previous);
  redrawn(
    host,
    `Continued ${previous} · ${(runtime.store.get(previous)?.title || previous).slice(0, 40)}`,
  );
}
// Open a saved session. One from another folder is copied into this one; the original stays.
async function openSession(host: CommandHost, id: string): Promise<void> {
  const runtime = host.runtime;
  const source = runtime.store.get(id);
  const previous = runtime.session.id;
  await runtime.switchSession(id);
  host.previousSession = previous;
  redrawn(
    host,
    runtime.session.id === id
      ? `Resumed ${id} · ${(source?.title || id).slice(0, 40)}`
      : `Forked ${id} from ${shortPath(source?.workspace ?? '')} → ${runtime.session.id}`,
  );
}
// /resume [n|id]: a list of this folder's sessions, or one by its number there or the end of
// its id.
async function resume(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  const target = args.trim();
  if (!target) {
    sessionList(host, false);
    return;
  }
  const sessions = runtime.store.list(host.workspace);
  if (!sessions.length) {
    host.flash('No earlier session in this folder');
    return;
  }
  const number = /^\d+$/.test(target) ? Number(target) : 0;
  const chosen =
    number >= 1 && number <= sessions.length
      ? sessions[number - 1]
      : sessions.find(
          (session) => session.id === target || session.id.endsWith(target),
        );
  if (!chosen) {
    host.fail(`No session '${target}' in this folder · /resume lists them`);
    return;
  }
  if (chosen.id === runtime.session.id) {
    host.flash('Already in that session');
    return;
  }
  await openSession(host, chosen.id);
}
// Type to search; tab shows every folder's sessions, ctrl+r renames one, ctrl+d deletes one.
function sessionList(host: CommandHost, everywhere: boolean, query = ''): void {
  const runtime = host.runtime;
  const again = (): void =>
    sessionList(host, everywhere, host.state.picker?.query ?? query);
  const here = runtime.store.get(runtime.session.id)?.workspace;
  host.picker(
    everywhere ? 'Sessions · every folder' : 'Sessions · this folder',
    (everywhere
      ? runtime.store.list()
      : runtime.store.list(host.workspace)
    ).map((session) => ({
      key: session.id,
      label: session.title || '(untitled)',
      meta:
        sessionAge(session.updated) +
        (session.workspace === here ? '' : ` · ${pathTail(session.workspace)}`),
      search: `${session.id} ${session.workspace}`,
      current: session.id === runtime.session.id,
    })),
    async (item) => {
      if (item.key !== runtime.session.id) await openSession(host, item.key);
    },
    {
      hint: 'enter opens · tab every folder · ctrl+r renames · ctrl+d deletes',
      empty: "No sessions here · tab shows every folder's",
      focusKey: runtime.session.id,
      keys: {
        tab: () => sessionList(host, !everywhere, host.state.picker?.query),
        'ctrl+r': async (item) => {
          if (!item) return;
          const text = await host.askText(
            'rename',
            'New name',
            item.label === '(untitled)' ? '' : item.label,
          );
          const title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
          if (title) runtime.store.rename(item.key, title);
          again();
        },
        'ctrl+d': async (item) => {
          if (!item) return;
          if (item.key === runtime.session.id) {
            host.flash('The session you are in cannot be deleted');
            return;
          }
          const label = item.label.slice(0, 40);
          const answer = await host.askChoice(
            'delete',
            `Delete “${label}” and its messages?`,
            ['delete', 'keep'],
          );
          if (answer !== 'delete') return;
          runtime.store.delete(item.key);
          if (host.previousSession === item.key) host.previousSession = '';
          again();
          host.flash(`Deleted ${label}`);
        },
      },
    },
  );
  if (query && host.state.picker) host.state.picker.query = query;
}
// /tree goes back to a message of this session; /fork starts a new session from before one of
// your messages. Your message comes back to the box to change and send again.
async function tree(
  host: CommandHost,
  args: string,
  fork: boolean,
): Promise<void> {
  const runtime = host.runtime;
  host.snoozeJobs();
  const all = runtime.store
    .tree(runtime.session.id)
    .filter((checkpoint) => !checkpoint.message.internal);
  const head = runtime.store.get(runtime.session.id)?.head;
  let mine = fork;
  const choices = (): typeof all =>
    all.filter((checkpoint) => !mine || checkpoint.message.role === 'user');
  const go = async (key: string, named = false): Promise<void> => {
    const checkpoint = runtime.store.checkpoint(key)!;
    if (!checkpoint.message) throw new Error('selected entry has no message');
    const user = checkpoint.message.role === 'user';
    if (!fork && key === head && !user) {
      host.flash('Already here');
      return;
    }
    // Going back stops the running turn first, as esc would.
    if (runtime.busy) await runtime.cancel();
    const point = user ? checkpoint.parent : checkpoint.id;
    if (fork) {
      const session = runtime.store.fork(
        runtime.session.id,
        host.workspace,
        point,
      );
      host.previousSession = runtime.session.id;
      await runtime.switchSession(session.id);
    } else runtime.store.select(runtime.session.id, point);
    if (user)
      host.setDraft(
        checkpoint.message.display || checkpoint.message.content,
        checkpoint.message.pastes,
      );
    redrawn(
      host,
      !fork
        ? `Back ${user ? 'before your message' : 'after that answer'} · ` +
            'your next message starts a new branch · /tree shows them all'
        : named
          ? `Forked from ${key} → ${runtime.session.id}`
          : `Forked → ${runtime.session.id} · your message is back in the box`,
    );
  };
  // /fork <id>: straight from that message.
  const named = fork && all.find((checkpoint) => checkpoint.id === args.trim());
  if (named) {
    await go(named.id, true);
    return;
  }
  if (!choices().length) {
    host.flash(
      fork ? 'No message to fork from yet' : 'Nothing in this session yet',
    );
    return;
  }
  let marks = runtime.store.labels(runtime.session.id);
  const rows = (): PickerItem[] =>
    choices().map((checkpoint) => {
      const mark = marks[checkpoint.message.id];
      return {
        key: checkpoint.id,
        label:
          (mark ? `[${mark}] ` : '') +
          `${checkpoint.message.role}: ${checkpoint.message.display || checkpoint.message.content || '(tool call)'}`,
        search: mark ?? '',
        current: checkpoint.id === head,
      };
    });
  host.picker(
    fork ? 'Fork from a message' : 'Session tree',
    rows(),
    (item) => go(item.key),
    fork
      ? {
          hint: 'a new session with everything before it; the message comes back to edit',
          focusKey: choices().at(-1)?.id,
        }
      : {
          hint: 'enter goes back there · L labels · ctrl+u only your messages',
          keys: {
            'ctrl+u': () => {
              mine = !mine;
              host.state.picker?.setItems(rows());
            },
            L: async (item) => {
              const message =
                item && runtime.store.checkpoint(item.key)?.message;
              if (!message) return;
              const text = await host.askText(
                'label',
                'Label (empty removes it)',
                marks[message.id] ?? '',
              );
              runtime.store.setLabel(runtime.session.id, message.id, text);
              marks = runtime.store.labels(runtime.session.id);
              host.state.picker?.setItems(rows());
            },
          },
        },
  );
  if (args.trim() && host.state.picker) host.state.picker.query = args.trim();
}
async function clone(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  const session = runtime.store.fork(runtime.session.id, host.workspace);
  host.previousSession = runtime.session.id;
  await runtime.switchSession(session.id);
  redrawn(host, `Cloned this branch → ${session.id}`);
}

const HANDLERS: Record<string, Handler> = {
  new: newSession,
  continue: continueSession,
  resume,
  tree: (host, args) => tree(host, args, false),
  fork: (host, args) => tree(host, args, true),
  clone,
  help,
  hotkeys: (host) => host.notice(hotkeysText()),
  plan,
  yolo,
  thinking,
  details,
  themes,
  name,
  session,
  approvals,
  mcp,
  extensions,
  trust,
  undo,
  redo,
  init,
  export: exportSession,
  share,
  unshare,
  import: importSession,
  copy,
  settings: (host) => settingsList(host),
  effort,
  logout,
  jobs,
  skill,
  compact,
};
