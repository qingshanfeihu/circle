#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { circleHome, normalizeWorkspace } from './paths.js';
import {
  isFolderTrusted,
  isReady,
  loadCredentials,
  loadSettings,
  applyProjectSettings,
} from './settings.js';
import {
  defaultRunOptions,
  promptText,
  toolNames,
  type RunOptions,
} from './run_options.js';
import { resolveEndpoint } from './probe.js';
import { EFFORT_LEVELS } from './model.js';
export const VERSION = '0.1.0-dev';
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
    run: defaultRunOptions(),
  };
  const words: string[] = [];
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
      if (valueKey === 'name') options.run.session_name = value;
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
  if (
    options.sessionId &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.sessionId)
  )
    throw new UsageError('invalid session ID');
  if (
    options.fork &&
    (options.continue ||
      options.resume ||
      options.session ||
      options.run.no_session)
  )
    throw new UsageError(
      '--fork cannot be combined with resume or --no-session',
    );
  if (
    options.sessionId &&
    (options.continue || options.resume || options.session)
  )
    throw new UsageError('--session-id cannot be combined with resume');
  if (
    options.run.no_session &&
    (options.continue || options.resume || options.session || options.sessionId)
  )
    throw new UsageError('--no-session cannot be combined with saved sessions');
  if (
    options.print &&
    printPrompt === undefined &&
    words.length &&
    !words[0]!.startsWith('@')
  )
    printPrompt = words.shift();
  if (words[0] && !words[0].startsWith('@')) {
    const candidate = normalizeWorkspace(words[0]);
    if (existsSync(candidate) && statSync(candidate).isDirectory())
      ((options.workspace = candidate), words.shift());
  }
  const attachments: string[] = [];
  for (const word of words) {
    if (word.startsWith('@')) attachments.push(word);
    else options.prompts.push(word);
  }
  if (printPrompt) options.prompts.unshift(printPrompt);
  if (attachments.length) {
    for (const item of attachments)
      if (!existsSync(resolve(options.workspace, item.slice(1))))
        throw new UsageError(`attachment does not exist: ${item}`);
    if (options.prompts.length)
      options.prompts[0] += ' ' + attachments.join(' ');
    else options.prompts.push(attachments.join(' '));
  }
  if (
    options.resume &&
    (options.print || options.line || options.prompts.length)
  )
    throw new UsageError(
      '-r cannot be combined with print, line mode or messages',
    );
  if (options.line && options.prompts.length)
    throw new UsageError('--line does not take messages');
  if (options.mode === 'rpc' && options.prompts.length)
    throw new UsageError('send RPC messages on stdin');
  return options;
}
export function helpText(): string {
  return `usage: circle [options] [folder] [@file ...] [message ...]\n\nA terminal coding agent for your own model endpoint.\n\n  -p, --print [PROMPT]  Print the answer and exit\n  --mode text|json|rpc  Output mode\n  -c, --continue       Continue the last session\n  -r, --resume         Choose a saved session\n  --session ID         Resume by ID\n  --session-id ID      Open or create this ID\n  --fork ID            Copy a saved session\n  --no-session         In-memory conversation\n  -m, --model ID       Model for this run\n  --thinking LEVEL     Thinking depth\n  --list-models [TEXT] List endpoint models\n  --export ID [OUT]    Export a saved session\n  --system-prompt TEXT|FILE\n  --append-system-prompt TEXT|FILE\n  --no-context-files   Skip instruction files\n  --tools LIST         Limit tools\n  --exclude-tools LIST Exclude tools\n  --no-tools           No tools except compaction\n  --yolo               Auto mode for print or line\n  --line               Plain line mode\n  --init               Model setup\n  --print-home         Print the data directory\n  -v, --version        Print version\n  -h, --help           Show help\n`;
}
async function pipedText(timeout: number, limit = 8_000_000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolveInput, reject) => {
    let buffer = '';
    const timer = setTimeout(() => done(), timeout);
    let started = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.off('data', data);
      process.stdin.off('end', done);
      process.stdin.off('error', fail);
      process.stdin.pause();
    };
    const done = (): void => {
      cleanup();
      resolveInput(buffer);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const data = (chunk: Buffer | string): void => {
      if (!started) {
        started = true;
        clearTimeout(timer);
      }
      buffer += chunk.toString();
      if (buffer.length > limit)
        fail(new UsageError('piped input exceeds 8 MB'));
    };
    process.stdin.on('data', data);
    process.stdin.once('end', done);
    process.stdin.once('error', fail);
    process.stdin.resume();
  });
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: import('./runtime.js').AgentRuntime | undefined;
  try {
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
    if (options.export) {
      const { CheckpointStore } = await import('./checkpoint_store.js');
      const { toHtml, toJsonl } = await import('./session_export.js');
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
            ? toJsonl(store.messages(session.id), meta)
            : toHtml(store.messages(session.id), meta),
        );
        process.stdout.write(path + '\n');
        return 0;
      } finally {
        store.close();
      }
    }
    let settings;
    try {
      settings = loadSettings(home);
    } catch (error) {
      throw new UsageError(`settings could not be read: ${error}`);
    }
    if (options.model) settings.auth.model = options.model;
    if (options.thinking) settings.default_thinking = options.thinking;
    if (options.listModels !== null) {
      if (!isReady(settings))
        throw new UsageError('settings are not initialized');
      const credentials = loadCredentials(home);
      const result = await resolveEndpoint(
        settings.auth.base_url,
        credentials[settings.auth.api_key_ref] || '',
        { protocol: settings.auth.protocol },
      );
      if (result.status === 'failed') throw new Error(result.detail);
      process.stdout.write(
        result.models
          .filter((model) =>
            model.toLowerCase().includes(options.listModels!.toLowerCase()),
          )
          .join('\n') + '\n',
      );
      return 0;
    }
    const interactive = Boolean(
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !options.print &&
      !options.line &&
      options.mode === 'text' &&
      !['1', 'true', 'yes'].includes(process.env.CIRCLE_NO_TUI || ''),
    );
    const runtimeOptions = {
      workspace: options.workspace,
      home,
      settings,
      run: options.run,
      session: options.session || undefined,
      sessionId: options.sessionId || undefined,
      continue: options.continue,
      fork: options.fork || undefined,
    };
    if (interactive) {
      const { runTui } = await import('./tui/session_app.js');
      return await runTui({
        ...runtimeOptions,
        init: options.init,
        pickSession: options.resume,
        prompts: options.prompts,
      });
    }
    if (options.init) throw new UsageError('model setup needs a terminal');
    if (!isReady(settings))
      throw new UsageError(
        'settings are not initialized; run circle in a terminal',
      );
    if (
      !existsSync(options.workspace) ||
      !statSync(options.workspace).isDirectory()
    )
      throw new UsageError('workspace is not a directory');
    if (!isFolderTrusted(settings, options.workspace))
      throw new UsageError('folder is not trusted; run circle in a terminal');
    const { problems } = applyProjectSettings(settings, options.workspace);
    for (const problem of problems) process.stderr.write(problem + '\n');
    const { AgentRuntime } = await import('./runtime.js');
    runtime = new AgentRuntime({ ...runtimeOptions, headless: true });
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
    if (options.print || options.mode === 'json' || options.prompts.length) {
      const piped = await pipedText(options.prompts.length ? 3000 : 30000);
      if (piped.trim()) {
        if (options.prompts.length)
          options.prompts[0] = piped + '\n\n' + options.prompts[0];
        else options.prompts.push(piped);
      }
      if (!options.prompts.length) throw new UsageError('a prompt is required');
      return await runPrint(runtime, options.prompts, {
        json: options.mode === 'json',
        verbose: options.verbose,
      });
    }
    return await runLine(runtime);
  } catch (error) {
    process.stderr.write(
      `✖ ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return error instanceof UsageError ? 2 : 1;
  } finally {
    await runtime?.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
