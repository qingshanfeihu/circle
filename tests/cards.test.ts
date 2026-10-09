import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { defaultSettings } from '../src/settings.js';
import { defaultPolicy } from '../src/approvals.js';
import { ScriptedModel } from '../src/testing.js';
import { createRequest, pollAnswer } from '../src/secret_prompt.js';
import { panelQuestion } from '../src/questions.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
  setPalette,
} from '../src/ink/theme.js';
import { dialogRows } from '../src/ink/components/dialog_card.js';
import { ApprovalCard } from '../src/ink/components/approval_card.js';
import { QuestionCard } from '../src/ink/components/question_card.js';
import {
  approvalBody,
  approvalPreview,
  approvalRequest,
} from '../src/tui/approval_preview.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

type Reply =
  Partial<ModelResponse> | ((request: ModelRequest) => Promise<ModelResponse>);
const calls = (id: string, ...toolCalls: ToolCall[]): Reply => ({
  message: { id, role: 'assistant', content: '', tool_calls: toolCalls },
});
const answer = (id: string, content: string): Reply => ({
  message: { id, role: 'assistant', content },
});
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(5);
  }
}
/** A SessionApp whose runtime asks through the app's own card hooks, driven by keys. */
function session(t: Parameters<typeof scratch>[0], replies: Reply[]) {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    ...ui.cardHooks(),
  });
  app.runtime = runtime;
  cleanup(t, () => runtime.close());
  cleanup(t, () => {
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  let shown = 0;
  const showCard = ui.showCard.bind(ui);
  ui.showCard = (...args: unknown[]) => {
    shown++;
    return showCard(...args);
  };
  const key = (name: string): void =>
    ui.handle({
      type: 'key',
      key: name,
      char: Array.from(name).length === 1 ? name : '',
    });
  const type = (text: string): void => {
    for (const char of text) key(char);
  };
  const screen = (): string => {
    ui.repaint();
    return rendered.map(stripAnsi).join('\n');
  };
  // the card as a tall terminal shows it, so nothing in the body is cut
  const card = (): string =>
    dialogRows(app.state.dialog!, 100, 80).map(stripAnsi).join('\n');
  const toolResult = (request: number, id: string): Message =>
    model.requests[request]!.messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === id,
    )!;
  return {
    root,
    app,
    runtime,
    model,
    key,
    type,
    screen,
    card,
    toolResult,
    shown: () => shown,
  };
}

test('an approval card shows the change as a diff instead of JSON, swallows stray letters, and Reject and explain sends the reason to the model', async (t) => {
  const s = session(t, [
    calls('a1', {
      id: 'edit',
      name: 'edit_file',
      args: { file_path: 'notes.txt', old_string: 'two', new_string: 'TWO' },
    }),
    answer('a2', 'understood'),
  ]);
  writeFileSync(join(s.root, 'notes.txt'), 'one\ntwo\nthree\n');
  const run = s.runtime.harness.run('change it');
  await until(() => Boolean(s.app.state.dialog));
  const card = s.card();
  assert.match(card, /● Edit needs your permission/);
  assert.match(card, /│ {3}notes\.txt/);
  assert.match(card, /│ {3}\+1 -1/);
  assert.match(card, /@@ -1,3 \+1,3 @@/);
  assert.match(card, / {3}1 {2}one/);
  assert.match(card, /- {2}2 {2}two/);
  assert.match(card, /\+ {2}2 {2}TWO/);
  assert.match(card, /changes files in the workspace/);
  assert.match(card, /1 Allow once/);
  assert.match(
    card,
    /2 Allow file changes inside the workspace for this session/,
  );
  assert.match(card, /3 Reject and explain/);
  assert.ok(!card.includes('old_string'), card);
  assert.ok(!card.includes('{"'), card);
  // letters meant for the draft do not answer the card
  s.type('xqz');
  assert.ok(s.app.state.dialog);
  assert.equal(s.app.state.dialog.input, undefined);
  // the reason row, then esc back to the options: what was typed there goes
  s.key('3');
  assert.equal(s.app.state.dialog!.input, '');
  s.type('wrong');
  s.key('escape');
  assert.ok(s.app.state.dialog);
  assert.equal(s.app.state.dialog.input, undefined);
  assert.equal(s.app.state.dialog!.focus, 2);
  s.key('down');
  assert.equal(s.app.state.dialog!.focus, 0);
  s.key('j');
  assert.equal(s.app.state.dialog!.focus, 1);
  s.key('k');
  s.key('up');
  assert.equal(s.app.state.dialog!.focus, 2);
  s.key('enter');
  assert.equal(s.app.state.dialog!.input, '');
  s.type('use sedd');
  s.key('backspace');
  (s.app as any).handle({ type: 'paste', text: ' instead' });
  assert.match(s.screen(), /› use sed instead▏/);
  s.key('enter');
  await run;
  assert.equal(s.app.state.dialog, undefined);
  assert.equal(
    readFileSync(join(s.root, 'notes.txt'), 'utf8'),
    'one\ntwo\nthree\n',
  );
  const result = s.toolResult(1, 'edit');
  assert.equal(result.status, 'error');
  assert.equal(
    result.content,
    'The user rejected this tool call. The user said: use sed instead',
  );
});

