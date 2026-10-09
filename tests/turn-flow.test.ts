import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { resumeHint, shellWord } from '../src/tui/exit_lines.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, loadSettings } from '../src/settings.js';
import { defaultRunOptions } from '../src/run_options.js';
import { ScriptedModel } from '../src/testing.js';
import { dialogRows } from '../src/ink/components/dialog_card.js';
import { stripAnsi } from '../src/ink/string_width.js';
import {
  emptyUsage,
  type ChatModel,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

type Reply =
  Partial<ModelResponse> | ((request: ModelRequest) => Promise<ModelResponse>);
type Context = Parameters<typeof scratch>[0];

async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(5);
  }
}
function response(
  id: string,
  content: string,
  calls: ToolCall[] = [],
): ModelResponse {
  return {
    message: { id, role: 'assistant', content, tool_calls: calls },
    usage: emptyUsage(),
  };
}
const answer = (content: string): Reply => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});
const task = (id: string, description: string): ToolCall => ({
  id,
  name: 'task',
  args: { description, subagent_type: 'general-purpose' },
});
// Whose request it is: the session's own (`go`) or a subagent's (its task description).
const firstUser = (request: ModelRequest): string =>
  request.messages.find(
    (message) => message.role === 'user' && !message.internal,
  )!.content;
const replied = (request: ModelRequest): boolean =>
  request.messages.some((message) => message.role === 'tool');
// A model call that only ends when the turn is stopped.
const blocked = (request: ModelRequest): Promise<ModelResponse> =>
  new Promise((_resolve, reject) => {
    request.signal.throwIfAborted();
    request.signal.addEventListener('abort', () =>
      reject(request.signal.reason),
    );
  });
// The tool results that follow the reply with `id`, in the order they were stored.
function resultsAfter(messages: Message[], id: string): Message[] {
  const at = messages.findIndex((message) => message.id === id);
  assert.ok(at >= 0, `reply ${id} is in the conversation`);
  const results: Message[] = [];
  for (const message of messages.slice(at + 1)) {
    if (message.role !== 'tool') break;
    results.push(message);
  }
  return results;
}

/** A full-screen session without a terminal: the real runtime, store and keys. */
async function session(
  t: Context,
  model: ChatModel,
  options: { workspace?: string } = {},
) {
  const home = scratch(t);
  const workspace = options.workspace ?? scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  const log: [string, unknown][] = [];
  app.terminal = {
    platform: 'darwin',
    write: (text) => log.push(['write', text]),
    input: (on) => log.push(['input', on]),
    kill: (signal) => log.push(['kill', signal]),
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
    await runtime.close();
  });
  const key = (
    name: string,
    char = Array.from(name).length === 1 ? name : '',
  ) => ui.handle({ type: 'key', key: name, char });
  const type = (text: string): void => {
    for (const char of text) key(char, char);
  };
  const screen = (): string => {
    ui.repaint();
    return rendered.map(stripAnsi).join('\n');
  };
  const card = (): string =>
    dialogRows(app.state.dialog!, 100, 80).map(stripAnsi).join('\n');
  return { app, ui, runtime, home, workspace, log, key, type, screen, card };
}

