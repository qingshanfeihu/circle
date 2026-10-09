#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { circleHome, expandUser, normalizeWorkspace } from './paths.js';
import {
  isFolderTrusted,
  isReady,
  loadCredentials,
  loadSettings,
  applyProjectSettings,
  type CircleSettings,
} from './settings.js';
import {
  defaultRunOptions,
  promptText,
  toolNames,
  type RunOptions,
} from './run_options.js';
import { resolveEndpoint } from './probe.js';
import { mediaType } from './media.js';
import { EFFORT_LEVELS } from './model.js';
import { installExitGuard } from './exit_guard.js';
import { configureNetwork } from './net.js';
import { VERSION } from './version.js';
export { VERSION } from './version.js';
export class UsageError extends Error {}
export interface CliOptions {
  version: boolean;
  help: boolean;
  printHome: boolean;
  print: boolean;
  line: boolean;
  init: boolean;
  mode: string;
  yolo: boolean;
  verbose: boolean;
  continue: boolean;
  resume: boolean;
  session: string;
  sessionId: string;
  fork: string;
  model: string;
  thinking: string;
  listModels: string | null;
  export: string[] | null;
  workspace: string;
  prompts: string[];
  // The @files from the command line, as written, without the @
  files: string[];
  run: RunOptions;
}
const FLAGS: Record<
  string,
  keyof CliOptions | 'no-session' | 'no-context-files' | 'no-tools'