test('approval keys: a allows the kind of call for the session, esc and an empty reason reject plainly, and ctrl+c stops the turn instead of answering', async (t) => {
  const s = session(t, [
    calls(
      'a1',
      {
        id: 'w1',
        name: 'write_file',
        args: { file_path: 'a.txt', content: 'A\n' },
      },
      {
        id: 'w2',
        name: 'write_file',
        args: { file_path: 'b.txt', content: 'B\n' },
      },
    ),
    calls('a2', {
      id: 'x1',
      name: 'execute',
      args: { command: 'echo hi > out.txt' },
    }),
    calls('a3', {
      id: 'x2',
      name: 'execute',
      args: { command: 'echo again > out.txt' },
    }),
    calls('a4', {
      id: 'x3',
      name: 'execute',
      args: { command: 'echo last > out.txt' },
    }),
    answer('a5', 'stopped there'),
  ]);
  const run = s.runtime.harness.run('write two files');
  await until(() => Boolean(s.app.state.dialog));
  const card = s.card();
  assert.match(card, /Write needs your permission/);
  assert.match(card, /a\.txt/);
  assert.match(card, /new file, 1 line/);
  assert.match(card, /\+ {2}1 {2}A/);
  s.key('a');
  // the second write is covered by the rule: no second card
  await until(() => Boolean(s.app.state.dialog));
  assert.equal(s.shown(), 2);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'A\n');
  assert.equal(readFileSync(join(s.root, 'b.txt'), 'utf8'), 'B\n');
  assert.deepEqual(
    s.runtime.policy.store.rules(s.runtime.session.id).map((rule) => rule.tool),
    ['write_file'],
  );
  // the command card: the command itself, and its own options
  const command = s.card();
  assert.match(command, /Bash needs your permission/);
  assert.match(command, /│ {3}\$ echo hi > out\.txt/);
  assert.match(command, /Allow this exact command for this session/);
  s.key('escape');
  await until(() => s.model.requests.length === 3 && !!s.app.state.dialog);
  assert.equal(existsSync(join(s.root, 'out.txt')), false);
  assert.equal(
    s.toolResult(2, 'x1').content,
    'The user rejected this tool call.',
  );
  // the reason row left empty: a plain rejection
  s.key(String(s.app.state.dialog!.options.length));
  assert.equal(s.app.state.dialog!.input, '');
  s.type('   ');
  s.key('enter');
  await until(() => s.model.requests.length === 4 && !!s.app.state.dialog);
  assert.equal(
    s.toolResult(3, 'x2').content,
    'The user rejected this tool call.',
  );
  // ctrl+c on a card stops the turn: no answer, no further request
  s.key('ctrl+c');
  await assert.rejects(run, /Interrupted/);
  assert.equal(s.app.state.dialog, undefined);
  assert.equal(s.model.requests.length, 4);
  assert.equal(existsSync(join(s.root, 'out.txt')), false);
});