test('task calls in one reply run their subagents at the same time, the next request has the results in call order, and each subagent stops only the jobs it started', async (t) => {
  const root = scratch(t);
  const hold = join(root, 'hold.cjs');
  writeFileSync(hold, 'setTimeout(() => {}, 30000);');
  const command = `"${process.execPath}" "${hold}"`;
  let inFlight = 0;
  let peak = 0;
  const arrived = new Set<string>();
  let alphaJobWhenBetaEnded = '';
  let followUp: ModelRequest | undefined;
  let runtime!: AgentRuntime;
  const jobOf = (name: string) => {
    const child = runtime.store
      .children(runtime.session.id)
      .find((session) => session.title === `general-purpose: ${name}`);
    return runtime.jobs.list().find((job) => job.parent === child?.id);
  };
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = firstUser(request);
      if (user === 'alpha' || user === 'beta') {
        // Each subagent first starts a command of its own in the background
        if (!replied(request))
          return response(`${user}-run`, '', [
            {
              id: `${user}-job`,
              name: 'execute',
              args: { command, background: true },
            },
          ]);
        inFlight++;
        peak = Math.max(peak, inFlight);
        arrived.add(user);
        try {
          // Neither answers until both are asking: one after another never gets here
          await until(() => arrived.size === 2, 3000);
          // alpha, the first call, ends last
          if (user === 'alpha') {
            await until(() => jobOf('beta')?.status === 'stopped');
            alphaJobWhenBetaEnded = jobOf('alpha')!.status;
          }
        } finally {
          inFlight--;
        }
        return response(`${user}-end`, `${user} report`);
      }
      if (!replied(request))
        return response('main-start', '', [
          task('t-alpha', 'alpha'),
          task('t-beta', 'beta'),
        ]);
      followUp = request;
      return response('main-end', 'both reported');
    },
  };
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  assert.equal((await runtime.harness.run('go')).answer, 'both reported');
  assert.equal(peak, 2, 'both subagents were waiting on the model at once');
  // The next request and the stored conversation have the results in call order
  for (const messages of [
    followUp!.messages,
    runtime.store.messages(runtime.session.id),
  ])
    assert.deepEqual(
      resultsAfter(messages, 'main-start').map((message) => [
        message.tool_call_id,
        message.content,
      ]),
      [
        ['t-alpha', 'alpha report'],
        ['t-beta', 'beta report'],
      ],
    );
  // beta's end stopped beta's command, not alpha's; alpha's stopped when alpha ended
  assert.equal(alphaJobWhenBetaEnded, 'running');
  assert.equal(jobOf('alpha')!.status, 'stopped');
  assert.equal(jobOf('beta')!.status, 'stopped');
});

test('the cards of subagents running at the same time come one at a time while the strip shows both', async (t) => {
  const arrived = new Set<string>();
  let followUp: ModelRequest | undefined;
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = firstUser(request);
      if (user === 'alpha' || user === 'beta') {
        if (replied(request)) return response(`${user}-end`, `${user} wrote`);
        arrived.add(user);
        await until(() => arrived.size === 2, 3000);
        return response(`${user}-write`, '', [
          {
            id: `${user}-write`,
            name: 'write_file',
            args: { file_path: `${user}.txt`, content: user },
          },
        ]);
      }
      if (!replied(request))
        return response('main-start', '', [
          task('t-alpha', 'alpha'),
          task('t-beta', 'beta'),
        ]);
      followUp = request;
      return response('main-end', 'both written');
    },
  };
  const s = await session(t, model);
  const run = s.runtime.harness.run('go');
  await until(() => Boolean(s.app.state.dialog));
  assert.match(s.screen(), /Agents · 2/);
  // Both asked; one card is up and the other waits for it
  await until(() =>
    s.app.state.subagents!.every((agent) => agent.state === 'waiting'),
  );
  const first = s.card();
  assert.match(first, /Write needs your permission/);
  const [mine, other] = /alpha\.txt/.test(first)
    ? ['alpha', 'beta']
    : ['beta', 'alpha'];
  assert.doesNotMatch(first, new RegExp(`${other}\\.txt`));
  s.key('y');
  await until(() => existsSync(join(s.workspace, `${mine}.txt`)));
  await until(() => /Write needs your permission/.test(s.card()));
  assert.match(s.card(), new RegExp(`${other}\\.txt`));
  assert.equal(existsSync(join(s.workspace, `${other}.txt`)), false);
  s.key('y');
  assert.equal((await run).answer, 'both written');
  assert.equal(readFileSync(join(s.workspace, `${other}.txt`), 'utf8'), other);
  assert.deepEqual(
    resultsAfter(followUp!.messages, 'main-start').map((message) => [
      message.tool_call_id,
      message.content,
    ]),
    [
      ['t-alpha', 'alpha wrote'],
      ['t-beta', 'beta wrote'],
    ],
  );
});

