// Model setup and the trust question, asked line by line, for a run that has a terminal on
// standard input but does not open the full-screen interface (`circle -p`, `--line`, a
// redirected standard output). The questions go to standard error so that standard output
// keeps only the answers.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { normalizeBaseUrl, probeSummary, resolveEndpoint } from './probe.js';
import {
  defaultAuth,
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  saveSettingsChange,
  trustFolder,
  withConnection,
  type CircleSettings,
} from './settings.js';
import { normalizeWorkspace } from './paths.js';
export interface LinePrompter {
  // The next line typed, or undefined once input has ended or ctrl+c was pressed.
  ask(question: string, secret?: boolean): Promise<string | undefined>;
  say(text: string): void;
  close(): void;
}
export function terminalPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): LinePrompter {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const terminal = Boolean(input.isTTY);
  const reader = createInterface({ input, output: sink, terminal });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  });
  reader.on('SIGINT', () => {
    output.write('\n');
    reader.close();
  });
  return {
    ask(question, secret = false) {
      if (lines.length) {
        // Typed ahead: a terminal has shown it already.
        output.write(question + '\n');
        return Promise.resolve(lines.shift());
      }
      if (ended) return Promise.resolve(undefined);
      if (secret) {
        // The key is not echoed: what readline draws goes nowhere until enter.
        output.write(question);
        reader.setPrompt('');
        muted = true;
      } else reader.setPrompt(question);
      reader.prompt();
      return new Promise((resolveLine) =>
        waiting.push((line) => {
          if (secret) {
            muted = false;
            if (line !== undefined) output.write('\n');
          }
          resolveLine(line);
        }),
      );
    },
    say(text) {
      output.write(text + '\n');
    },
    close() {
      reader.close();
    },
  };
}
async function pick(
  io: LinePrompter,
  label: string,
  options: string[],
): Promise<string | undefined> {
  io.say(label);
  options.forEach((option, index) => io.say(`  [${index + 1}] ${option}`));
  while (true) {
    const raw = (await io.ask('number: '))?.trim();
    if (raw === undefined) return undefined;
    const index = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (index >= 1 && index <= options.length) return options[index - 1];
    io.say('Pick one of the numbers.');
  }
}
async function pickModel(
  io: LinePrompter,
  models: string[],
): Promise<string | undefined> {
  io.say(
    models.length
      ? 'Model (a number, or any model id; an id that is not listed is not checked):'
      : 'Model id (the endpoint listed none, so it is not checked):',
  );
  models.forEach((model, index) => io.say(`  [${index + 1}] ${model}`));
  while (true) {
    const raw = (await io.ask('model: '))?.trim();
    if (raw === undefined) return undefined;
    if (/^\d+$/.test(raw) && models.length) {
      const index = Number(raw);
      if (index >= 1 && index <= models.length) return models[index - 1];
    } else if (raw) return raw;
    io.say('Type a model id, or one of the numbers.');
  }
}
// Setup: the URL, the key, the protocol when the endpoint does not tell, and the model.
// Enter keeps the saved URL and key. Returns the saved settings, or undefined when it was
// left unfinished (the reason is said).
export async function runLineInit(
  home: string,
  io: LinePrompter = terminalPrompter(),
): Promise<CircleSettings | undefined> {
  try {
    io.say('Set up Circle');
    let previous: CircleSettings;
    try {
      previous = loadSettings(home);
    } catch {
      previous = defaultSettings();
    }
    let savedUrl = '';
    let savedKey = '';
    if (previous.initialized) {
      savedUrl = previous.auth.base_url;
      try {
        savedKey =
          loadCredentials(home)[previous.auth.api_key_ref || 'api_key'] || '';
      } catch {
        savedKey = '';
      }
    }
    const typedUrl = await io.ask(
      `API URL${savedUrl ? ` [${savedUrl}]` : ''}: `,
    );
    const typedKey =
      typedUrl === undefined
        ? undefined
        : await io.ask(
            savedKey ? 'API KEY (enter keeps the saved one): ' : 'API KEY: ',
            true,
          );
    if (typedKey === undefined) {
      io.say('Setup was not finished.');
      return undefined;
    }
    const url = typedUrl!.trim() || savedUrl;
    const key = typedKey.trim() || savedKey;
    if (!url || !key) {
      io.say('Both the URL and the key are needed.');
      return undefined;
    }
    let base: string;
    try {
      base = normalizeBaseUrl(url, 'openai');
    } catch (error) {
      io.say(
        `Not an API URL: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    io.say('Asking the endpoint for its models…');
    const found = await resolveEndpoint(base, key);
    io.say(probeSummary(found));
    const protocol =
      found.inferred || found.status === 'failed'
        ? await pick(io, 'Which kind of API is it?', ['openai', 'anthropic'])
        : found.protocol;
    const model = protocol && (await pickModel(io, found.models));
    if (!protocol || !model) {
      io.say('Setup was not finished.');
      return undefined;
    }
    const settings = withConnection(
      {
        ...defaultAuth(),
        protocol,
        base_url: normalizeBaseUrl(found.base_url || base, protocol),
        model,
      },
      home,
    );
    saveCredentials({ api_key: key }, home);
    saveSettings(settings, home);
    io.say('Saved settings.json and credentials.json in the data folder.');
    return settings;
  } finally {
    io.close();
  }
}
// The trust question for a folder Circle has not worked in. Returns the settings with the
// folder trusted (and saved), or undefined when it was not trusted.
export async function runLineTrust(
  settings: CircleSettings,
  workspace: string,
  home: string,
  io: LinePrompter = terminalPrompter(),
): Promise<CircleSettings | undefined> {
  try {
    const target = normalizeWorkspace(workspace);
    io.say('Trust this folder?');
    io.say(`  ${target}`);
    io.say(
      "Circle reads, edits and runs commands here, asking first for anything that\nchanges files. Trusting also loads the folder's own commands, skills and\nextensions.",
    );
    const answer = (await io.ask('trust it? [y/N]: '))?.trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      io.say('Not trusted.');
      return undefined;
    }
    saveSettingsChange(home, (saved) => {
      saved.trusted_folders = trustFolder(saved, target).trusted_folders;
    });
    return trustFolder(settings, target);
  } finally {
    io.close();
  }
}