test("a background agent's card is titled with the job, ctrl+c leaves it up, and the reason reaches that agent", async (t) => {
  // one model for the session and its subagent: each request is answered by whose it is
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    const user = request.messages.find(
      (message) => message.role === 'user' && !message.internal,
    )!.content;
    const replied = request.messages.some((message) => message.role === 'tool');
    const child = user === 'tidy up';
    const call: ToolCall = child
      ? {
          id: 'child-write',
          name: 'write_file',
          args: { file_path: 'c.txt', content: 'C\n' },
        }
      : {
          id: 'task',
          name: 'task',
          args: {
            description: 'tidy up',
            subagent_type: 'general-purpose',
            background: true,
          },
        };
    const message: Message = replied
      ? {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: child ? 'left it' : 'started',
        }
      : {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          tool_calls: [call],
        };
    return { message, usage: emptyUsage() };
  };
  const s = session(
    t,
    Array.from({ length: 6 }, () => route),
  );
  assert.equal((await s.runtime.harness.run('start')).answer, 'started');
  await until(() => Boolean(s.app.state.dialog));
  assert.match(
    s.app.state.dialog!.title,
    /^j\d+ general-purpose · Write needs your permission$/,
  );
  // ctrl+c does not answer a background agent's card
  s.key('ctrl+c');
  assert.ok(s.app.state.dialog);
  s.key(String(s.app.state.dialog!.options.length));
  s.type('not now');
  s.key('enter');
  await until(() =>
    s.runtime.jobs.list().every((job) => job.status !== 'running'),
  );
  const child = s.model.requests.find((request) =>
    request.messages.some(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'child-write',
    ),
  )!;
  assert.equal(
    child.messages.find((message) => message.tool_call_id === 'child-write')!
      .content,
    'The user rejected this tool call. The user said: not now',
  );
  assert.equal(existsSync(join(s.root, 'c.txt')), false);
});

test('a card waits until typing has paused for a second, keys typed meanwhile stay in the draft, and the draft and its cursor come back after the card', async (t) => {
  const s = session(t, [
    calls('a1', {
      id: 'w1',
      name: 'write_file',
      args: { file_path: 'x.txt', content: 'X\n' },
    }),
    answer('a2', 'written'),
  ]);
  s.type('hello');
  s.key('left');
  s.key('left');
  let waiting = false;
  s.runtime.bus.subscribe((event) => {
    if (event.kind === 'tool_waiting') waiting = true;
  });
  const run = s.runtime.harness.run('write it');
  await until(() => waiting);
  // keys that would answer the card are still typing for the draft
  s.type('n');
  await delay(200);
  assert.equal(s.app.state.dialog, undefined);
  s.type('y');
  const last = Date.now();
  assert.equal(s.app.state.draft, 'helnylo');
  assert.match(s.screen(), /› helny▏lo/);
  await until(() => Boolean(s.app.state.dialog), 3000);
  assert.ok(Date.now() - last >= 950, `${Date.now() - last}ms`);
  // the card has the frame; the draft is set aside, not lost
  assert.equal(s.app.state.draft, '');
  assert.doesNotMatch(s.screen(), /helnylo|helny▏lo/);
  s.key('y');
  await run;
  assert.equal(readFileSync(join(s.root, 'x.txt'), 'utf8'), 'X\n');
  assert.equal(s.app.state.draft, 'helnylo');
  assert.equal(s.app.state.draftCursor, 5);
  assert.match(s.screen(), /› helny▏lo/);
});