test('esc stops subagents running at the same time: both end, their results are stored in call order and no request follows', async (t) => {
  const arrived = new Set<string>();
  let requests = 0;
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      requests++;
      const user = firstUser(request);
      if (user === 'alpha' || user === 'beta') {
        arrived.add(user);
        return blocked(request);
      }
      return response('main-start', '', [
        task('t-alpha', 'alpha'),
        task('t-beta', 'beta'),
      ]);
    },
  };
  const s = await session(t, model);
  const run = s.runtime.harness.run('go');
  await until(() => arrived.size === 2);
  const screen = s.screen();
  assert.match(screen, /Agents · 2/);
  // both calls' lamps are lit, not only the first one's
  assert.equal(
    screen.split('\n').filter((line) => /^ ● Agent\(/.test(line)).length,
    2,
    screen,
  );
  s.key('escape');
  await assert.rejects(run, /Interrupted/);
  await until(() => !s.runtime.busy);
  assert.deepEqual(
    resultsAfter(
      s.runtime.store.messages(s.runtime.session.id),
      'main-start',
    ).map((message) => [message.tool_call_id, message.status, message.content]),
    [
      ['t-alpha', 'error', 'Interrupted'],
      ['t-beta', 'error', 'Interrupted'],
    ],
  );
  await delay(100);
  assert.equal(requests, 3);
  assert.ok(s.app.state.subagents!.every((agent) => agent.state === 'error'));
  assert.doesNotMatch(s.screen(), /Agents ·/);
});

test('esc sends the messages the turn had not read as the next turns, one each, steering first', async (t) => {
  const model = new ScriptedModel([
    blocked,
    answer('read steer one'),
    answer('read steer two'),
    answer('read the follow-up'),
  ]);
  const s = await session(t, model);
  const first = s.app.submit('first');
  await until(() => model.requests.length === 1);
  s.type('steer one');
  s.key('enter');
  s.type('steer two');
  s.key('enter');
  s.type('later');
  s.key('ctrl+q');
  s.screen();
  assert.deepEqual(s.app.state.queue, {
    steering: ['steer one', 'steer two'],
    followUp: ['later'],
  });
  s.key('escape');
  await first;
  await until(() => model.requests.length === 4 && !s.runtime.busy);
  const last = (request: number) =>
    model.requests[request]!.messages.filter(
      (message) => message.role === 'user',
    ).map((message) => message.content);
  assert.deepEqual(last(1), ['first', 'steer one']);
  assert.deepEqual(last(2), ['first', 'steer one', 'steer two']);
  assert.deepEqual(last(3), ['first', 'steer one', 'steer two', 'later']);
  // each was a turn of its own: the answer to one came before the next message
  assert.deepEqual(
    model.requests[3]!.messages.filter(
      (message) => message.role === 'assistant',
    ).map((message) => message.content),
    ['read steer one', 'read steer two'],
  );
  assert.deepEqual(s.runtime.harness.queuedMessages, {
    steering: [],
    followUp: [],
  });
});

test('esc with nothing waiting starts no turn', async (t) => {
  const model = new ScriptedModel([blocked, answer('never')]);
  const s = await session(t, model);
  const first = s.app.submit('first');
  await until(() => model.requests.length === 1);
  s.key('escape');
  await first;
  await delay(100);
  assert.equal(model.requests.length, 1);
  assert.equal(s.runtime.busy, false);
});