> = {
  '-v': 'version',
  '--version': 'version',
  '-h': 'help',
  '--help': 'help',
  '--print-home': 'printHome',
  '-c': 'continue',
  '--continue': 'continue',
  '-r': 'resume',
  '--resume': 'resume',
  '--line': 'line',
  '--init': 'init',
  '--yolo': 'yolo',
  '--verbose': 'verbose',
  '--no-session': 'no-session',
  '-nc': 'no-context-files',
  '--no-context-files': 'no-context-files',
  '-nt': 'no-tools',
  '--no-tools': 'no-tools',
};
const VALUES: Record<string, string> = {
  '--mode': 'mode',
  '--session': 'session',
  '--session-id': 'sessionId',
  '--fork': 'fork',
  '-m': 'model',
  '--model': 'model',
  '--thinking': 'thinking',
  '-n': 'name',
  '--name': 'name',
  '--models': 'models',
  '--system-prompt': 'system',
  '--append-system-prompt': 'append',
  '-t': 'tools',
  '--tools': 'tools',
  '-xt': 'exclude',
  '--exclude-tools': 'exclude',
};
export function parseCli(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    version: false,
    help: false,
    printHome: false,
    print: false,
    line: false,
    init: false,
    mode: 'text',
    yolo: false,
    verbose: false,
    continue: false,
    resume: false,
    session: '',
    sessionId: '',
    fork: '',
    model: '',
    thinking: '',
    listModels: null,
    export: null,
    workspace: normalizeWorkspace(cwd),
    prompts: [],
    files: [],
    run: defaultRunOptions(),
  };
  const words: string[] = [];
  // undefined: no -p; '': -p given as a flag, so the first word may be the prompt
  let printPrompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const equal = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = equal >= 0 ? raw.slice(0, equal) : raw;
    const inline = equal >= 0 ? raw.slice(equal + 1) : undefined;
    if (flag === '-p' || flag === '--print') {
      options.print = true;
      if (inline !== undefined) printPrompt = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-'))
        printPrompt = argv[++i];
      else printPrompt ??= '';
      continue;
    }
    if (flag === '--list-models') {
      options.listModels =
        inline ??
        (argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : '');
      continue;
    }
    if (flag === '--export') {
      const id = inline ?? argv[++i];
      if (!id || id.startsWith('-'))
        throw new UsageError('--export requires a session ID');
      options.export = [id];
      if (argv[i + 1] && !argv[i + 1]!.startsWith('-'))
        options.export.push(argv[++i]!);
      continue;
    }
    const boolean = FLAGS[flag];
    if (boolean) {
      if (inline !== undefined)
        throw new UsageError(`${flag} does not take a value`);
      if (boolean === 'no-session') options.run.no_session = true;
      else if (boolean === 'no-context-files')
        options.run.no_context_files = true;
      else if (boolean === 'no-tools') options.run.tools = [];
      else (options as unknown as Record<string, unknown>)[boolean] = true;
      continue;
    }
    const valueKey = VALUES[flag];
    if (valueKey) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`${flag} requires a value`);
      if (valueKey === 'name') options.run.session_name = sessionName(value);
      else if (valueKey === 'models')
        options.run.models = value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      else if (valueKey === 'system')
        options.run.system_prompt = promptText(value);
      else if (valueKey === 'append')
        options.run.append_system_prompt.push(promptText(value));
      else if (valueKey === 'tools') options.run.tools = toolNames(value);
      else if (valueKey === 'exclude')
        options.run.exclude_tools = toolNames(value);
      else (options as unknown as Record<string, unknown>)[valueKey] = value;
      continue;
    }
    if (raw.startsWith('-')) throw new UsageError(`unknown option: ${raw}`);
    words.push(raw);
  }
  if (!['text', 'json', 'rpc'].includes(options.mode))
    throw new UsageError('--mode must be text, json or rpc');
  if (
    options.thinking &&
    !(EFFORT_LEVELS as readonly string[]).includes(options.thinking)
  )
    throw new UsageError('unknown thinking depth');
  // As in the Python releases: the words are a folder, @files and messages. The first word
  // is the folder when it is one, or when it has no spaces, so a mistyped folder is an
  // error and not a message; a folder may also come last, after a message.
  const path = (word: string): string => resolve(cwd, expandUser(word));
  const isDir = (word: string): boolean => {
    try {
      return statSync(path(word)).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = (word: string): boolean =>
    word.startsWith('@') && word.length > 1;
  if (printPrompt && (isDir(printPrompt) || isFile(printPrompt))) {
    // `circle -p ~/code/app` with the prompt piped in, `circle -p @notes.md "summarize"`
    words.unshift(printPrompt);
    printPrompt = '';
  }
  if (options.mode === 'json' && printPrompt === undefined) printPrompt = '';
  options.files = words.filter(isFile).map((word) => word.slice(1));
  const messages = words.filter((word) => !isFile(word));
  if (printPrompt === '' && messages.length && !isDir(messages[0]!))
    printPrompt = messages.shift();
  if (messages.length && (isDir(messages[0]!) || !/\s/.test(messages[0]!)))
    options.workspace = normalizeWorkspace(path(messages.shift()!));
  else if (messages.length > 1 && isDir(messages.at(-1)!))
    options.workspace = normalizeWorkspace(path(messages.pop()!));
  options.prompts = printPrompt ? [printPrompt, ...messages] : messages;
  const problem = conflict(options, printPrompt !== undefined, messages);
  if (problem) throw new UsageError(problem);
  return options;
}
// `-n`: spaces collapsed and cut to 80 characters, as /name does.
function sessionName(value: string): string {
  return Array.from(value.split(/\s+/).filter(Boolean).join(' '))
    .slice(0, 80)
    .join('');
}
// Options that cannot go together, as a message, or ''.
function conflict(
  options: CliOptions,
  prompt: boolean,
  messages: string[],
): string {
  const opening = (
    [
      ['-c', options.continue],
      ['-r', options.resume],
      ['--session', Boolean(options.session)],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([flag]) => flag);
  const words = messages.length > 0 || options.files.length > 0;
  if (options.fork && (opening.length || options.run.no_session))
    return `--fork starts a new conversation; it cannot go with ${opening[0] ?? '--no-session'}`;
  if (options.sessionId && opening.length)
    return `--session-id chooses the conversation; it cannot go with ${opening[0]}`;
  if (options.run.no_session && (opening.length || options.sessionId))
    return '--no-session keeps nothing, so there is nothing to open';
  if (
    options.sessionId &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.sessionId)
  )
    return "--session-id takes letters, digits, '.', '_' and '-', starting and ending with a letter or digit";
  if (options.line && options.mode !== 'text')
    return `--mode ${options.mode} and --line cannot go together`;
  if (options.mode === 'rpc' && (prompt || words))
    return '--mode rpc takes its prompts as commands on standard input, not as words';
  if (options.mode === 'rpc' && options.resume)
    return '-r opens a list to choose from, so it needs the full-screen interface';
  if (options.resume && (prompt || options.line || options.mode === 'json'))
    return '-r opens a list to choose from, so it needs the full-screen interface; use -c or --session ID with -p and --line.';
  if (options.line && words)
    return '--line reads its messages from standard input, one per line';
  if (options.resume && words)
    return '-r opens a list to choose from; send the message once the session is open';
  return '';
}
export function helpText(): string {
  return `usage: circle [options] [folder] [@file ...] [message ...]\n\nA terminal coding agent for your own model endpoint.\n\n  -p, --print [PROMPT]  Print the answer and exit\n  --mode text|json|rpc  Output mode\n  -c, --continue       Continue the last session\n  -r, --resume         Choose a saved session\n  --session ID         Resume by ID\n  --session-id ID      Open or create this ID\n  --fork ID            Copy a saved session\n  --no-session         In-memory conversation\n  -m, --model ID       Model for this run\n  --thinking LEVEL     Thinking depth\n  --list-models [TEXT] List endpoint models\n  --export ID [OUT]    Export a saved session\n  --system-prompt TEXT|FILE\n  --append-system-prompt TEXT|FILE\n  --no-context-files   Skip instruction files\n  --tools LIST         Limit tools\n  --exclude-tools LIST Exclude tools\n  --no-tools           No tools except compaction\n  --yolo               Auto mode for print or line\n  --line               Plain line mode\n  --init               Model setup\n  --print-home         Print the data directory\n  -v, --version        Print version\n  -h, --help           Show help\n`;
}
// How long `-p PROMPT` waits for piped input to start before going on without it.
const STDIN_WAIT_MS = 3000;
// Piped standard input, or '' when it is a terminal. With `waitMs` the read only starts if
// input (or its end) arrives within that time: a caller that leaves standard input open and
// never writes to it, as some scripts and CI runners do, would otherwise keep `circle -p`
// waiting forever. Without it, the read waits for the end of the input.
export async function pipedText(
  waitMs?: number,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  warn: (text: string) => void = (text) => process.stderr.write(text),
): Promise<string> {
  if (input.isTTY) return '';
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    const timer =
      waitMs === undefined
        ? undefined
        : setTimeout(() => {
            warn(
              `circle: nothing arrived on stdin within ${waitMs / 1000}s; going on without it (use </dev/null to skip the wait)\n`,
            );
            done(false);
          }, waitMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', ended);
      input.off('error', fail);
      input.pause();
    };
    const done = (keep: boolean): void => {
      cleanup();
      resolveInput(keep ? Buffer.concat(chunks).toString('utf8') : '');
    };
    const ended = (): void => done(true);
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const data = (chunk: Buffer | string): void => {
      clearTimeout(timer);
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    input.on('data', data);
    input.once('end', ended);
    input.once('error', fail);
    input.resume();
  });
}
// The @files from the command line as text for the first message. A path is looked for in
// the current folder, then in the folder Circle works in. A file that is missing or not text
// is a usage error.
export function fileBlocks(
  names: string[],
  workspace: string,
  cwd = process.cwd(),
): string {
  const blocks: string[] = [];
  for (const name of names) {
    let path = resolve(cwd, expandUser(name));
    if (!existsSync(path)) {
      const inside = resolve(workspace, expandUser(name));
      if (existsSync(inside)) path = inside;
    }
    if (mediaType(path) && existsSync(path)) {
      // An image goes as an attachment, which the harness adds for a mention inside the
      // folder Circle works in.
      const rel = relative(realpathSync(workspace), realpathSync(path));
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new UsageError(`${name} is not a text file`);
      blocks.push('@' + rel.split(sep).join('/'));
      continue;
    }
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(readFileSync(path))
        .replace(/\r\n?/g, '\n');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new UsageError(`no such file: ${name}`);
      if (error instanceof TypeError)
        throw new UsageError(`${name} is not a text file`);
      throw new UsageError(
        `cannot read ${name}: ${code === 'EISDIR' ? 'Is a directory' : error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (body.trim())
      blocks.push(`<file path="${name}">\n${body.trimEnd()}\n</file>`);
  }
  return blocks.join('\n\n');
}
// --list-models: the models that contain every word of the search, the current one marked.
async function listModels(search: string, home: string): Promise<number> {
  const settings = loadSettings(home);
  if (!isReady(settings))
    throw new UsageError(
      'Circle is not set up yet. Run `circle` in a terminal first.',
    );
  const credentials = loadCredentials(home);
  const key =
    credentials[settings.auth.api_key_ref] || credentials.api_key || '';
  const found = key
    ? await resolveEndpoint(settings.auth.base_url, key, {
        protocol: settings.auth.protocol,
      })
    : undefined;
  const models = found?.models ?? [];
  if (!models.length)
    throw new Error(`${settings.auth.base_url} did not list its models`);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = models.filter((model) =>
    words.every((word) => model.toLowerCase().includes(word)),
  );
  for (const model of shown)
    process.stdout.write(
      model + (model === settings.auth.model ? '  (current)' : '') + '\n',
    );
  if (!shown.length) throw new Error(`no model matches '${search}'`);
  return 0;
}
// Setup was left unfinished, or the folder was not trusted: exit 1.
class Declined extends Error {}
// Settings for a run without the full-screen interface. When standard input is a terminal,
// setup and the trust question are asked line by line, as the Python releases did.
async function headlessSettings(
  options: CliOptions,
  home: string,
): Promise<CircleSettings> {
  let settings: CircleSettings;
  try {
    settings = loadSettings(home);
  } catch (error) {
    throw new UsageError(`settings could not be read: ${error}`);
  }
  if (options.init || !isReady(settings)) {
    if (!process.stdin.isTTY)
      throw new UsageError(
        'Circle is not set up yet. Run `circle` in a terminal first.',
      );
    const { runLineInit } = await import('./line_setup.js');
    const done = await runLineInit(home);
    if (!done) throw new Declined();
    settings = done;
  }
  if (
    !existsSync(options.workspace) ||
    !statSync(options.workspace).isDirectory()
  )
    throw new UsageError(`No such folder: ${options.workspace}`);
  if (!isFolderTrusted(settings, options.workspace)) {
    if (!process.stdin.isTTY)
      throw new UsageError(
        `This folder is not trusted yet: ${options.workspace}\nRun \`circle\` there once in a terminal and trust it.`,
      );
    const { runLineTrust } = await import('./line_setup.js');
    const trusted = await runLineTrust(settings, options.workspace, home);
    if (!trusted) throw new Declined();
    settings = trusted;
  }
  const { problems } = applyProjectSettings(settings, options.workspace);
  for (const problem of problems) process.stderr.write(problem + '\n');
  if (options.model) settings.auth.model = options.model;
  return settings;
}
let networkConfigured = false;
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: import('./runtime.js').AgentRuntime | undefined;
  let offSignals: (() => void) | undefined;
  try {
    // HTTPS_PROXY, NO_PROXY, SSL_CERT_FILE and SSL_CERT_DIR, before the first request
    if (!networkConfigured) {
      networkConfigured = true;
      for (const problem of configureNetwork().problems)
        process.stderr.write(problem + '\n');
    }
    if (argv[0] === 'update') {
      const { updateInstalled } = await import('./update.js');
      return await updateInstalled(argv.slice(1));
    }
    const options = parseCli(argv);
    if (options.version) {
      process.stdout.write(VERSION + '\n');
      return 0;
    }
    if (options.help) {
      process.stdout.write(helpText());
      return 0;
    }
    const home = circleHome();
    if (options.printHome) {
      process.stdout.write(home + '\n');
      return 0;
    }
    if (options.listModels !== null)
      return await listModels(options.listModels, home);
    if (options.export) {
      const { CheckpointStore } = await import('./checkpoint_store.js');
      const { toHtml, toSessionBundle } = await import('./session_export.js');
      const store = new CheckpointStore(home);
      try {
        const { migrateLegacy } = await import('./migration.js');
        const migration = migrateLegacy(home, store);
        for (const error of migration.errors)
          process.stderr.write(
            `Could not migrate ${error.thread || 'legacy data'}: ${error.message}\n`,
          );
        const session = store.find(options.export[0]!);
        if (!session) throw new UsageError('unknown session');
        const path = options.export[1] || session.id + '.html';
        const meta = {
          thread_id: session.id,
          title: session.title,
          workspace: session.workspace,
          model: session.model,
        };
        writeFileSync(
          path,
          path.endsWith('.jsonl')
            ? toSessionBundle(store, session.id)
            : toHtml(store.messages(session.id), meta),
        );
        process.stdout.write(path + '\n');
        return 0;
      } finally {
        store.close();
      }
    }
    // As in the Python releases: the flag beats the variable and is never saved.
    if (options.thinking)
      process.env.CIRCLE_REASONING_EFFORT = options.thinking;
    const attached = fileBlocks(options.files, options.workspace);
    const interactive = Boolean(
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !options.print &&
      !options.line &&
      options.mode === 'text' &&
      !['1', 'true', 'yes'].includes(process.env.CIRCLE_NO_TUI || ''),
    );
    // -p and --mode json print; so do messages or @files given without a terminal.
    const printing =
      options.mode !== 'rpc' &&
      (options.print ||
        options.mode === 'json' ||
        (!interactive &&
          (options.prompts.length > 0 || options.files.length > 0)));
    if (printing) {
      // The prompt, then piped input before it and the @files after it.
      const prompts = [...options.prompts];
      const piped = await pipedText(prompts.length ? STDIN_WAIT_MS : undefined);
      let prompt = prompts.shift() ?? '';
      if (piped.trim())
        prompt = prompt
          ? `${piped.trimEnd()}\n\n${prompt}`.trim()
          : piped.trim();
      if (attached) prompt = `${prompt}\n\n${attached}`.trim();
      if (!prompt.trim())
        throw new UsageError(
          'Nothing to do: give a prompt after -p or pipe one in.',
        );
      options.prompts = [prompt, ...prompts];
    }
    const runtimeOptions = {
      workspace: options.workspace,
      home,
      run: options.run,
      session: options.session || undefined,
      sessionId: options.sessionId || undefined,
      continue: options.continue,
      fork: options.fork || undefined,
      modelOverride: options.model || undefined,
    };
    if (interactive) {
      if (
        !existsSync(options.workspace) ||
        !statSync(options.workspace).isDirectory()
      )
        throw new UsageError(`No such folder: ${options.workspace}`);
      let settings;
      try {
        settings = loadSettings(home);
      } catch (error) {
        throw new UsageError(`settings could not be read: ${error}`);
      }
      // The model gets the @files' text with the first message; the screen shows @path.
      const [first = '', ...rest] = options.prompts;
      const prompts =
        first || attached
          ? [[first, attached].filter(Boolean).join('\n\n'), ...rest]
          : [];
      const shown = [
        [first, ...options.files.map((name) => '@' + name)].join(' ').trim(),
      ];
      const { runTui } = await import('./tui/session_app.js');
      return await runTui({
        ...runtimeOptions,
        settings,
        init: options.init,
        pickSession: options.resume,
        prompts,
        shown,
      });
    }
    const settings = await headlessSettings(options, home);
    const { AgentRuntime } = await import('./runtime.js');
    runtime = new AgentRuntime({
      ...runtimeOptions,
      settings,
      headless: true,
    });
    offSignals = installExitGuard(runtime);
    for (const error of runtime.migration.errors)
      process.stderr.write(
        `Could not migrate ${error.thread || 'legacy data'}: ${error.message}\n`,
      );
    runtime.policy.setYolo(runtime.session.id, options.yolo);
    if (options.mode === 'rpc') {
      const { runRpc } = await import('./rpc.js');
      return await runRpc(runtime);
    }
    const { runPrint, runLine } = await import('./headless.js');
    if (printing)
      return await runPrint(runtime, options.prompts, {
        json: options.mode === 'json',
        verbose: options.verbose,
        yolo: options.yolo,
      });
    return await runLine(runtime, {
      verbose: options.verbose,
      yolo: options.yolo,
    });
  } catch (error) {
    // Setup and the trust question have said why already.
    if (!(error instanceof Declined))
      process.stderr.write(
        `✖ ${error instanceof Error ? error.message : String(error)}\n`,
      );
    return error instanceof UsageError ? 2 : 1;
  } finally {
    offSignals?.();
    await runtime?.close();
  }
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = await main();
