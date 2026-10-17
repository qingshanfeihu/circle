// Issue #60 through the native form, restricted bridge, worker and local Anthropic SDK.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-connection-issues-'));
const output = resolve(
  root,
  '../../outputs/connection-issues',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const dataDir = join(temp, 'data');
const home = join(dataDir, 'runtime-home');
await mkdir(join(home, 'cache'), { recursive: true });
// A fresh synthetic catalog also prevents a background models.dev request.
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const selected = 'claude-page-21';
const requests = [];
const titleRequests = [];
const errors = [];
const checks = [];
const stream = (model, text) =>
  [
    {
      type: 'message_start',
      message: {
        id: 'msg-native-local',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
const gateway = createServer(async (req, res) => {
  let bytes = '';
  for await (const chunk of req) bytes += chunk;
  const body = bytes ? JSON.parse(bytes) : undefined;
  // The session title is asked after the turn. It is not one of the turns
  // whose connection this test follows.
  if (req.method === 'POST' && isTitleRequest(body)) {
    titleRequests.push({ url: req.url, headers: req.headers, body });
    answerTitle(res, body, 'anthropic');
    return;
  }
  requests.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  });
  const url = new URL(req.url, 'http://fixture');
  if (req.method === 'GET' && url.pathname.endsWith('/anthropic/v1/models')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.has('after_id')) {
      if (url.pathname.startsWith('/failed/')) {
        res.writeHead(503);
        res.end('{"error":"second page unavailable"}');
      } else
        res.end(JSON.stringify({ data: [{ id: selected }], has_more: false }));
    } else {
      res.end(
        JSON.stringify({
          data: Array.from({ length: 20 }, (_, i) => ({
            id: `claude-page-${i + 1}`,
          })),
          has_more: true,
          last_id: 'claude-page-20',
        }),
      );
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text =
      requests.filter((request) => request.method === 'POST').length === 1
        ? 'native selected page 21'
        : 'native old connection retained';
    res.end(stream(body.model, text));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${gateway.address().port}`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let application;
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const command = (name, payload = {}) =>
    page.evaluate(
      async ({ name, payload }) => {
        const current = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: current.snapshot.activeSessionId,
        });
      },
      { name, payload },
    );
  const until = async (check, label) => {
    const deadline = Date.now() + patience(12000);
    while (!(await check())) {
      assert(Date.now() < deadline, label);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const send = async (value) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(value);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  await page.getByRole('textbox', { name: 'base url', exact: true }).waitFor();
  await page
    .getByRole('combobox', { name: 'provider', exact: true })
    .selectOption('anthropic');
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill(base + '/anthropic/v1');
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('native-saved-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByText('discovered 21 models (anthropic)', { exact: true })
    .waitFor();
  assert.equal((await state()).runtime.configured, false);
  await page
    .getByRole('combobox', { name: 'search models', exact: true })
    .fill(selected);
  await page.getByRole('option', { name: selected, exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await page.screenshot({ path: join(output, `page-21-${theme}.png`) });
  }
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  assert.equal(saved.auth.model, selected);
  assert.equal(saved.auth.protocol, 'anthropic');
  assert.equal(saved.auth.base_url, base + '/anthropic');
  await send('request with the model from page 21');
  await page.getByText('native selected page 21', { exact: true }).waitFor();
  await until(async () => {
    const snapshot = await state();
    return !snapshot.sessions.find(
      (session) => session.id === snapshot.activeSessionId,
    )?.turn;
  }, 'selected model turn completed');
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      '/anthropic/v1/models',
      '/anthropic/v1/models?after_id=claude-page-20',
      '/anthropic/v1/messages',
    ],
  );
  assert(
    requests.every(
      (request) =>
        request.headers['x-api-key'] === 'native-saved-key' &&
        request.headers['anthropic-version'] === '2023-06-01',
    ),
  );
  assert.equal(requests.at(-1).body.model, selected);
  checks.push(
    'the native form selects and saves the 21st Anthropic model, and the actual SDK request carries that exact id',
  );

  const settingsBefore = await readFile(join(home, 'settings.json'), 'utf8');
  const credentialsBefore = await readFile(
    join(home, 'credentials.json'),
    'utf8',
  );
  await send('/login');
  await page
    .getByRole('combobox', { name: 'provider', exact: true })
    .selectOption('anthropic');
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill(base + '/failed/anthropic/v1');
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('candidate-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'connection model', exact: true })
    .waitFor();
  assert.match(
    await page.locator('.connection-banner').innerText(),
    /model discovery failed.*http 503/,
  );
  assert.equal(
    await page.getByRole('option').count(),
    0,
    'the first 20 models are not exposed as a complete list',
  );
  assert.equal(
    await page
      .getByRole('textbox', { name: 'connection model', exact: true })
      .inputValue(),
    '',
  );
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  assert.equal(
    await readFile(join(home, 'settings.json'), 'utf8'),
    settingsBefore,
  );
  assert.equal(
    await readFile(join(home, 'credentials.json'), 'utf8'),
    credentialsBefore,
  );
  await writeFile(
    join(output, 'failed-discovery-state.json'),
    JSON.stringify(
      {
        snapshot: await state(),
        banner: await page.locator('.connection-banner').innerText(),
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(output, 'second-page-failed.png') });
  await page.getByRole('button', { name: 'back', exact: true }).click();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  assert.equal(
    await readFile(join(home, 'settings.json'), 'utf8'),
    settingsBefore,
  );
  assert.equal(
    await readFile(join(home, 'credentials.json'), 'utf8'),
    credentialsBefore,
  );
  checks.push(
    'a second-page failure exposes no truncated model choices and cannot replace the saved connection without an explicit model',
  );
  await send('use the original saved connection after failed discovery');
  await page
    .getByText('native old connection retained', { exact: true })
    .waitFor();
  assert.deepEqual(
    requests.slice(3).map((request) => request.url),
    [
      '/failed/anthropic/v1/models',
      '/failed/anthropic/v1/models?after_id=claude-page-20',
      '/anthropic/v1/messages',
    ],
  );
  const actual = requests.at(-1);
  assert.equal(actual.headers['x-api-key'], 'native-saved-key');
  assert.equal(actual.body.model, selected);
  // The title of the first session went over the same saved connection.
  assert(
    titleRequests.every(
      (request) =>
        request.url === '/anthropic/v1/messages' &&
        request.headers['x-api-key'] === 'native-saved-key' &&
        request.body.model === selected,
    ),
  );
  assert.deepEqual(errors, []);
  checks.push(
    'the next actual SDK request after cancellation still uses the saved endpoint, key and model',
  );
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        checks,
        packaged: info.packaged,
        pageErrors: errors,
        modelRequests: requests
          .filter((request) => request.method === 'POST')
          .map((request) => ({ url: request.url, model: request.body.model })),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} finally {
  await application?.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await rm(temp, { recursive: true, force: true });
}