test('leaving prints the stopped jobs and then the command that reopens the session, after the terminal is restored', async (t) => {
  const workspace = join(scratch(t), 'my work');
  mkdirSync(workspace);
  const s = await session(t, new ScriptedModel([answer('hello')]), {
    workspace,
  });
  s.ui.theme.close = () => {};
  await s.app.submit('hi');
  s.runtime.jobs.startAgent(
    'waits',
    { sessionId: s.runtime.session.id, startedBy: 'model' },
    (signal) =>
      new Promise<string>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  );
  s.log.length = 0;
  await s.app.close();
  const restore = s.log.findIndex(
    ([kind, text]) => kind === 'write' && String(text).includes('\x1b[?1049l'),
  );
  assert.ok(restore >= 0, 'the screen was given back');
  assert.ok(
    s.log.findIndex(([kind, on]) => kind === 'input' && on === false) < restore,
  );
  assert.deepEqual(s.log.slice(restore + 1), [
    ['write', '1 background job stopped\n'],
    [
      'write',
      `To resume this session: circle --session ${s.runtime.session.id} '${workspace}'\n`,
    ],
  ]);
});

test('leaving an empty session prints no command', async (t) => {
  const s = await session(t, new ScriptedModel([]));
  s.ui.theme.close = () => {};
  s.log.length = 0;
  await s.app.close();
  assert.deepEqual(
    s.log.filter(([kind]) => kind === 'write').length,
    1,
    'only the restore sequence',
  );
});

test('the resume command names the folder only from elsewhere, quoted for the shell, and is empty without a saved session', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([answer('ok')]),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  assert.equal(resumeHint(runtime, workspace, workspace), '', 'nothing said');
  runtime.store.rename(runtime.session.id, 'named');
  assert.equal(
    resumeHint(runtime, workspace, workspace),
    `To resume this session: circle --session ${runtime.session.id}`,
  );
  assert.equal(
    resumeHint(runtime, workspace, home, 'win32'),
    `To resume this session: circle --session ${runtime.session.id} ${workspace}`,
  );
  assert.equal(shellWord('/tmp/plain'), '/tmp/plain');
  assert.equal(shellWord('/tmp/with space'), "'/tmp/with space'");
  assert.equal(shellWord("it's"), `'it'"'"'s'`);
  assert.equal(
    shellWord('C:\\Program Files\\x\\', 'win32'),
    '"C:\\Program Files\\x\\\\"',
  );
  assert.equal(shellWord('C:\\plain', 'win32'), 'C:\\plain');
  const memory = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([answer('ok')]),
    headless: true,
    run: { ...defaultRunOptions(), no_session: true },
  });
  cleanup(t, () => memory.close());
  await memory.harness.run('hi');
  assert.equal(resumeHint(memory, workspace, home), '');
});

test('setup in the full-screen interface saves the URL that answered, and requests then reach it', async (t) => {
  const seen: string[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      for await (const _chunk of request);
      seen.push(`${request.method} ${request.url}`);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'm-one' }] }));
      } else if (
        request.method === 'POST' &&
        request.url === '/v1/chat/completions'
      ) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: 'pong' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"not here"}');
      }
    },
  );
  await new Promise<void>((ready) =>
    server.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const home = scratch(t);
  const workspace = scratch(t);
  const app = new SessionApp(workspace, home, defaultSettings());
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const key = (
    name: string,
    char = Array.from(name).length === 1 ? name : '',
  ) => ui.handle({ type: 'key', key: name, char });
  const fill = async (body: RegExp, text: string): Promise<void> => {
    await until(() => body.test(app.state.dialog?.body ?? ''));
    app.state.dialog!.input = text;
    key('enter');
  };
  const done = app.initialize();
  await fill(/API base URL/, base);
  await fill(/API key/, 'test-key');
  await fill(/^Model ID \(m-one\)$/, 'm-one');
  await until(() => app.state.dialog?.title === 'trust');
  key('y');
  assert.equal(await done, true);
  assert.ok(seen.includes('GET /models') && seen.includes('GET /v1/models'));
  const saved = loadSettings(home);
  assert.equal(saved.auth.base_url, base + '/v1');
  assert.equal(saved.auth.protocol, 'openai');
  assert.equal(saved.auth.model, 'm-one');
  const reply = await new GatewayModel(saved, home).complete({
    system: 'system',
    messages: [{ id: 'ping', role: 'user', content: 'ping' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  assert.equal(reply.message.content, 'pong');
  assert.equal(seen.at(-1), 'POST /v1/chat/completions');
});
