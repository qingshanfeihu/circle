import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

function project(workspace: string, values: Record<string, unknown>): void {
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'settings.json'),
    JSON.stringify(values),
  );
}

test('the terminal applies project settings and --model for the run only; saving one setting writes nothing else', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  let saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved.theme = 'dark';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  project(workspace, {
    model: 'project-model',
    theme: 'light',
    hide_thinking: true,
    default_thinking: 'low',
  });
  const app = new SessionApp(workspace, home, loadSettings(home));
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  app.applyRunSettings('flag-model');
  assert.equal(app.settings.auth.model, 'flag-model');
  assert.equal(app.state.model, 'flag-model');
  assert.equal(app.settings.theme, 'light');
  assert.equal(app.settings.default_thinking, 'low');
  assert.equal(app.state.showThinking, false);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: app.settings,
    model: new ScriptedModel(),
    modelOverride: 'flag-model',
    headless: true,
  });
  cleanup(t, () => runtime.close());
  app.runtime = runtime;
  await app.command('themes', 'auto');
  await app.command('trust', '');
  const file = loadSettings(home);
  assert.equal(file.theme, 'auto');
  assert.equal(file.auth.model, 'saved-model');
  assert.equal(file.hide_thinking, false);
  assert.equal(file.default_thinking, '');
  await runtime.reloadIntegrations();
  assert.equal(runtime.options.settings.auth.model, 'flag-model');
  assert.equal(runtime.options.settings.hide_thinking, true);
});

test('print mode sends --model over the project model and --thinking over the variable, and saves neither', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      'data: ' +
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    response.end();
  });
  await new Promise<void>((ready) =>
    instance.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
  settings.auth.model = 'saved-model';
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  project(workspace, { model: 'project-model' });
  const before = readFileSync(join(home, 'settings.json'));
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          '-p',
          'hello',
          '-m',
          'flag-model',
          '--thinking',
          'high',
          workspace,
        ],
        {
          env: {
            ...process.env,
            CIRCLE_HOME: home,
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_REASONING_EFFORT: 'low',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (data) => (stderr += data));
      child.once('error', reject);
      child.once('close', (code) => done({ code, stderr }));
      child.stdin.end();
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(bodies[0]!.model, 'flag-model');
  assert.equal(bodies[0]!.reasoning_effort, 'high');
  assert.deepEqual(readFileSync(join(home, 'settings.json')), before);
});