test('several questions share one card, and esc asks before it drops a choice or the answers', async (t) => {
  const s = session(t, [
    calls('a1', {
      id: 'q1',
      name: 'question',
      args: {
        questions: [
          {
            question: 'Which database?',
            header: 'storage',
            options: ['postgres', { label: 'sqlite', description: 'one file' }],
          },
          {
            question: 'Which tests?',
            options: ['unit', 'e2e'],
            multiple: true,
          },
        ],
      },
    }),
    answer('a2', 'sqlite with unit and e2e'),
    calls('a3', {
      id: 'q2',
      name: 'question',
      args: {
        questions: [
          { question: 'Deploy now?', options: ['yes', 'no'] },
          { question: 'Where?', options: ['eu', 'us'] },
        ],
      },
    }),
    answer('a4', 'not deploying'),
  ]);
  const first = s.runtime.harness.run('plan it');
  await until(() => Boolean(s.app.state.dialog));
  let card = s.card();
  assert.match(card, /The model has a question · 1\/2/);
  assert.match(card, /Which database\?/);
  assert.match(card, /storage/);
  assert.match(card, /2 sqlite — one file/);
  assert.match(card, /o Type your own/);
  s.key('down');
  s.key('escape');
  assert.ok(s.app.state.dialog, 'esc warned instead of cancelling');
  assert.match(s.card(), /Not chosen yet\. Press enter to choose/);
  s.key('enter');
  card = s.card();
  assert.match(card, /The model has a question · 2\/2/);
  assert.match(card, /Which tests\?/);
  assert.match(card, /1 \[ \] unit/);
  s.key(' ');
  s.key('down');
  s.key(' ');
  assert.match(s.card(), /1 \[x\] unit[\s\S]*2 \[x\] e2e/);
  // back to the first question and forward again keeps the answers
  s.key('left');
  assert.match(s.card(), /1\/2/);
  s.key('tab');
  s.key('enter');
  await first;
  const answered = s.toolResult(1, 'q1').content;
  assert.deepEqual(JSON.parse(answered.slice(answered.indexOf('\n') + 1)), [
    { question: 'Which database?', answer: ['sqlite'] },
    { question: 'Which tests?', answer: ['unit', 'e2e'] },
  ]);
  const second = s.runtime.harness.run('deploy?');
  await until(() => Boolean(s.app.state.dialog));
  s.key('1');
  assert.match(s.card(), /2\/2/);
  s.key('escape');
  assert.match(s.card(), /1 answered\. Press esc again to drop them all\./);
  s.key('escape');
  await second;
  assert.match(
    s.toolResult(3, 'q2').content,
    /^The user closed the question panel without answering\./,
  );
});

