import { cleanupNativeTest } from './helpers/native-failure.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { captureFailure } from './helpers/diagnostics.mjs';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { patience } from './helpers/patience.mjs';

// A local model gateway reads the real preceding screenshot result. It never calls a model.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-coordinate-live-'));
const output = join(root, 'artifacts/browser-coordinate-live');
await mkdir(output, { recursive: true });
const requests = [];
let effects = 0,
  hoverEffects = 0,
  step = 0,
  url;
const server = createServer(async (req, res) => {
  if (req.url === '/effect') {
    effects++;
    res.end('yes');
    return;
  }
  if (req.url === '/hover-effect') {
    hoverEffects++;
    res.end('yes');
    return;
  }
  if (req.url === '/hover') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Hover coordinate fixture</title><button style="margin:100px;width:220px;height:60px">Show details</button><script>const b=document.querySelector("button");b.addEventListener("mouseenter",()=>b.textContent="Delete configuration");b.addEventListener("click",()=>fetch("/hover-effect"));</script>',
    );
    return;
  }
  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Coordinate fixture</title><span id="missing" style="display:inline-block;width:80px;height:30px">...</span><script>document.querySelector("#missing").addEventListener("click",()=>fetch("/effect"));</script>',
    );
    return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'coordinate-fixture' }] }));
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  // The session title is asked after the turn. It is not one of the scripted steps.
  if (isTitleRequest(request)) {
    answerTitle(res, request);
    return;
  }
  requests.push(request);
  const tool = (id, name, args) => ({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let delta,
    finish = 'tool_calls';
  if (step === 0)
    delta = tool('open', 'browser_navigate', { url: url + 'page' });
  else if (step === 1) delta = tool('shot', 'browser_screenshot', {});
  else if (step === 2) {
    const screenshot = request.messages.findLast(
      (message) => message.role === 'tool' && message.tool_call_id === 'shot',
    );
    const id = String(screenshot?.content).match(
      /screenshotId: ([a-zA-Z0-9-]+)/,
    )?.[1];
    assert.ok(id, 'the real screenshotId reaches the next model request');
    delta = tool('coordinate', 'browser_click_at', {
      x: 48,
      y: 23,
      screenshotId: id,
    });
  } else if (step === 3) {
    delta = { role: 'assistant', content: 'coordinate fixture completed' };
    finish = 'stop';
  } else if (step === 4)
    delta = tool('hover-open', 'browser_navigate', { url: url + 'hover' });
  else if (step === 5) delta = tool('hover-shot', 'browser_screenshot', {});
  else if (step === 7) {
    const result = request.messages.findLast(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'hover-first',
    );
    assert.match(String(result?.content), /screenshot.*(?:stale|changed)/);
    assert.equal(
      hoverEffects,
      0,
      'hover mutation is rejected before mouse press',
    );
    delta = tool('hover-new-shot', 'browser_screenshot', {});
  } else if (step === 6 || step === 8) {
    const screenshot = request.messages.findLast(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === (step === 6 ? 'hover-shot' : 'hover-new-shot'),
    );
    const id = String(screenshot?.content).match(
      /screenshotId: ([a-zA-Z0-9-]+)/,
    )?.[1];
    assert.ok(id);
    delta = tool(
      step === 6 ? 'hover-first' : 'hover-approved',
      'browser_click_at',
      { x: 218, y: 138, screenshotId: id },
    );
  } else {
    delta = { role: 'assistant', content: 'hover fixture completed' };
    finish = 'stop';
  }
  step++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta) =>
    `data: ${JSON.stringify({ id: 'local-coordinate-gateway', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.write(chunk(delta));
  res.write(
    `data: ${JSON.stringify({ id: 'local-coordinate-gateway', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
url = `http://127.0.0.1:${server.address().port}/`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};
for (const key of Object.keys(env))
  if (
    /^(https?_proxy|all_proxy|node_use_env_proxy|circle_desktop_runtime_fixture)$/i.test(
      key,
    )
  )
    delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  app.context().on('page', (page) => page.on('dialog', () => {}));
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(20000));
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.setContentSize(1400, 900);
  });
  const endpoint = page.getByRole('textbox', { name: 'base url', exact: true });
  const connect = page
    .getByRole('button', { name: 'connect a model', exact: true })
    .first();
  await endpoint.or(connect).first().waitFor();
  // This is a coordinate-action check, not a test of the automatic setup dialog.
  // The visible connection entry is also the normal way to open it explicitly.
  if (
    process.env.CIRCLE_DESKTOP_TEST_EXPLICIT_CONNECT &&
    (await endpoint.isVisible())
  ) {
    await page.getByRole('button', { name: 'cancel', exact: true }).click();
    await endpoint.waitFor({ state: 'hidden' });
  }
  let connectionEntry = 'automatic';
  if (!(await endpoint.isVisible())) {
    connectionEntry = 'explicit';
    try {
      await connect.click({ timeout: 2000 });
    } catch (error) {
      // The automatic dialog can win the race with this click.
      if (!(await endpoint.isVisible())) throw error;
    }
  }
  await endpoint.fill(url + 'v1');
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('coordinate-fixture-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByRole('option', { name: 'coordinate-fixture', exact: true })
    .click();
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('click the local ellipsis');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  const site = page
    .locator('.inline-request')
    .filter({ hasText: 'browser_navigate' })
    .last();
  await site
    .getByRole('button', {
      name: `allow on ${new URL(url).origin} for this session`,
      exact: true,
    })
    .click();
  const coordinate = page
    .locator('.inline-request')
    .filter({ hasText: 'clicks a coordinate target' })
    .last();
  await coordinate.waitFor();
  assert.equal(
    effects,
    0,
    'unknown coordinate cannot act before the one-time decision',
  );
  assert.equal(
    await coordinate.getByRole('button', { name: /session/ }).count(),
    0,
    'coordinate confirmation has no remembered allowance',
  );
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (theme) => {
      const state = await window.circleDesktop.runtimeState();
      await window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'save-settings',
        sessionId: state.snapshot.activeSessionId,
        payload: { settings: { theme } },
      });
    }, theme);
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await page.screenshot({ path: join(output, `coordinate-${theme}.png`) });
  }
  await coordinate
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  await page
    .getByText('coordinate fixture completed', { exact: true })
    .waitFor();
  assert.equal(
    effects,
    1,
    'real pointer events reach the non-semantic page listener',
  );
  const result = requests
    .at(-1)
    .messages.find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'coordinate',
    );
  assert.match(String(result.content), /Clicked at \(48, 23\): span "\.\.\."/);
  const screenshot = requests[2].messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'shot',
  );
  assert.match(String(screenshot.content), /viewport: .*CSS pixels/);
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('check the hover-changing button');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  const hoverApproval = page
    .locator('.inline-request')
    .filter({ hasText: 'clicks a coordinate target' })
    .last();
  await hoverApproval
    .getByText('Delete configuration', { exact: true })
    .waitFor();
  assert.equal(hoverEffects, 0);
  await hoverApproval
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  await page.getByText('hover fixture completed', { exact: true }).waitFor();
  assert.equal(hoverEffects, 1);
  const hoverResult = requests
    .at(-1)
    .messages.findLast(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'hover-approved',
    );
  assert.match(
    String(hoverResult?.content),
    /Clicked at.*Delete configuration/,
  );
  assert.deepEqual(errors, []);
  const info = await page.evaluate(() => window.circleDesktop.info());
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        packaged: info.packaged,
        connectionEntry,
        checks: [
          'real screenshot metadata reaches gateway',
          'manual unknown target waits once',
          'real coordinate effect reaches next request',
          'dark and light approval card',
          'hover mutation rejects press, then fresh screenshot requires destructive approval',
        ],
        effects,
        hoverEffects,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: 5, packaged: info.packaged, output }));
} catch (error) {
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (
    !(await cleanupNativeTest([
      async () => {
        if (app) await app.close();
      },
      () => server.closeAllConnections(),
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      () => rm(temp, { recursive: true, force: true }),
    ]))
  )
    process.exitCode = 1;
}
