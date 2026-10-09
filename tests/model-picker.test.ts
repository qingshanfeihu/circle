import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { matchesModel, modelScope } from '../src/model_scope.js';
import { Picker } from '../src/ink/components/picker.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  saveCredentials,
} from '../src/settings.js';
import { defaultRunOptions } from '../src/run_options.js';
import { cleanup, scratch } from './helpers.js';

test('model scopes preserve order, match case-insensitive wildcards/ranges across provider prefixes and retain unlisted explicit IDs', () => {
  assert.deepEqual(
    modelScope(
      ['openai/gpt-a', 'claude-b', 'claude-c'],
      ['CLAUDE-[b-c]', 'openai/*', 'custom', 'claude-b'],
      'unlisted',
    ),
    ['claude-b', 'claude-c', 'openai/gpt-a', 'custom'],
  );
  assert.deepEqual(modelScope(['b', 'a'], [], 'custom'), ['custom', 'b', 'a']);
  assert.deepEqual(modelScope(['a'], ['none*'], 'a'), []);
  for (const [pattern, input, expected] of [
    ['[!a]', 'b', true],
    ['[]a]', ']', true],
    ['[^a]', '^', true],
    ['x[', 'x[', true],
    ['model?', 'model1', true],
    ['model.', 'modelx', false],
  ] as const)
    assert.equal(matchesModel(pattern, input), expected);
});

test('picker action keys operate on filtered focus and preserve it when items are refreshed', () => {
  const chosen: string[] = [];
  const picker = new Picker(
    'models',
    [
      { key: 'a', label: 'model a' },
      { key: 'b', label: 'model b' },
    ],
    (item) => chosen.push(item.key),
    () => {},
    {
      hint: 'ctrl+s saves',
      keys: {
        tab: (item) => {
          if (item) chosen.push('tab:' + item.key);
        },
      },
    },
  );
  picker.handle('ctrl+n', '');
  picker.handle('tab', '');
  picker.setItems([
    { key: 'b', label: 'model b', current: true },
    { key: 'a', label: 'model a' },
  ]);
  picker.handle('enter', '');
  assert.deepEqual(chosen, ['tab:b', 'b']);
  picker.query = 'missing';
  picker.handle('tab', '');
  assert.equal(chosen.length, 2);
});

for (const scopedRun of [false, true])
  test(`terminal model/effort actions use real discovery and preserve ${scopedRun ? 'run-only scope' : 'account defaults'}`, async (t) => {
    const root = scratch(t);
    let discoveryCount = 0;
    const server = createServer((request, response) => {
      discoveryCount++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    cleanup(t, async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const saved = defaultSettings();
    saved.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
    saved.auth.model = 'a';
    saved.theme = 'dark';
    saved.future = 'keep';
    saveSettings(saved, root);
    saveCredentials({ api_key: 'fixture' }, root);
    const settings = structuredClone(saved);
    settings.theme = 'light'; // A project override must not become an account default.
    const run = defaultRunOptions();
    if (scopedRun) run.models = ['a'];
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings,
      run,
      model: new GatewayModel(settings, root),
      headless: true,
    });
    cleanup(t, () => runtime.close());
    const app = new SessionApp(root, root, settings);
    app.runtime = runtime;
    const ui = app as any;
    ui.screen.render = () => {};
    cleanup(t, () => {
      if (ui.flashTimer) clearTimeout(ui.flashTimer);
      ui.input.close();
    });
    const key = async (value: string): Promise<void> => {
      ui.handle({ type: 'key', key: value, char: '' });
      await delay(10);
    };
    await app.command('models', '');
    app.state.picker!.query = 'b';
    await key('tab');
    assert.deepEqual(
      scopedRun ? run.models : loadSettings(root).enabled_models,
      scopedRun ? ['a', 'b'] : ['b'],
    );
    if (scopedRun) assert.deepEqual(loadSettings(root).enabled_models, []);
    else await key('tab');
    await key('enter');
    assert.equal(runtime.harness.model.model, 'b');
    assert.equal(loadSettings(root).auth.model, 'a');
    const beforeCycle = discoveryCount;
    await key('ctrl+p');
    assert.equal(runtime.harness.model.model, 'a');
    assert.equal(discoveryCount, beforeCycle);
    await key('shift+tab');
    assert.equal(runtime.thinkingLevel, 'minimal');
    await app.command('models', '');
    app.state.picker!.query = 'b';
    await key('ctrl+s');
    assert.equal(loadSettings(root).auth.model, 'b');
    assert.equal(loadSettings(root).theme, 'dark');
    assert.equal(loadSettings(root).future, 'keep');
    await app.command('effort', '');
    app.state.picker!.query = 'medium';
    await key('ctrl+s');
    assert.equal(loadSettings(root).default_thinking, 'medium');
    assert.equal(loadSettings(root).theme, 'dark');
    assert.equal(runtime.thinkingLevel, 'medium');
  });
