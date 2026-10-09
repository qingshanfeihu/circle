import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { fileBlocks, parseCli, pipedText, UsageError } from '../src/cli.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import { runLineTrust, terminalPrompter } from '../src/line_setup.js';
import { cleanup, scratch } from './helpers.js';

type Reply =
  | { content: string }
  | { call: { name: string; args: Record<string, unknown> } }
  | { status: number; headers?: Record<string, string>; body: unknown };
interface Gateway {
  base: string;
  bodies: Record<string, unknown>[];
  keys: string[];
}
// A local OpenAI-style endpoint: /v1/models lists `models`, each chat request takes the next
// reply (the last one repeats).
async function gateway(
  t: { after(fn: () => void | Promise<void>): void },
  replies: Reply[],
  models: string[] = ['gateway'],
): Promise<Gateway> {
  const bodies: Record<string, unknown>[] = [];
  const keys: string[] = [];
  let count = 0;
  const instance = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      keys.push(String(request.headers.authorization ?? ''));
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      bodies.push(JSON.parse(text));
      const reply = replies[Math.min(count++, replies.length - 1)]!;
      if ('status' in reply) {
        response.writeHead(reply.status, {
          'Content-Type': 'application/json',
          ...reply.headers,
        });
        response.end(JSON.stringify(reply.body));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta =
        'content' in reply
          ? { content: reply.content }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${count}`,
                  type: 'function',
                  function: {
                    name: reply.call.name,
                    arguments: JSON.stringify(reply.call.args),
                  },
                },
              ],
            };
      response.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta,
                finish_reason: 'content' in reply ? 'stop' : 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1200, completion_tokens: 34 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      response.end();
    },
  );
  await new Promise<void>((ready) =>
    instance.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, bodies, keys };
}
function setUp(
  home: string,
  base: string,
  trusted: string[],
  model = 'gateway',
): void {
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = base + '/v1';
  settings.auth.model = model;
  for (const folder of trusted) settings = trustFolder(settings, folder);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
}
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}
// tsx by path, so the CLI can run from another current folder.
const TSX = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const CLI = join(process.cwd(), 'src', 'cli.ts');
// The real CLI in a child process. `stdin` is written and closed; null leaves it open.
function circle(
  home: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: string | null;
    env?: Record<string, string>;
  } = {},
): Promise<Run> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        CIRCLE_HOME: home,
        CIRCLE_NO_MODELS_REFRESH: '1',
        CIRCLE_JOB_WAIT: '0',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(closer);
      done({ code, stdout, stderr });
    });
    const closer = setTimeout(() => child.stdin.end(), 10000);
    if (options.stdin !== null) {
      clearTimeout(closer);
      child.stdin.end(options.stdin ?? '');
    }
  });
}
const userText = (body: Record<string, unknown>): string => {
  const messages = body.messages as { role: string; content: unknown }[];
  const last = messages.filter((message) => message.role === 'user').at(-1)!;
  return typeof last.content === 'string'
    ? last.content
    : (last.content as { type: string; text?: string }[])
        .map((part) => part.text ?? '')
        .join('');
};
const systemText = (body: Record<string, unknown>): string =>
  (body.messages as { role: string; content: unknown }[])
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('\n');

test('@file is read from the current folder, then the workspace, and inlined after the message', async (t) => {
  const home = scratch(t);
  const here = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(here, 'notes.txt'), 'from the current folder\r\n');
  writeFileSync(join(workspace, 'inner.txt'), 'from the workspace\n\n');
  writeFileSync(join(here, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(
    home,
    ['-p', 'review these', '@notes.txt', '@inner.txt', workspace],
    { cwd: here },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'ok\n');
  assert.equal(
    userText(endpoint.bodies[0]!),
    'review these\n\n<file path="notes.txt">\nfrom the current folder\n</file>\n\n<file path="inner.txt">\nfrom the workspace\n</file>',
  );
  const missing = await circle(home, ['-p', 'x', '@gone.txt', workspace], {
    cwd: here,
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no such file: gone\.txt/);
  const binary = await circle(home, ['-p', 'x', '@blob.bin', workspace], {
    cwd: here,
  });
  assert.equal(binary.code, 2);
  assert.match(binary.stderr, /blob\.bin is not a text file/);
  assert.equal(endpoint.bodies.length, 1);
  // An image in the workspace goes as an attachment, which text cannot carry.
  const png = Buffer.from('89504e470d0a1a0a30303030', 'hex');
  writeFileSync(join(workspace, 'shot.png'), png);
  writeFileSync(join(here, 'far.png'), png);
  const image = await circle(home, ['-p', 'look', '@shot.png', workspace], {
    cwd: here,
  });
  assert.equal(image.code, 0, image.stderr);
  const content = (
    endpoint.bodies[1]!.messages as { role: string; content: unknown }[]
  ).at(-1)!.content as { type: string; image_url?: { url: string } }[];
  assert.equal(
    content.find((part) => part.type === 'image_url')?.image_url?.url,
    'data:image/png;base64,' + png.toString('base64'),
  );
  const far = await circle(home, ['-p', 'look', '@far.png', workspace], {
    cwd: here,
  });
  assert.equal(far.code, 2);
  assert.match(far.stderr, /far\.png is not a text file/);
  assert.equal(endpoint.bodies.length, 2);
});

test('the full-screen interface shows @path while the model gets the file text', async (t) => {
  const home = scratch(t);
  const here = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(here, 'notes.txt'), 'remember this\n');
  let saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  const app = new SessionApp(workspace, home, loadSettings(home));
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const model = new ScriptedModel([
    { message: { id: 'answer', role: 'assistant', content: 'seen' } },
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: app.settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  app.runtime = runtime;
  const full = 'review\n\n' + fileBlocks(['notes.txt'], workspace, here);
  await app.submit(full, full, false, 'review @notes.txt');
  const user = runtime.store
    .messages(runtime.session.id)
    .find((message) => message.role === 'user')!;
  assert.equal(user.display, 'review @notes.txt');
  assert.equal(
    user.content,
    'review\n\n<file path="notes.txt">\nremember this\n</file>',
  );
  assert.equal(model.requests[0]!.messages.at(-1)!.content, user.content);
  assert.equal(
    runtime.store.get(runtime.session.id)!.title,
    'review @notes.txt',
  );
});

test('the folder is the first word without spaces or the last word, and -p takes a folder as a flag', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'answer' }]);
  setUp(home, endpoint.base, [workspace]);
  // A message with spaces, then the folder.
  const last = await circle(home, ['what is here', workspace]);
  assert.equal(last.code, 0, last.stderr);
  assert.equal(userText(endpoint.bodies[0]!), 'what is here');
  assert.ok(systemText(endpoint.bodies[0]!).includes(workspace));
  // -p before a folder is a flag; the prompt is piped in.
  const piped = await circle(home, ['-p', workspace], {
    stdin: 'piped prompt\n',
  });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(userText(endpoint.bodies[1]!), 'piped prompt');
  assert.ok(systemText(endpoint.bodies[1]!).includes(workspace));
  // One word without spaces is a folder, so a typo is an error, not a message.
  const typo = await circle(home, ['-p', 'question', 'no-such-folder'], {
    cwd: workspace,
  });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /No such folder: .*no-such-folder/);
  assert.equal(endpoint.bodies.length, 2);
});

test('print mode sends each message as a turn and writes only the last answer', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [
    { content: 'first answer' },
    { content: 'second answer' },
  ]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, [
    '-p',
    'first question',
    workspace,
    'second question',
  ]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'second answer\n');
  assert.equal(userText(endpoint.bodies[0]!), 'first question');
  assert.equal(userText(endpoint.bodies[1]!), 'second question');
});

test('--list-models keeps the models that contain every word and marks the current one', async (t) => {
  const home = scratch(t);
  const endpoint = await gateway(
    t,
    [{ content: 'unused' }],
    ['alpha-mini', 'alpha-max', 'beta-max'],
  );
  setUp(home, endpoint.base, [], 'alpha-max');
  const all = await circle(home, ['--list-models']);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stdout, 'alpha-mini\nalpha-max  (current)\nbeta-max\n');
  const both = await circle(home, ['--list-models', 'MAX alpha']);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(both.stdout, 'alpha-max  (current)\n');
  const none = await circle(home, ['--list-models', 'gamma']);
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /no model matches 'gamma'/);
  const fresh = scratch(t);
  const unset = await circle(fresh, ['--list-models']);
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /not set up yet/);
});

test('options that cannot go together stop with exit code 2 before any request', async (t) => {
  for (const [args, message] of [
    [['--line', '--mode', 'json'], /--mode json and --line cannot go together/],
    [['--line', '--mode', 'rpc'], /--mode rpc and --line cannot go together/],
    [['-r', '--mode', 'rpc'], /-r opens a list/],
    [['-r', '--mode', 'json', 'hello there'], /-r opens a list/],
    [['--mode', 'rpc', 'hello there'], /--mode rpc takes its prompts/],
    [['--mode', 'rpc', '@notes.txt'], /--mode rpc takes its prompts/],
    [['--line', 'hello there'], /--line reads its messages/],
    [['--fork', 'a', '-c'], /--fork starts a new conversation/],
    [['--session-id', '-bad-'], /--session-id takes letters/],
  ] as const) {
    assert.throws(
      () => parseCli([...args]),
      (error) => error instanceof UsageError && message.test(error.message),
      args.join(' '),
    );
  }
  const home = scratch(t);
  const run = await circle(home, ['--line', '--mode', 'json']);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--mode json and --line cannot go together/);
});

test('parsing: -n collapses spaces and cuts to 80, @files are kept apart, a folder may come last', (t) => {
  const workspace = realpathSync(scratch(t));
  const options = parseCli([
    '-n',
    '  a   long\ttitle ' + 'x'.repeat(100),
    'review this',
    '@src/app.ts',
    workspace,
  ]);
  assert.equal(
    options.run.session_name,
    ('a long title ' + 'x'.repeat(100)).slice(0, 80),
  );
  assert.equal(options.workspace, workspace);
  assert.deepEqual(options.prompts, ['review this']);
  assert.deepEqual(options.files, ['src/app.ts']);
  // -p as a flag: the first word after the options is the prompt, the second the folder.
  const flag = parseCli(['-p', '-c', 'what changed?', workspace]);
  assert.deepEqual(flag.prompts, ['what changed?']);
  assert.equal(flag.workspace, workspace);
  // A single word is the folder even when it does not exist.
  const typo = parseCli(['--line', 'hello'], workspace);
  assert.equal(typo.workspace, join(workspace, 'hello'));
  assert.deepEqual(typo.prompts, []);
});

test('-n names the saved conversation with its spaces collapsed', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, [
    '--mode',
    'json',
    '-n',
    '  my   release\n notes  ',
    'write them',
    workspace,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const session = JSON.parse(run.stdout.split('\n')[0]!) as { id: string };
  const store = new CheckpointStore(home);
  try {
    assert.equal(store.get(session.id)!.title, 'my release notes');
  } finally {
    store.close();
  }
});

test('--verbose shows tool calls, calls not run, retries and tokens in print and line mode', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(workspace, 'notes.txt'), 'hello\n');
  const replies: Reply[] = [
    {
      status: 503,
      headers: { 'retry-after-ms': '100' },
      body: { error: { message: 'busy' } },
    },
    { call: { name: 'read_file', args: { file_path: 'notes.txt' } } },
    { call: { name: 'execute', args: { command: 'touch made.txt' } } },
    { content: 'done' },
  ];
  const endpoint = await gateway(t, replies);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, ['-p', 'look around', workspace, '--verbose']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'done\n');
  const lines = run.stderr.split('\n');
  assert.ok(lines.includes('  … server error, retry 1/6 in 0.1s'), run.stderr);
  assert.ok(lines.includes('● Read(notes.txt)'), run.stderr);
  assert.ok(lines.includes('● Bash(touch made.txt)'), run.stderr);
  assert.ok(
    lines.includes('  ⎿ Bash(touch made.txt) not run · needs --yolo'),
    run.stderr,
  );
  assert.ok(
    lines.includes(
      '↑ 3.6k · ↓ 102 · 1 call not run (use --yolo to allow commands and edits)',
    ),
    run.stderr,
  );
  // Without --verbose only the count of calls not run is written.
  const endpoint2 = await gateway(t, replies.slice(2));
  setUp(home, endpoint2.base, [workspace]);
  const quiet = await circle(home, ['-p', 'look around', workspace]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(
    quiet.stderr,
    '↑ 2.4k · ↓ 68 · 1 call not run (use --yolo to allow commands and edits)\n',
  );
  // Line mode takes --verbose too.
  const endpoint3 = await gateway(t, replies.slice(1));
  setUp(home, endpoint3.base, [workspace]);
  const line = await circle(home, ['--line', '--verbose', workspace], {
    stdin: 'look around\n',
  });
  assert.equal(line.code, 0, line.stderr);
  assert.equal(line.stdout, 'done\n');
  assert.match(line.stderr, /^● Read\(notes\.txt\)$/m);
  assert.match(line.stderr, /^ {2}⎿ Bash\(touch made\.txt\) not run/m);
  assert.match(line.stderr, /^↑ 3\.6k · ↓ 102 · 1 call not run/m);
});

test('stdin: without a prompt the read waits for the end; with one it waits three seconds', async (t) => {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const input = new PassThrough();
  const warnings: string[] = [];
  let read: string | undefined;
  void pipedText(undefined, input, (text) => warnings.push(text)).then(
    (text) => (read = text),
  );
  mock.timers.tick(10 * 60 * 1000);
  await new Promise((done) => setImmediate(done));
  assert.equal(read, undefined);
  input.end('late input');
  await new Promise((done) => setImmediate(done));
  assert.equal(read, 'late input');
  const open = new PassThrough();
  let waited: string | undefined;
  void pipedText(3000, open, (text) => warnings.push(text)).then(
    (text) => (waited = text),
  );
  mock.timers.tick(3000);
  await new Promise((done) => setImmediate(done));
  assert.equal(waited, '');
  assert.deepEqual(warnings, [
    'circle: nothing arrived on stdin within 3s; going on without it (use </dev/null to skip the wait)\n',
  ]);
});

test('a prompt goes on without stdin that stays open, and the folder must be trusted without a terminal', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const untrusted = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const open = await circle(home, ['-p', 'hello', workspace], { stdin: null });
  assert.equal(open.code, 0, open.stderr);
  assert.match(open.stderr, /nothing arrived on stdin within 3s/);
  assert.equal(userText(endpoint.bodies[0]!), 'hello');
  const refused = await circle(home, ['-p', 'hello', untrusted]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /This folder is not trusted yet/);
  const fresh = scratch(t);
  const unset = await circle(fresh, ['-p', 'hello', workspace]);
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /Circle is not set up yet/);
  assert.equal(endpoint.bodies.length, 1);
});

test('the trust question asked line by line saves the folder, and no keeps it untrusted', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const settings = defaultSettings();
  saveSettings(settings, home);
  const answer = async (text: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (data) => (shown += data));
    input.end(text);
    const result = await runLineTrust(
      settings,
      workspace,
      home,
      terminalPrompter(input, output),
    );
    return { result, shown };
  };
  const no = await answer('n\n');
  assert.equal(no.result, undefined);
  assert.match(no.shown, /Trust this folder\?/);
  assert.match(no.shown, /Not trusted\./);
  assert.deepEqual(loadSettings(home).trusted_folders, []);
  const yes = await answer('yes\n');
  assert.deepEqual(yes.result?.trusted_folders, [workspace]);
  assert.deepEqual(loadSettings(home).trusted_folders, [workspace]);
});

// A terminal on standard input without the full-screen interface (`-p` in a terminal): the
// setup and trust questions are asked line by line. `script` gives the child a terminal.
test(
  'with a terminal but no full-screen interface, setup and trust are asked line by line',
  { skip: process.platform !== 'darwin' && 'uses the BSD script command' },
  async (t) => {
    // macOS script wants a pipe, not the socket node gives a child, on its standard input.
    const viaScript = ['-c', 'cat | exec script -q /dev/null "$@"', 'sh'];
    if (
      spawnSync('/bin/sh', [...viaScript, 'sh', '-c', 'exit 3'], { input: '' })
        .status !== 3
    )
      return t.skip('script is not available');
    const home = scratch(t);
    const workspace = realpathSync(scratch(t));
    const endpoint = await gateway(
      t,
      [{ content: 'set up and answered' }],
      ['first-model', 'second-model'],
    );
    const child = spawn(
      '/bin/sh',
      [
        ...viaScript,
        process.execPath,
        '--import',
        TSX,
        CLI,
        '-p',
        'hello',
        workspace,
      ],
      {
        env: {
          ...process.env,
          CIRCLE_HOME: home,
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_JOB_WAIT: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const answers: [RegExp, string][] = [
      [/API URL: \s*$/, endpoint.base + '/v1\r'],
      [/API KEY: \s*$/, 'secret-key\r'],
      [/model: \s*$/, '2\r'],
      [/trust it\? \[y\/N\]: \s*$/, 'y\r'],
    ];
    child.stdout.on('data', (data) => {
      output += data;
      const next = answers[0];
      if (next && next[0].test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) {
        answers.shift();
        child.stdin.write(next[1]);
        if (!answers.length) child.stdin.end();
      }
    });
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill(), 30000);
      child.once('close', (status) => {
        clearTimeout(timer);
        done(status);
      });
    });
    assert.equal(answers.length, 0, output);
    assert.equal(code, 0, output);
    assert.match(output, /discovered 2 models \(openai\)/);
    assert.match(output, /set up and answered/);
    assert.ok(!output.includes('secret-key'), 'the key is not echoed');
    const saved = loadSettings(home);
    assert.equal(saved.auth.base_url, endpoint.base + '/v1');
    assert.equal(saved.auth.model, 'second-model');
    assert.deepEqual(saved.trusted_folders, [workspace]);
    assert.equal(loadCredentials(home).api_key, 'secret-key');
    assert.equal(endpoint.bodies[0]!.model, 'second-model');
    assert.equal(endpoint.keys.at(-1), 'Bearer secret-key');
  },
);