test('a typed answer is one more entry, an empty one is refused, and a long question folds behind ctrl+o', () => {
  const card = new QuestionCard([
    panelQuestion({
      question: Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n'),
      options: ['a', 'b'],
      multiple: true,
    }),
  ]);
  let text = dialogRows(card.state(), 80, 40).map(stripAnsi).join('\n');
  assert.match(text, /line 4\s*│[\s\S]*… \+4 lines · ctrl\+o[\s\S]*line 9/);
  assert.doesNotMatch(text, /line 5/);
  card.handle('ctrl+o', '');
  assert.match(
    dialogRows(card.state(), 80, 40).map(stripAnsi).join('\n'),
    /line 5/,
  );
  card.handle('1', '1');
  card.handle('o', 'o');
  assert.equal(card.input, '');
  assert.equal(card.handle('enter', ''), undefined);
  text = dialogRows(card.state(), 80, 40).map(stripAnsi).join('\n');
  assert.match(text, /An answer can't be empty/);
  card.paste('my own\nchoice');
  assert.deepEqual(card.handle('enter', ''), {
    answer: [['a', 'my own choice']],
  });
});

test('a secret is typed masked and capped, an empty one is refused, and the draft comes back', async (t) => {
  const s = session(t, []);
  const request = createRequest(s.root, {
    question: 'device password',
    key: 'DEVICE_PASSWORD',
    target_file: join(s.root, 'device.env'),
  });
  const value = pollAnswer(
    s.root,
    request.id,
    new AbortController().signal,
    10000,
  );
  s.type('draft');
  s.key('ctrl+s');
  await until(() => Boolean(s.app.state.dialog));
  assert.deepEqual(s.app.state.dialog!.options, ['enter secret', 'cancel']);
  s.key('enter');
  await until(() => s.app.state.dialog?.masked === true);
  s.key('enter');
  assert.ok(s.app.state.dialog, 'an empty secret is refused');
  assert.match(s.card(), /A secret can't be empty\./);
  s.type('pw-1');
  const screen = s.screen();
  assert.match(screen, /› ••••▏/);
  assert.ok(!screen.includes('pw-1'));
  (s.app as any).handle({ type: 'paste', text: 'x'.repeat(600) });
  s.key('enter');
  const collected = await value;
  assert.equal(collected.length, 512);
  assert.ok(collected.startsWith('pw-1x'));
  await until(() => !s.app.state.dialog);
  assert.equal(s.app.state.draft, 'draft');
});

test('cards keep their width on dark and light palettes, wrap a command at spaces, tint the asking tool, and keep the options on a short screen', (t) => {
  const original = palette();
  t.after(() => setPalette(original));
  const root = scratch(t);
  const policy = defaultPolicy(root, root);
  const command =
    'python3 -m pytest tests/test_payments.py -k "refund and not slow" --maxfail=1 && echo finished every step';
  const call = { id: 'c', name: 'execute', args: { command } };
  for (const colours of [
    buildPalette(...DEFAULT_DARK),
    buildPalette(...DEFAULT_LIGHT),
  ]) {
    setPalette(colours);
    const card = new ApprovalCard(
      approvalRequest(call, policy.review('execute', { command })),
    );
    const rows = dialogRows(card.state(), 48, 40);
    for (const row of rows) assert.equal(stringWidth(row), 48, row);
    const plain = rows.map((row) => stripAnsi(row).slice(1, -1));
    const blank = plain.findIndex((row, index) => index > 1 && !row.trim());
    const body = plain.slice(2, blank).map((row) => row.trim());
    assert.equal(
      body.slice(0, body.indexOf('runs a shell command')).join(' '),
      '$ ' + command,
    );
    // title and body carry the tint of a command, the focused option the selection colour
    const tint = colours.write_bg.slice(2, -1);
    assert.ok(rows[1]!.includes(tint) && rows[2]!.includes(tint));
    assert.ok(rows[blank + 1]!.includes(colours.sel_bg.slice(2, -1)));
    assert.ok(!rows[blank + 2]!.includes(colours.sel_bg.slice(2, -1)));
    // a short screen cuts the body and says how much; the title and options stay
    const short = dialogRows(
      new ApprovalCard(
        approvalRequest(
          {
            id: 'w',
            name: 'write_file',
            args: {
              file_path: 'big.txt',
              content: Array.from({ length: 30 }, (_, i) => `row ${i}`).join(
                '\n',
              ),
            },
          },
          policy.review('write_file', { file_path: 'big.txt' }),
          (path) => join(root, path),
        ),
      ).state(),
      48,
      10,
    ).map(stripAnsi);
    assert.equal(short.length, 10);
    assert.match(short[1]!, /Write needs your permission/);
    assert.match(short.join('\n'), /… \+\d+ lines/);
    assert.match(short.join('\n'), /Reject and explain/);
  }
});

test('approval previews: a patch names its files, an edit the file cannot confirm shows the replacement, and long changes stop at 40 rows', (t) => {
  const root = scratch(t);
  const resolve = (path: string): string => join(root, path);
  const patch =
    '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch';
  assert.equal(
    approvalBody('apply_patch', { patchText: patch }),
    'a.txt, b.txt',
  );
  const patchRows = approvalPreview('apply_patch', { patchText: patch });
  assert.deepEqual(patchRows[0], { text: '+2 -1' });
  assert.deepEqual(
    patchRows.filter((row) => row.tone).map((row) => [row.tone, row.text]),
    [
      ['added', '+hello'],
      ['removed', '-old'],
      ['added', '+new'],
    ],
  );
  assert.deepEqual(
    approvalPreview(
      'edit_file',
      { file_path: 'missing.txt', old_string: 'a\nb\n', new_string: 'a\nc\n' },
      resolve,
    ).map((row) => row.text),
    ['+1 -1', '@@ replacement @@', ' a', '-b', '+c'],
  );
  writeFileSync(
    join(root, 'long.txt'),
    Array.from({ length: 60 }, (_, i) => `old ${i}\n`).join(''),
  );
  const long = approvalPreview(
    'write_file',
    {
      file_path: 'long.txt',
      content: Array.from({ length: 60 }, (_, i) => `new ${i}\n`).join(''),
    },
    resolve,
  );
  assert.equal(long[0]!.text, '+60 -60');
  assert.equal(long.length, 42);
  assert.equal(long.at(-1)!.text, '… +81 more lines');
  assert.match(
    approvalBody('execute', { command: 'npm test', background: true }),
    /^\$ npm test\nruns in the background as a job$/,
  );
  assert.equal(
    approvalBody('webfetch', { url: 'https://example.com', limit: 3 }),
    'url="https://example.com"\nlimit=3',
  );
});

test('a background agent asks while the turn that started it is still running, as 0.5.0 did', async (t) => {
  let app: SessionApp | undefined;
  let shownDuringTurn = false;
  let busyWhenShown = false;
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    const user = request.messages.find(
      (message) => message.role === 'user' && !message.internal,
    )!.content;
    const replied = request.messages.some((message) => message.role === 'tool');
    if (user === 'tidy up')
      return {
        message: replied
          ? { id: crypto.randomUUID(), role: 'assistant', content: 'done' }
          : {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'child-write',
                  name: 'write_file',
                  args: { file_path: 'c.txt', content: 'C\n' },
                },
              ],
            },
        usage: emptyUsage(),
      };
    if (!replied)
      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'task',
              name: 'task',
              args: {
                description: 'tidy up',
                subagent_type: 'general-purpose',
                background: true,
              },
            },
          ],
        },
        usage: emptyUsage(),
      };
    // the turn is still running: the subagent's card must not wait for it to end
    await until(() => Boolean(app?.state.dialog));
    busyWhenShown = Boolean(app?.runtime?.harness.busy);
    shownDuringTurn = true;
    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'started',
      },
      usage: emptyUsage(),
    };
  };
  const s = session(
    t,
    Array.from({ length: 6 }, () => route),
  );
  app = s.app;
  const run = s.runtime.harness.run('start');
  await until(() => shownDuringTurn);
  assert.equal(busyWhenShown, true);
  assert.match(s.app.state.dialog!.title, /^j\d+ general-purpose · /);
  s.key('y');
  assert.equal((await run).answer, 'started');
  await until(() =>
    s.runtime.jobs.list().every((job) => job.status !== 'running'),
  );
  assert.equal(readFileSync(join(s.root, 'c.txt'), 'utf8'), 'C\n');
});

test('a folded paste in the draft survives a card and reaches the model whole', async (t) => {
  const s = session(t, [
    calls('a1', {
      id: 'w1',
      name: 'write_file',
      args: { file_path: 'x.txt', content: 'X\n' },
    }),
    answer('a2', 'written'),
    answer('a3', 'read it'),
  ]);
  const pasted = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
  (s.app as any).handle({ type: 'paste', text: pasted });
  assert.equal(s.app.state.draft, '[Pasted text #1 +11 lines]');
  const run = s.runtime.harness.run('write it');
  await until(() => Boolean(s.app.state.dialog), 3000);
  assert.equal(s.app.state.draft, '');
  s.key('y');
  await run;
  assert.equal(s.app.state.draft, '[Pasted text #1 +11 lines]');
  s.key('enter');
  await until(() => s.model.requests.length === 3);
  const sent = s.model.requests[2]!.messages.at(-1)!;
  assert.equal(sent.role, 'user');
  assert.equal(sent.content, pasted);
});
