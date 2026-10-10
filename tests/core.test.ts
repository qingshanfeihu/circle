import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  defaultSettings,
  saveSettings,
  loadSettings,
  saveCredentials,
  loadCredentials,
  applyProjectSettings,
  withoutProjectSettings,
  isReady,
} from '../src/settings.js';
import { EventBus, getDefaultBus, withEventBus } from '../src/events.js';
import {
  ApprovalPolicy,
  ApprovalStore,
  classifyCommand,
} from '../src/approvals.js';
import { Sandbox, shellEnvironment } from '../src/sandbox.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ScriptedModel } from '../src/testing.js';
import { Harness } from '../src/harness.js';
import { buildTools } from '../src/tools.js';
import { applyPatch } from '../src/apply_patch.js';
import type { Message, Tool } from '../src/types.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});
test('settings preserve unknown keys, credentials merge, and project cannot replace endpoint or weaken credentials', (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  settings.auth.base_url = 'https://gateway.test/v1';
  settings.credential_files = ['secret.txt'];
  saveSettings(settings, root);
  const path = join(root, 'settings.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.future = 42;
  writeFileSync(path, JSON.stringify(raw));
  saveSettings(settings, root);
  assert.equal(loadSettings(root).future, 42);
  saveCredentials({ api_key: 'one', earlier: 'two' }, root);
  saveCredentials({ api_key: 'three' }, root);
  assert.deepEqual(loadCredentials(root), { api_key: 'three', earlier: 'two' });
  mkdirSync(join(root, '.circle'));
  writeFileSync(
    join(root, '.circle/settings.json'),
    JSON.stringify({
      auth: { base_url: 'https://evil.test' },
      theme: 'light',
      credential_files: ['other.txt'],
    }),
  );
  const { changed, problems } = applyProjectSettings(settings, root);
  assert.equal(problems.length, 1);
  assert.equal(settings.auth.base_url, 'https://gateway.test/v1');
  assert.deepEqual(settings.credential_files, ['secret.txt', 'other.txt']);
  assert.equal(settings.theme, 'light');
  assert.equal(withoutProjectSettings(settings, changed).theme, 'auto');
  settings.theme = 'dark';
  assert.equal(withoutProjectSettings(settings, changed).theme, 'dark');
});
test('the auth mode and OAuth provider an older release wrote are dropped; without a URL Circle is not set up', (t) => {
  const root = scratch(t);
  const path = join(root, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      initialized: true,
      auth: { mode: 'oauth', oauth_provider: 'openai', model: 'gpt-x' },
    }),
  );
  const settings = loadSettings(root);
  assert.deepEqual(settings.auth, {
    protocol: 'openai',
    base_url: '',
    model: 'gpt-x',
    api_key_ref: 'api_key',
  });
  // Circle signs in only with an API URL and key
  assert.equal(isReady(settings), false);
  settings.auth.base_url = 'https://gateway.test/v1';
  assert.equal(isReady(settings), true);
  saveSettings(settings, root);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).auth, settings.auth);
});
test('event subscribers are isolated and async bus identity stays scoped', async () => {
  const one = new EventBus('one');
  const two = new EventBus('two');
  const events: string[] = [];
  one.subscribe(() => {
    throw new Error('bad display');
  });
  one.subscribe((event) => events.push(event.run_id));
  one.emit('info');
  assert.deepEqual(events, ['one']);
  await Promise.all([
    withEventBus(one, async () => {
      await delay(5);
      assert.equal(getDefaultBus(), one);
    }),
    withEventBus(two, async () => {
      await delay(1);
      assert.equal(getDefaultBus(), two);
    }),
  ]);
});
test('approval classification protects nested commands, destructive git, credentials and read-only rules', () => {
  for (const command of [
    'sudo ls',
    'bash -c "sudo ls"',
    'cat .env',
    'echo $(cat credentials.json)',
  ])
    assert.equal(classifyCommand(command).verdict, 'DENY', command);
  for (const command of [
    'rm file',
    'git reset --hard',
    'git push --force',
    'git -C repo clean -fd',
    'bash -c "rm x"',
  ])
    assert.equal(classifyCommand(command).verdict, 'ASK_FORCED', command);
  assert.equal(
    classifyCommand('git status && rg hello src').pattern,
    'read-only',
  );
  for (const command of [
    'git -c core.pager=anything diff',
    'rg --pre evil x',
    'cat x > y',
    './ls',
    'find . -exec touch x \\;',
  ])
    assert.notEqual(classifyCommand(command).pattern, 'read-only', command);
});
test('shell commands receive the user environment without API credentials', () => {
  const env = shellEnvironment({
    PATH: '/usr/bin',
    HOME: '/scratch',
    OPENAI_API_KEY: 'secret',
    GITHUB_TOKEN: 'token',
    SSL_CERT_FILE: '/ca.pem',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/scratch',
    SSL_CERT_FILE: '/ca.pem',
  });
});
test('edit requires read and rejects ambiguous replacement; patch validates all files before applying', async (t) => {
  const root = scratch(t);
  const sandbox = new Sandbox(root);
  const tools = buildTools(sandbox);
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  writeFileSync(join(root, 'a.txt'), 'one\none\n');
  const edit = tools.find((tool) => tool.name === 'edit_file')!;
  await assert.rejects(
    edit.run(
      { file_path: 'a.txt', old_string: 'one', new_string: 'two' },
      context,
    ),
    /read_file/,
  );
  await tools
    .find((tool) => tool.name === 'read_file')!
    .run({ file_path: 'a.txt' }, context);
  await assert.rejects(
    edit.run(
      { file_path: 'a.txt', old_string: 'one', new_string: 'two' },
      context,
    ),
    /multiple matches/,
  );
  const before = readFileSync(join(root, 'a.txt'), 'utf8');
  assert.throws(() =>
    applyPatch(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** Update File: missing\n@@\n-x\n+y\n*** End Patch',
      sandbox,
    ),
  );
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), before);
  applyPatch(
    '*** Begin Patch\n*** Add File: b.txt\n+hello\n*** End Patch',
    sandbox,
  );
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'hello\n');
});
test('checkpoints survive restart, retain alternate branches, and enforce concurrent heads', (t) => {
  const root = scratch(t);
  let store = new CheckpointStore(root);
  const session = store.create(root, 'test');
  const first = store.append(session.id, [
    { id: 'u1', role: 'user', content: 'first' },
  ]);
  const old = store.append(session.id, [assistant('old')]);
  store.select(session.id, first);
  store.append(session.id, [assistant('new')]);
  assert.deepEqual(
    store.messages(session.id).map((message) => message.content),
    ['first', 'new'],
  );
  assert.equal(store.tree(session.id).length, 3);
  assert.throws(
    () => store.append(session.id, [assistant('racing')], old),
    /another process/,
  );
  store.close();
  store = new CheckpointStore(root);
  assert.deepEqual(
    store.messages(session.id).map((message) => message.content),
    ['first', 'new'],
  );
  assert.equal(store.messages(session.id, old).at(-1)!.content, 'old');
  store.close();
});
test('append-only summary changes model projection while retaining raw results', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const checkpoint = store.append(session.id, [
    { id: 'u1', role: 'user', content: 'large original' },
    assistant('answer'),
  ])!;
  store.setSummary(session.id, checkpoint, 'short summary');
  store.append(session.id, [{ id: 'u2', role: 'user', content: 'next' }]);
  assert.equal(store.messages(session.id)[0]!.content, 'large original');
  assert.match(
    store.projectedMessages(session.id)[0]!.content,
    /short summary/,
  );
});
function runtime(
  root: string,
  model: ScriptedModel,
  tools: Tool[],
  extra: Partial<ConstructorParameters<typeof Harness>[0]> = {},
) {
  const store = new CheckpointStore(root);
  const session = store.create(root, model.model);
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  const harness = new Harness({
    model,
    tools,
    store,
    session,
    policy,
    system: 'test',
    ...extra,
  });
  return { harness, store, policy, session };
}
test('headless runs real tools, persists tool output, and sends it in the next model request', async (t) => {
  const root = scratch(t);
  const tools = buildTools(new Sandbox(root));
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'call1',
          name: 'write_file',
          args: { file_path: 'result.txt', content: 'written' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const { harness, store, policy, session } = runtime(root, model, tools, {
    headless: true,
  });
  cleanup(t, () => store.close());
  policy.setYolo(session.id, true);
  const result = await harness.run('write a file');
  assert.equal(result.answer, 'done');
  assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'written');
  assert.equal(model.requests[1]!.messages.at(-1)!.role, 'tool');
  assert.match(model.requests[1]!.messages.at(-1)!.content, /Wrote/);
});
test('read-only prevents writes and unknown-effect integration tools', async (t) => {
  const root = scratch(t);
  let sideEffect = false;
  const tool: Tool = {
    name: 'integration',
    description: '',
    parameters: {},
    effect: 'unknown',
    run: async () => {
      sideEffect = true;
      return 'changed';
    },
  };
  const model = new ScriptedModel([
    {
      message: assistant('', [{ id: 'call1', name: 'integration', args: {} }]),
    },
    { message: assistant('blocked') },
  ]);
  const { harness, store } = runtime(root, model, [tool]);
  cleanup(t, () => store.close());
  harness.planMode = true;
  await harness.run('test');
  assert.equal(sideEffect, false);
  assert.match(model.requests[1]!.messages.at(-1)!.content, /read-only/);
});
test('cancel during approval does not execute the tool and persists a matching error result', async (t) => {
  const root = scratch(t);
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let ran = false;
  const tool: Tool = {
    name: 'write',
    description: '',
    parameters: {},
    effect: 'write',
    run: async () => {
      ran = true;
      return 'wrote';
    },
  };
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'cancelled', name: 'write', args: {} }]) },
  ]);
  const { harness, store } = runtime(root, model, [tool], {
    approve: async (_call, signal) => {
      entered();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  cleanup(t, () => store.close());
  const run = harness.run('write');
  const caught = assert.rejects(run, /Interrupted/);
  await waiting;
  await harness.cancel();
  await caught;
  assert.equal(ran, false);
  assert.equal(harness.messages.at(-1)!.tool_call_id, 'cancelled');
  store.requireBalancedTools(harness.messages);
});
test('steering is consumed in the next request before follow-up starts', async (t) => {
  const root = scratch(t);
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tool: Tool = {
    name: 'wait',
    description: '',
    parameters: {},
    effect: 'read',
    run: async () => {
      started();
      await gate;
      return 'result';
    },
  };
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'c1', name: 'wait', args: {} }]) },
    { message: assistant('first done') },
    { message: assistant('follow-up done') },
  ]);
  const { harness, store } = runtime(root, model, [tool]);
  cleanup(t, () => store.close());
  const running = harness.run('initial');
  await ready;
  harness.queue('steering', 'steer');
  harness.queue('follow-up', 'followUp');
  release();
  assert.equal((await running).answer, 'follow-up done');
  assert.equal(model.requests[1]!.messages.at(-1)!.content, 'steering');
  assert.equal(model.requests[2]!.messages.at(-1)!.content, 'follow-up');
});
test('cancel stops the actual shell process tree before a delayed child writes', async (t) => {
  const root = scratch(t);
  const sandbox = new Sandbox(root);
  const controller = new AbortController();
  writeFileSync(
    join(root, 'grandchild.cjs'),
    "const fs = require('node:fs'); fs.writeFileSync('started', 'yes'); setTimeout(() => fs.writeFileSync('late', 'bad'), 1500);",
  );
  writeFileSync(
    join(root, 'parent.cjs'),
    "require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], {stdio: 'ignore'}); setTimeout(() => {}, 10000);",
  );
  const command = `"${process.execPath}" "${join(root, 'parent.cjs')}"`;
  const running = sandbox.execute(command, controller.signal);
  cleanup(t, async () => {
    controller.abort();
    await running;
  });
  for (let i = 0; i < 250 && !existsSync(join(root, 'started')); i++)
    await delay(20);
  assert.ok(existsSync(join(root, 'started')));
  controller.abort();
  await running;
  await delay(1700);
  assert.equal(existsSync(join(root, 'late')), false);
});
