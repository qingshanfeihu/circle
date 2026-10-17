import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { captureFailure } from './helpers/diagnostics.mjs';
import { setViewport } from './helpers/viewport.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';
import {
  parseModelRequestFrames,
  readModelRequests,
} from './helpers/model-requests.mjs';
import { patience } from './helpers/patience.mjs';

// The conversation's browser, driven by a scripted model and by the person, against local
// HTTPS sites with a self-signed certificate: everything a page asks for reaches both.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/browser-live');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-live-'));
const keyPath = join(temp, 'key.pem');
const certificatePath = join(temp, 'certificate.pem');
const fixturePath = join(temp, 'model.json');
const dataPath = join(temp, 'data');
const posts = [];
const uploads = [];
const notesPath = join(temp, 'notes.txt');
const logPath = join(temp, 'run.log');
const checks = [];
const errors = [];
let app;
let page;
let requestsPath = join(temp, 'requests.jsonl');
let viewportSizing;

// Every request is local. The certificate exists only inside this test's scratch folder.
await promisify(execFile)('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  certificatePath,
  '-days',
  '1',
  '-subj',
  '/CN=Circle Fixture Device/O=Circle browser fixture',
]);

// Two client certificates a site could ask for, as the system's store would list them
const clientCertificates = [];
for (const name of ['Circle Fixture Operator', 'Circle Fixture Admin']) {
  const path = join(temp, `${name.replaceAll(' ', '-')}.pem`);
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(temp, 'client-key.pem'),
    '-out',
    path,
    '-days',
    '1',
    '-subj',
    `/CN=${name}/O=Circle client fixture`,
  ]);
  clientCertificates.push({
    data: await readFile(path, 'utf8'),
    subjectName: name,
    issuerName: name,
    validStart: Math.floor(Date.now() / 1000),
    validExpiry: Math.floor(Date.now() / 1000) + 86400,
  });
}

const document = `<!doctype html>
<html><head><title>Circle HTTPS browser fixture</title>
<style>
  body { font: 16px sans-serif; margin: 20px; }
  label, input, select, button, a { display: block; margin-bottom: 8px; }
  [hidden] { display: none; }
  iframe { height: 80px; width: 260px; }
  #covered { position: relative; width: 200px; height: 48px; }
  #blocked { width: 200px; height: 48px; }
  #blocker { position: absolute; inset: 0; background: Canvas; }
</style></head><body>
<h1>Local browser form</h1>
<form id="login">
  <label for="username">Username</label><input id="username" name="username" value="old username">
  <label for="password">Password</label><input id="password" name="password" type="password" value="fixture-secret-never-in-snapshot">
  <label for="role">Role</label><select id="role" name="role"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
  <button type="submit">Log in</button>
</form>
<output id="result"></output>
<iframe title="same-origin controls" src="/frame"></iframe>
<section id="shadow"></section>
<button id="dialog">Open prompt</button>
<output id="dialog-result"></output>
<div id="covered"><button id="blocked" onclick="window.blockedClicks = (window.blockedClicks || 0) + 1">Covered button</button><div id="blocker">Fixture blocker</div></div>
<table><caption>Fixture table</caption><tr><th>Name</th><th>Status</th></tr><tr><td>Device</td><td>Ready</td></tr></table>
<button hidden>Hidden action</button><p hidden>Hidden page text</p>
<a id="status" href="/status" target="_blank">Status in new tab</a>
<button id="delete" onclick="document.querySelector('#delete-result').textContent = confirm('Delete the configuration?') ? 'deleted' : 'kept'">Delete configuration</button>
<output id="delete-result"></output>
<button id="restart" onclick="window.restarts = (window.restarts || 0) + 1">Restart device</button>
<script>
  const shadowButton = document.createElement('button');
  shadowButton.textContent = 'Shadow action';
  shadowButton.addEventListener('click', () => { shadowButton.textContent = 'Shadow clicked'; });
  document.querySelector('#shadow').attachShadow({mode:'open'}).append(shadowButton);
  document.querySelector('#dialog').addEventListener('click', () => {
    const value = prompt('Fixture prompt', 'default');
    if (confirm('Fixture confirm')) {
      alert('Fixture alert');
      document.querySelector('#dialog-result').textContent = value ?? 'cancelled';
    }
  });
  document.querySelector('#login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/submit', {method:'POST', body:new URLSearchParams(new FormData(event.target))});
    document.querySelector('#result').textContent = await response.text();
  });
</script></body></html>`;

// What each request for the admin page sent to sign in, decoded
const authorizations = [];
let releaseHeld = () => {};
const handler = async (request, response) => {
  if (request.url === '/close-opener' || request.url === '/close-popup') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      request.url === '/close-popup'
        ? '<title>Self closing popup</title><button onclick="window.close()">close</button>'
        : '<title>Close fixture opener</title><button onclick="window.open(\'/close-popup\')">open</button>',
    );
    return;
  }

  if (request.url === '/auth') {
    const sent = request.headers.authorization ?? '';
    authorizations.push(
      sent && Buffer.from(sent.replace(/^Basic /, ''), 'base64').toString(),
    );
    if (
      sent ===
      `Basic ${Buffer.from('admin:secret-from-circle').toString('base64')}`
    ) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<!doctype html><title>Admin</title><p>admin page signed in</p>',
      );
      return;
    }
    response.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Circle fixture admin"',
      'Content-Type': 'text/html',
    });
    response.end('<!doctype html><title>401</title><p>sign in first</p>');
    return;
  }
  if (request.url === '/later') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><title>Later</title><button onclick="setTimeout(() => location = '/download', 1500)">Later</button>`,
    );
    return;
  }
  if (request.url === '/held') {
    // Answers once the test lets it, as a handshake goes on once a certificate is chosen
    await new Promise((resolve) => (releaseHeld = resolve));
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Identified</title><p>identified</p>');
    return;
  }
  if (request.url === '/permission') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><title>Alerts</title><button onclick="Notification.requestPermission().then((answer) => { document.getElementById('out').textContent = 'notifications: ' + answer; })">Ask</button><output id="out"></output>`,
    );
    return;
  }
  if (request.url === '/files' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    uploads.push(body);
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Sent</title><p>files received</p>');
    return;
  }
  if (request.url === '/slow') {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Slow page</title><p>slow</p>');
    return;
  }
  if (request.url === '/download') {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="report.bin"',
    });
    response.end('report bytes');
    return;
  }
  if (request.url === '/files') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><title>Files</title><form method="post" action="/files" enctype="multipart/form-data"><label>Attachment <input type="file" name="attachment"></label><input id="logs" type="file" name="logs" style="display:none"><button type="button" onclick="document.getElementById(\'logs\').click()">Add logs</button><button>Send</button></form>',
    );
    return;
  }
  if (request.url === '/submit' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    posts.push(Object.fromEntries(new URLSearchParams(body)));
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Submitted admin as maintainer');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    request.url === '/frame'
      ? '<!doctype html><button onclick="this.textContent = \'Frame clicked\'">Frame action</button>'
      : request.url === '/status'
        ? '<!doctype html><title>Device status</title><h1>Status: ready</h1>'
        : document,
  );
};
const tls = {
  key: await readFile(keyPath),
  cert: await readFile(certificatePath),
};
// Two sites with the same certificate: an exception is for one host and port only.
const site = createHttpsServer(tls, handler);
const other = createHttpsServer(tls, handler);
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
const url = `https://127.0.0.1:${site.address().port}/`;
const host = `127.0.0.1:${site.address().port}`;
const otherUrl = `https://127.0.0.1:${other.address().port}/`;
// Reserve then close a local port, so connection failure does not depend on a remote host.
const unavailable = createHttpServer();
await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
const unavailableUrl = `http://127.0.0.1:${unavailable.address().port}/`;
await new Promise((resolve) => unavailable.close(resolve));

const calls = (id, toolCalls, delayMs) => ({
  message: { id, role: 'assistant', content: '', tool_calls: toolCalls },
  ...(delayMs ? { delayMs } : {}),
});
const call = (id, name, args) => ({ id, name, args });
const answer = (id, content) => ({
  message: { id, role: 'assistant', content },
});
const script = (replies) =>
  writeFile(fixturePath, JSON.stringify({ requestsPath, replies }));
await script([
  calls('navigate', [call('navigate', 'browser_navigate', { url })]),
  calls('advanced', [
    call('advanced', 'browser_click', { ref: 'e1', element: 'Advanced' }),
  ]),
  calls('proceed', [
    call('proceed', 'browser_click', { ref: 'e3', element: 'Proceed link' }),
  ]),
  answer('navigation-done', 'browser navigation completed'),
  calls('form', [
    // A secret typed where the page shows it back stays a name in the result
    call('echo', 'browser_type', {
      ref: 'e1',
      element: 'Username',
      text: '%FIXTURE_PASSWORD%',
    }),
    call('username', 'browser_type', {
      ref: 'e1',
      element: 'Username',
      text: 'admin',
    }),
    call('password-secret', 'browser_type', {
      ref: 'e2',
      element: 'Password',
      text: '%FIXTURE_PASSWORD%',
    }),
    call('role', 'browser_select', {
      ref: 'e3',
      element: 'Role',
      values: ['maintainer'],
    }),
    call('tab', 'browser_press', { key: 'Tab' }),
    call('submit', 'browser_click', { ref: 'e4', element: 'Log in' }),
  ]),
  answer('form-done', 'browser form submitted'),
  calls('edge-cases', [
    call('password', 'browser_type', {
      ref: 'e2',
      element: 'Password',
      text: 'must-not-be-typed',
    }),
    call('frame', 'browser_click', { ref: 'e5', element: 'Frame action' }),
    call('shadow', 'browser_click', { ref: 'e6', element: 'Shadow action' }),
    call('blocked', 'browser_click', { ref: 'e8', element: 'Covered button' }),
    call('open-dialog', 'browser_click', { ref: 'e7', element: 'Open prompt' }),
    call('answer-prompt', 'browser_dialog', {
      accept: true,
      text: 'fixture-answer',
    }),
    call('answer-confirm', 'browser_dialog', { accept: true }),
    call('answer-alert', 'browser_dialog', { accept: true }),
  ]),
  answer('edge-done', 'browser edge cases checked'),
  // The model believes e11 is another button: the result names the one it clicked
  calls('described-other', [
    call('described-other', 'browser_click', {
      ref: 'e11',
      element: 'Factory reset',
    }),
  ]),
  answer('described-done', 'clicked what e11 is'),
  calls('delete', [
    call('delete', 'browser_click', { ref: 'e10', element: 'Delete' }),
  ]),
  // The model takes its time; meanwhile the person answers in the conversation
  calls('after-person', [call('after-person', 'browser_snapshot', {})], 6000),
  answer('delete-done', 'the person answered the dialog'),
  calls('new-tab', [
    call('new-tab', 'browser_click', { ref: 'e9', element: 'Status link' }),
  ]),
  calls('first-tab', [
    call('first-tab', 'browser_tabs', { action: 'select', tab: 't1' }),
  ]),
  answer('tabs-done', 'browser tabs checked'),
  calls('observe', [
    call('snapshot', 'browser_snapshot', {}),
    call('screenshot', 'browser_screenshot', {}),
  ]),
  answer('observe-done', 'browser screenshot received'),
  calls('failure', [
    call('unavailable', 'browser_navigate', { url: unavailableUrl }),
  ]),
  answer('failure-done', 'browser loading failure received'),
  calls('return', [call('return', 'browser_navigate', { url })]),
  answer('return-done', 'browser exception reused'),
  calls('download', [
    call('download', 'browser_navigate', { url: url + 'download' }),
  ]),
  answer('download-done', 'browser download kept'),
  calls('files', [call('files', 'browser_navigate', { url: url + 'files' })]),
  calls('upload-ref', [
    call('upload-ref', 'browser_upload', {
      ref: 'e1',
      element: 'Attachment',
      paths: [notesPath],
    }),
  ]),
  calls('add-logs', [
    call('add-logs', 'browser_click', { ref: 'e2', element: 'Add logs' }),
  ]),
  answer('chooser-waiting', 'file chooser waiting'),
  calls('send-files', [
    call('send-files', 'browser_click', { ref: 'e3', element: 'Send' }),
  ]),
  answer('files-sent', 'files sent'),
  calls('handoff', [
    call('handoff', 'browser_handoff', {
      reason: 'sign in with your security key',
    }),
  ]),
  answer('handed', 'browser handed back'),
  calls('slow-nav', [
    call('slow-nav', 'browser_navigate', { url: url + 'slow' }),
  ]),
  calls('after-takeover', [call('after-takeover', 'browser_snapshot', {})]),
  answer('takeover-done', 'takeover checked'),
  calls('auth-nav', [
    call('auth-nav', 'browser_navigate', { url: url + 'auth' }),
  ]),
  answer('auth-seen', 'sign-in seen'),
  calls('auth-answer', [
    call('auth-answer', 'browser_dialog', {
      accept: true,
      text: 'admin',
      password: '%FIXTURE_PASSWORD%',
    }),
  ]),
  answer('auth-done', 'signed in by HTTP'),
  calls('permission-nav', [
    call('permission-nav', 'browser_navigate', { url: url + 'permission' }),
  ]),
  calls('permission-ask', [
    call('permission-ask', 'browser_click', { ref: 'e1', element: 'Ask' }),
  ]),
  answer('permission-seen', 'permission waiting'),
  calls('permission-after', [call('permission-after', 'browser_snapshot', {})]),
  answer('permission-done', 'permission answered'),
  calls('certificate-nav', [
    call('certificate-nav', 'browser_navigate', { url: url + 'held' }),
  ]),
  answer('certificate-done', 'certificate chosen'),
  calls('certificate-after', [
    call('certificate-after', 'browser_snapshot', {}),
  ]),
  answer('certificate-after-done', 'certificate request seen'),
  calls('later-nav', [
    call('later-nav', 'browser_navigate', { url: url + 'later' }),
  ]),
  calls('later-click', [
    call('later-click', 'browser_click', { ref: 'e1', element: 'Later' }),
  ]),
  answer('later-done', 'clicked later'),
  calls('later-look', [call('later-look', 'browser_snapshot', {})]),
  answer('later-look-done', 'looked after the download'),
  // Auto mode: the person's turn with the browser ends by itself, and a page's permission
  // request is refused without asking
  calls('auto-handoff', [
    call('auto-handoff', 'browser_handoff', {
      reason: 'type the code from your phone',
    }),
  ]),
  answer('auto-back', 'auto mode took the browser back'),
  calls('auto-permission-nav', [
    call('auto-permission-nav', 'browser_navigate', {
      url: otherUrl + 'permission',
    }),
  ]),
  calls('auto-permission-ask', [
    call('auto-permission-ask', 'browser_click', { ref: 'e1', element: 'Ask' }),
  ]),
  answer('auto-permission-done', 'auto mode refused notifications'),
]);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataPath,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';

const requests = (options) => readModelRequests(requestsPath, options);
const state = async () =>
  (await page.evaluate(() => window.circleDesktop.runtimeState())).snapshot;
const browserState = (sessionId) =>
  page.evaluate((id) => window.circleDesktop.browserState(id), sessionId);
async function waitFor(check, name) {
  const deadline = Date.now() + patience(20_000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function send(text) {
  await page.getByRole('textbox', { name: 'message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'send message', exact: true }).click();
}
// The page of the shown tab, as the person's own input reaches it
async function native(script) {
  return app.evaluate(async ({ BrowserWindow }, value) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const view = views.find((view) => view.getVisible()) ?? views[0];
    if (!view) throw Error('native browser view is missing');
    return view.webContents.executeJavaScript(value);
  }, script);
}
const nativeUrls = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.map((view) =>
      view.webContents.getURL(),
    ),
  );
// Close one named tab from its own page, as a page's script does
const closeView = (title) =>
  app.evaluate(({ BrowserWindow }, name) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const view = views.find((entry) => entry.webContents.getTitle() === name);
    if (!view) throw Error(`no tab titled ${name}`);
    view.webContents.executeJavaScript('window.close()');
  }, title);
// The tab’s own back-forward list, as Chromium holds it
const nativeHistory = () =>
  app.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const view = views.find((entry) => entry.getVisible()) ?? views[0];
    const history = view.webContents.navigationHistory;
    return {
      active: history.getActiveIndex(),
      entries: history.getAllEntries().map((entry) => entry.url),
    };
  });
// The tool result a call got, from the model request that followed it
const resultOf = async (id) => {
  for (const request of await requests()) {
    const message = request.messages.find(
      (row) => row.role === 'tool' && row.tool_call_id === id,
    );
    if (message) return message;
  }
  throw Error(`tool result ${id} did not reach the model`);
};
const textOf = async (id) => (await resultOf(id)).content;
async function launch() {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45_000,
  });
  // Playwright answers a page's dialogs itself unless something listens: let Circle do it
  app.context().on('page', (nativePage) => nativePage.on('dialog', () => {}));
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(20_000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // Wide enough for the panel beside the conversation, as a window made on a small
  // screen is not; or as narrow as a check asks
  viewportSizing = await setViewport(
    app,
    page,
    { width, height: 900 },
    { show: true },
  );
  await page.waitForFunction((value) => innerWidth === value, width);
  // Electron shows alert and confirm as native boxes over the window; Circle must not.
  await app.evaluate(({ dialog }) => {
    globalThis.nativeDialogs = 0;
    const show = dialog.showMessageBox;
    dialog.showMessageBox = (...args) => {
      globalThis.nativeDialogs++;
      return show.apply(dialog, args);
    };
  });
}
const nativeDialogs = () => app.evaluate(() => globalThis.nativeDialogs);
// The panel lies over the conversation at 1050 pixels or less
const width = Number(process.env.CIRCLE_DESKTOP_TEST_WIDTH || 1400);
const narrow = width <= 1050;
const approval = (text) =>
  page.locator('.inline-request').filter({ hasText: text }).last();

try {
  await launch();
  const initialState = await state();
  const sessionId = initialState.activeSessionId;
  const sessionOwner = initialState.sessions.find(
    (entry) => entry.id === sessionId,
  );
  const sessionWorkspace = initialState.workspaces.find(
    (entry) => entry.id === sessionOwner?.workspaceId,
  )?.path;
  assert(
    sessionWorkspace,
    'recording file belongs to the actual active session workspace',
  );
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.runtimeConnected, true);
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);

  if (narrow) {
    // ---- a narrow window keeps the panel closed while Circle uses the browser: over the
    // conversation it would hide Circle's cards and the input box
    await send('open the local HTTPS form');
    const control = approval(url);
    await control.waitFor();
    await control
      .getByRole('button', {
        name: `allow on ${new URL(url).origin} for this session`,
        exact: true,
      })
      .click();
    const certificate = approval('trusts an untrusted certificate');
    await certificate.waitFor();
    assert.equal(await page.locator('.inspector-overlay:visible').count(), 0);
    const allowCertificate = certificate.getByRole('button', {
      name: 'allow once',
      exact: true,
    });
    await allowCertificate.scrollIntoViewIfNeeded();
    assert.equal(
      await allowCertificate.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return !!target && button.contains(target);
      }),
      true,
      'the actual certificate approval is reachable without an inspector overlay',
    );
    await allowCertificate.click();
    await page
      .getByText('browser navigation completed', { exact: true })
      .waitFor();
    // The inspector stays mounted, hidden, so its resources survive: the panel
    // must not be shown, which a DOM count cannot tell.
    assert.equal(await page.locator('.inspector-overlay:visible').count(), 0);
    assert.match(
      await textOf('proceed'),
      /Circle proceeded, approved by the user/,
    );
    assert.match(await textOf('proceed'), /Local browser form/);
    checks.push(
      "in a narrow window the browser panel stays closed while Circle uses the browser, so Circle's cards and the input box stay in reach, and Circle acts in the closed panel all the same",
    );
  } else {
    // ---- the certificate warning is a page in the tab, which the model reads and clicks
    await send('open the local HTTPS form');
    const control = approval(url);
    await control.waitFor();
    assert.match(await control.innerText(), /browser_navigate/);
    // Control is allowed site by site
    await control
      .getByRole('button', {
        name: `allow on ${new URL(url).origin} for this session`,
        exact: true,
      })
      .click();
    const certificate = approval('trusts an untrusted certificate');
    await certificate.waitFor();
    const warningUrl = (await nativeUrls()).find((value) =>
      value.startsWith('circle-warning://'),
    );
    assert(warningUrl, 'the warning page is loaded in the tab');
    const token = new URL(warningUrl).host;
    await page.getByTestId('browser-warning').waitFor();
    const navigated = await textOf('navigate');
    assert.match(navigated, /certificate is not trusted/);
    assert.match(navigated, /\[e1\] button "Advanced"/);
    assert.match(navigated, /\[e2\] button "Back to safety"/);
    assert.match(navigated, /It is the browser's page, not the site's/);
    assert(!navigated.includes('Proceed to'), 'proceed waits behind Advanced');
    const advanced = await textOf('advanced');
    assert.match(advanced, /\[e1\] button "Hide advanced"/);
    assert.match(advanced, /\[e2\] button "Back to safety"/);
    assert.match(
      advanced,
      new RegExp(`\\[e3\\] link "Proceed to ${host} \\(unsafe\\)" \\[new\\]`),
    );
    assert.match(advanced, /Circle Fixture Device/);
    const card = await certificate.innerText();
    assert(card.includes(host));
    assert(card.includes('Circle Fixture Device'));
    assert.equal(
      await certificate
        .getByRole('button', {
          name: 'always trust this certificate on this host',
          exact: true,
        })
        .count(),
      1,
    );
    // Nothing has passed the warning before the person answers
    assert(
      (await nativeUrls()).some((value) =>
        value.startsWith('circle-warning://'),
      ),
    );
    await certificate
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page
      .getByText('browser navigation completed', { exact: true })
      .waitFor();
    await page.getByTestId('browser-insecure').waitFor();
    assert.equal((await browserState(sessionId)).insecure, true);
    // A warning page nobody can answer any more is a dead page: it answers `not found`
    // to whoever goes back to it, and a page that closes its own panel by walking
    // history goes blank. So nothing of it may stay in the tab behind this point.
    const passed = await nativeHistory();
    assert(
      !passed.entries.some((entry) => entry.startsWith('circle-warning://')),
      'the passed warning left a page in the history: ' +
        JSON.stringify(passed),
    );
    checks.push(
      'a passed certificate warning leaves no dead page in the tab history',
    );
    // The page fills the panel, also in a window as tall as the screen allows, where a
    // page of fixed height left a gap: below the footer there is only the panel's own
    // padding (20) and the footer's margin (10)
    const blankBelow = async (height) => {
      await setViewport(app, page, { width, height });
      // The screen may hold less than asked: wait until the window has settled
      let settled = -1;
      for (let tries = 0; tries < 20; tries++) {
        const now = await page.evaluate(() => innerHeight);
        if (now === settled) break;
        settled = now;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return page.evaluate(() => {
        const bottom = (selector) =>
          document.querySelector(selector).getBoundingClientRect().bottom;
        const children = [...document.querySelector('.native-browser').children]
          .map((child) => child.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        // Diagnostics/download/capture controls follow the page status footer.
        // They occupy real panel space; only the gap after all visible content is blank.
        const contentBottom = Math.max(...children.map((rect) => rect.bottom));
        return {
          height: innerHeight,
          footerGap:
            bottom('.inspector-body') - bottom('.native-browser-footer'),
          blank: bottom('.inspector-body') - contentBottom,
          contentBottom,
          containerBottom: bottom('.inspector-body'),
        };
      });
    };
    const tallest = await app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workAreaSize.height,
    );
    for (const height of [tallest, 900]) {
      const panel = await blankBelow(height);
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .waitFor({ state: 'visible' });
      assert(
        panel.contentBottom <= panel.containerBottom + 2,
        'browser controls stay inside the inspector',
      );
      assert(
        panel.blank <= 32,
        `blank under the browser panel: ${JSON.stringify(panel)}`,
      );
    }
    // Back to the size the window started at: 900 high, or what a smaller screen allows
    const firstSnapshot = await textOf('proceed');
    assert.match(firstSnapshot, /Circle proceeded, approved by the user/);
    for (const text of [
      'Local browser form',
      'Username',
      'Frame action',
      'Shadow action',
      'Status in new tab',
    ])
      assert(firstSnapshot.includes(text), `snapshot includes ${text}`);
    assert.match(firstSnapshot, /\[e2\] password "Password" filled/);
    assert.match(firstSnapshot, /\[e10\] button "Delete configuration"/);
    assert.match(firstSnapshot, /\| Device \| Ready \|/);
    assert(!firstSnapshot.includes('fixture-secret-never-in-snapshot'));
    assert(!firstSnapshot.includes('Hidden action'));
    assert(!(await readFile(requestsPath, 'utf8')).includes(token));
    checks.push(
      'an untrusted certificate shows the browser warning in the tab; the model reads it, opens Advanced and clicks proceed, which waits for the person in the conversation; the token never reaches the model',
    );

    // ---- forms, input and the visible pointer; a saved secret typed by name
    assert.equal(
      (
        await page.evaluate(
          (payload) =>
            window.circleDesktop.runtimeCommand({
              id: crypto.randomUUID(),
              name: 'save-secret',
              payload,
            }),
          { name: 'FIXTURE_PASSWORD', value: 'secret-from-circle' },
        )
      ).ok,
      true,
    );
    await send('fill username, choose a role and submit');
    await page.getByText('browser form submitted', { exact: true }).waitFor();
    await waitFor(() => posts.length === 1, 'real HTTPS POST');
    assert.equal(posts[0].username, 'admin');
    assert.equal(posts[0].role, 'maintainer');
    assert.equal(posts[0].password, 'secret-from-circle');
    assert.match(
      await textOf('echo'),
      /\[e1\] textbox "Username" value="%FIXTURE_PASSWORD%"/,
    );
    assert.match(
      await textOf('password-secret'),
      /Typed secret FIXTURE_PASSWORD into e2/,
    );
    assert.match(await textOf('password-secret'), /password "Password" filled/);
    assert.equal(
      (await readFile(requestsPath, 'utf8')).includes('secret-from-circle'),
      false,
    );
    assert.match(await textOf('submit'), /Submitted admin as maintainer/);
    // Each result names the element as the snapshot does, never the secret
    assert.match(
      await textOf('password-secret'),
      /### Result\nTyped secret FIXTURE_PASSWORD into e2 password "Password"\./,
    );
    assert.match(
      await textOf('role'),
      /### Result\nChose "maintainer" in e3 combobox "Role"\./,
    );
    assert.match(
      await textOf('submit'),
      /### Result\nClicked e4 button "Log in"\./,
    );
    const overlay = await native(`(() => {
    const host = document.querySelector('[data-circle-browser-overlay]');
    return {exists: Boolean(host), closed: Boolean(host) && host.shadowRoot === null, pointerEvents: host && getComputedStyle(host).pointerEvents};
  })()`);
    assert.deepEqual(overlay, {
      exists: true,
      closed: true,
      pointerEvents: 'none',
    });
    checks.push(
      'one session approval covers typing, selection, keys and real clicks; a saved secret written as %NAME% goes into the password field, reaches the HTTPS server and never the model, and shows as %NAME% where the page echoes it; the pointer overlay is closed and lets input through',
    );

    // ---- page dialogs, answered by the model, never as native boxes
    await send(
      'check password refusal, frames, shadow roots, cover and prompt',
    );
    await page
      .getByText('browser edge cases checked', { exact: true })
      .waitFor();
    assert.match(
      await textOf('password'),
      /a password field takes only a saved secret/,
    );
    assert.match(await textOf('blocked'), /covered by .*Fixture blocker/);
    const opened = await textOf('open-dialog');
    assert.match(opened, /It opened dialog d1/);
    assert.match(
      opened,
      /\[d1\] prompt · tab t1 .*"Fixture prompt" \(default answer "default"\)/,
    );
    assert.match(opened, /The page waits for dialog d1; this is the dialog/);
    assert.match(
      await textOf('answer-prompt'),
      /\[d2\] confirm .*"Fixture confirm"/,
    );
    assert.match(
      await textOf('answer-confirm'),
      /\[d3\] alert .*"Fixture alert"/,
    );
    assert.match(
      await textOf('answer-alert'),
      /dialog d3 \(alert\) accepted by Circle/,
    );
    assert.equal(
      await native(`document.querySelector('#password').value`),
      'secret-from-circle',
    );
    assert.equal(await native('window.blockedClicks || 0'), 0);
    assert.equal(
      await native(
        `document.querySelector('iframe').contentDocument.querySelector('button').textContent`,
      ),
      'Frame clicked',
    );
    assert.equal(
      await native(
        `document.querySelector('#shadow').shadowRoot.querySelector('button').textContent`,
      ),
      'Shadow clicked',
    );
    assert.equal(
      await native(`document.querySelector('#dialog-result').textContent`),
      'fixture-answer',
    );
    assert.equal(await nativeDialogs(), 0);
    checks.push(
      'prompt, confirm and alert wait in the tab for browser_dialog, each named with its message and origin; no native box appears; passwords, covered controls, frames and shadow roots behave as before',
    );

    // ---- a ref the model took for another element: the result names the one clicked
    await send('press the factory reset button');
    await page.getByText('clicked what e11 is', { exact: true }).waitFor();
    assert.match(
      await textOf('described-other'),
      /### Result\nClicked e11 button "Restart device" — you described it as "Factory reset"; check the snapshot\./,
    );
    assert.equal(await native('window.restarts || 0'), 1);
    // The pointer's label shows the person the page's name too
    assert.equal(
      await app.evaluate(async ({ BrowserWindow }) => {
        const views = BrowserWindow.getAllWindows()[0].contentView.children;
        const view = views.find((view) => view.getVisible()) ?? views[0];
        return view.webContents.executeJavaScriptInIsolatedWorld(1001, [
          { code: 'window.circleBrowser.bubble.textContent' },
        ]);
      }),
      'click Restart device',
    );
    checks.push(
      "an action's result names the element its ref acted on, as the snapshot does, and says when the model described another; the pointer shows the page's name",
    );

    // ---- a dialog the person answers in the conversation while the model works
    await send('delete the configuration, then look again');
    // A click that deletes asks every time, though the site is allowed for the session
    const deleting = approval('which can delete');
    await deleting.waitFor();
    assert.match(await deleting.innerText(), /Delete configuration/);
    assert.equal(
      await deleting.getByRole('button', { name: /for this session/ }).count(),
      0,
    );
    await deleting
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    const asked = page.getByTestId('browser-dialog-request');
    await asked.waitFor();
    assert.match(await asked.innerText(), /Delete the configuration\?/);
    await page.getByTestId('browser-page-dialog').waitFor();
    await asked.getByRole('button', { name: 'cancel', exact: true }).click();
    await page
      .getByText('the person answered the dialog', { exact: true })
      .waitFor();
    assert.match(await textOf('delete'), /It opened dialog d4/);
    assert.match(
      await textOf('after-person'),
      /dialog d4 \(confirm\) dismissed by the user/,
    );
    assert.equal(
      await native(`document.querySelector('#delete-result').textContent`),
      'kept',
    );
    assert.equal(await nativeDialogs(), 0);
    checks.push(
      'a confirm opened by the model shows in the panel and in the conversation; the person answers it there and the model learns who answered',
    );

    // ---- new tabs
    await send('open the status page and come back');
    await page.getByText('browser tabs checked', { exact: true }).waitFor();
    const tabbed = await textOf('new-tab');
    assert.match(tabbed, /It opened tab t2, now shown/);
    assert.match(tabbed, /tab t2 opened by t1 and shown/);
    assert.match(tabbed, /- t2 \(shown\) "Device status"/);
    assert.match(tabbed, /Status: ready/);
    assert.match(await textOf('first-tab'), /- t1 \(shown\)/);
    assert.equal((await browserState(sessionId)).tabs.length, 2);
    assert.equal((await browserState(sessionId)).tab, 't1');
    await page.getByRole('tab').nth(1).waitFor();
    // The tab Circle's click opened went under the layer that takes the person's clicks
    const order = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.map((view) =>
        view.webContents.getURL().includes('circle-mask') ? 'mask' : 'tab',
      ),
    );
    assert.equal(order.at(-1), 'mask', order.join(','));
    checks.push(
      "a link that opens a new window becomes a tab shown to both, named in the result, and the model can switch back; the tab stays under the layer that takes the person's clicks",
    );

    await send('read the browser and take its screenshot');
    await page
      .getByText('browser screenshot received', { exact: true })
      .waitFor();
    const screenshot = await resultOf('screenshot');
    assert(
      screenshot.attachments?.some(
        (row) =>
          row.mime_type === 'image/png' && row.filename === 'browser.png',
      ),
    );
    assert.match(await textOf('snapshot'), /fixture-answer/);
    checks.push(
      'snapshot and screenshot run without another approval, and the browser PNG reaches the next model request',
    );
    // The panel seen whole: the page is a native view, not DOM, so it has to follow the
    // panel across the workspace and back, sitting on the box the person sees.
    const domBox = () =>
      page.evaluate(() => {
        const box = document
          .querySelector('.native-browser-viewport')
          ?.getBoundingClientRect();
        return box
          ? {
              width: Math.round(box.width),
              height: Math.round(box.height),
            }
          : null;
      });
    const viewBox = () =>
      app.evaluate(({ BrowserWindow }) => {
        const views = BrowserWindow.getAllWindows()[0].contentView.children;
        const tab = views.find(
          (view) =>
            view.getVisible() &&
            !view.webContents.getURL().includes('circle-mask'),
        );
        return tab ? tab.getBounds() : null;
      });
    const split = { dom: await domBox(), view: await viewBox() };
    assert(split.dom && split.view, 'the browser page is shown in the panel');
    await page.getByRole('button', { name: 'full view', exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const whole = { dom: await domBox(), view: await viewBox() };
    assert(
      whole.view.width > split.view.width + 40,
      `the native page grew with the panel: ${JSON.stringify([
        split.view,
        whole.view,
      ])}`,
    );
    assert(
      Math.abs(whole.view.width - whole.dom.width) <= 3 &&
        Math.abs(whole.view.height - whole.dom.height) <= 3,
      `the native page left its box: ${JSON.stringify(whole)}`,
    );
    await page
      .getByRole('button', { name: 'exit full view', exact: true })
      .click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const back = await viewBox();
    assert(
      Math.abs(back.width - split.view.width) <= 3,
      `the split did not take the page back: ${JSON.stringify([split.view, back])}`,
    );
    checks.push(
      'the full view carries the native browser page across the workspace and back, in step with its box',
    );

    await send('open the unavailable local port');
    // Another site: asked again
    const elsewhere = approval(unavailableUrl);
    await elsewhere.waitFor();
    await elsewhere
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page
      .getByText('browser loading failure received', { exact: true })
      .waitFor();
    await page.getByTestId('browser-load-failure').waitFor();
    const failure = await browserState(sessionId);
    assert.equal(failure.failure.url, unavailableUrl);
    assert.match(failure.failure.error, /ERR_CONNECTION_REFUSED/);
    assert.match(await textOf('unavailable'), /ERR_CONNECTION_REFUSED/);
    checks.push(
      'another site asks again before Circle acts there; an unavailable local port shows a load failure in the panel and tells the model',
    );

    await send('return to the HTTPS form');
    await page.getByText('browser exception reused', { exact: true }).waitFor();
    assert.doesNotMatch(await textOf('return'), /certificate is not trusted/);
    assert.equal((await browserState(sessionId)).insecure, true);
    assert.equal(
      (await state()).interactions.filter(
        (row) => row.reason === 'trusts an untrusted certificate',
      ).length,
      1,
    );
    checks.push(
      'a certificate allowed once is not asked about again until Circle closes',
    );

    // ---- downloads are kept where the result says; files reach a page only as allowed
    await send('download the report');
    const kept = join(dataPath, 'downloads', 'report.bin');
    // The model's download waits outside the downloads folder until the person keeps it
    const keep = approval('keeps a download');
    await keep.waitFor();
    assert.match(await keep.innerText(), /report\.bin \(12 B\)/);
    await page
      .getByTestId('browser-downloads')
      .getByText('waiting for approval', { exact: true })
      .waitFor();
    assert.equal(existsSync(kept), false);
    assert.equal(
      await keep
        .getByRole('button', {
          name: `allow downloads from ${new URL(url).origin} for this session`,
          exact: true,
        })
        .count(),
      1,
    );
    await keep.getByRole('button', { name: 'keep', exact: true }).click();
    await page.getByText('browser download kept', { exact: true }).waitFor();
    assert.match(
      await textOf('download'),
      /The address started download dl1 instead of opening a page\./,
    );
    assert(
      (await textOf('download')).includes(
        `download dl1 finished: ${kept} (12 B)`,
      ),
    );
    assert.equal(await readFile(kept, 'utf8'), 'report bytes');
    await page
      .getByTestId('browser-downloads')
      .getByText('report.bin', { exact: true })
      .waitFor();
    await writeFile(notesPath, 'notes from circle');
    await writeFile(logPath, 'log line');
    // The person's file dialog is stubbed: it would choose run.log
    await app.evaluate(({ dialog }, chosen) => {
      globalThis.fileDialogs = 0;
      dialog.showOpenDialog = async () => {
        globalThis.fileDialogs++;
        return { canceled: false, filePaths: [chosen] };
      };
    }, logPath);
    await send('give the form the notes and the logs');
    const files = approval('gives the page files');
    await files.waitFor();
    assert.match(await files.innerText(), /notes\.txt/);
    await files
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page.getByText('file chooser waiting', { exact: true }).waitFor();
    assert.match(
      await textOf('upload-ref'),
      /Gave "notes\.txt" \(17 B\) to e1 file "Attachment"\./,
    );
    assert.match(
      await textOf('add-logs'),
      /It opened file chooser f1: answer it with browser_upload\./,
    );
    // No system dialog opened for Circle's click; the person answers in the panel
    assert.equal(await app.evaluate(() => globalThis.fileDialogs), 0);
    const chooser = page.getByTestId('browser-chooser');
    await chooser.getByRole('button', { name: 'choose…', exact: true }).click();
    await chooser.waitFor({ state: 'hidden' });
    assert.equal(await app.evaluate(() => globalThis.fileDialogs), 1);
    await send('send the files');
    await page.getByText('files sent', { exact: true }).waitFor();
    assert.match(
      await textOf('send-files'),
      /file chooser f1 was answered by the user with "run\.log"/,
    );
    await waitFor(() => uploads.length === 1, 'multipart upload');
    assert.match(
      uploads[0],
      /name="attachment"; filename="notes\.txt"[\s\S]*notes from circle/,
    );
    assert.match(uploads[0], /name="logs"; filename="run\.log"[\s\S]*log line/);
    checks.push(
      "a download Circle starts waits for the person, then goes to the downloads folder and the panel lists it; a file for a file input asks the person in the conversation; a chooser opened by Circle's click waits in the result and in the panel, where the person chooses; the site receives both files",
    );

    // ---- taking turns: Circle hands the person the browser, and the person takes it
    await send('hand me the browser');
    const handoffCard = page.getByTestId('browser-handoff-request');
    await handoffCard.waitFor();
    // What Circle waits for is said in the conversation; the panel only says who has it
    assert.match(
      await handoffCard.innerText(),
      /sign in with your security key/,
    );
    assert.match(
      await handoffCard.innerText(),
      /When you are done, continue here or send a message/,
    );
    await page.getByTestId('browser-user').waitFor();
    assert.equal(await page.getByTestId('browser-control').count(), 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'hand back', exact: true })
        .count(),
      0,
    );
    assert.equal((await browserState(sessionId)).control, 'user');
    const bar = page.getByRole('textbox', {
      name: 'browser address',
      exact: true,
    });
    await bar.fill(url + 'status');
    await bar.press('Enter');
    await waitFor(
      async () => (await browserState(sessionId)).url === url + 'status',
      'the person goes elsewhere',
    );
    await handoffCard
      .getByRole('button', { name: 'continue', exact: true })
      .click();
    await page.getByText('browser handed back', { exact: true }).waitFor();
    assert.match(
      await textOf('handoff'),
      /### Result\nThe user handed the browser back\./,
    );
    assert(
      (await textOf('handoff')).includes(
        `tab t1 went to ${url}status while Circle was not acting`,
      ),
    );
    assert.equal((await browserState(sessionId)).control, 'shared');
    await send('open the slow page');
    await page.getByTestId('browser-operating').waitFor();
    // A click on the clear layer over the page while Circle acts
    const masked = await app.evaluate(async ({ BrowserWindow }) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children;
      const mask = views.at(-1);
      if (!mask?.webContents.getURL().includes('circle-mask'))
        return 'no layer';
      // The layer is clear: the page shows through it
      const image = await mask.webContents.capturePage();
      const alpha = image.toBitmap()[3];
      for (const type of ['mouseDown', 'mouseUp'])
        mask.webContents.sendInputEvent({
          type,
          x: 20,
          y: 20,
          button: 'left',
          clickCount: 1,
        });
      return alpha;
    });
    assert.equal(masked, 0);
    await page.getByTestId('browser-pending').waitFor();
    // The model's next look waits for the browser back, then shows the page as it is;
    // a message to Circle hands it back, and reaches the model with the page
    await handoffCard.waitFor();
    await waitFor(
      async () => (await browserState(sessionId)).waiting === true,
      "Circle's next look waits",
    );
    await send('done, go on');
    await page.getByText('takeover checked', { exact: true }).waitFor();
    assert(
      JSON.stringify((await requests()).at(-1)).includes('done, go on'),
      'the message reached the model',
    );
    assert.match(await textOf('slow-nav'), /the user took over the browser/);
    assert.match(
      await textOf('after-takeover'),
      /Nothing was done: the user had the browser and has handed it back\./,
    );
    assert.equal((await browserState(sessionId)).control, 'shared');
    checks.push(
      "the model hands the person the browser and learns only where the tabs went; the person's click on the layer over the page takes it once Circle's action ends, and Circle's next look waits for it back",
    );

    // ---- an HTTP sign-in waits in the tab for whoever answers it: the person in the
    // panel, or the model with a saved secret
    const origin = new URL(url).origin;
    await send('open the admin page');
    await page.getByText('sign-in seen', { exact: true }).waitFor();
    const authNav = await textOf('auth-nav');
    assert.match(authNav, /The site asks for a sign-in: dialog d\d+\./);
    assert.match(authNav, /textbox "Username" → browser_dialog text/);
    const signIn = page.getByTestId('browser-page-dialog');
    await signIn.waitFor();
    assert.match(await signIn.innerText(), new RegExp(`sign in to ${origin}`));
    assert.match(await signIn.innerText(), /Circle fixture admin/);
    const firstSignIn = (await browserState(sessionId)).dialogs[0].id;
    // The sign-in in both palettes
    await page.screenshot({ path: join(output, 'browser-sign-in.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(output, 'browser-sign-in-dark.png') });
    await page.emulateMedia({ colorScheme: null });
    await signIn
      .getByRole('textbox', { name: 'user name', exact: true })
      .fill('admin');
    await signIn.getByLabel('password', { exact: true }).fill('wrong-password');
    await signIn.getByRole('button', { name: 'sign in', exact: true }).click();
    await waitFor(async () => {
      const dialogs = (await browserState(sessionId)).dialogs;
      return (
        dialogs.length === 1 &&
        dialogs[0].type === 'auth' &&
        dialogs[0].id !== firstSignIn
      );
    }, 'the site asks again');
    await send('sign in with the saved password');
    await page.getByText('signed in by HTTP', { exact: true }).waitFor();
    const authAnswer = await textOf('auth-answer');
    assert.match(
      authAnswer,
      new RegExp(`Answered sign-in d\\d+ for ${origin} as "admin"\\.`),
    );
    assert.match(authAnswer, /admin page signed in/);
    assert(
      authAnswer.includes(
        `sign-in ${firstSignIn} for ${origin} answered by the user`,
      ),
    );
    assert.deepEqual(authorizations, [
      '',
      'admin:wrong-password',
      'admin:secret-from-circle',
    ]);
    assert(!JSON.stringify(await requests()).includes('secret-from-circle'));
    assert(!JSON.stringify(await requests()).includes('wrong-password'));
    checks.push(
      "an HTTP sign-in waits in the tab: the person's answer in the panel reaches the site and the model learns only that they answered; the model answers with a saved secret, which the site gets and the model never sees",
    );

    // ---- a page's permission request waits for the person alone
    await send('ask for notifications');
    await page.getByText('permission waiting', { exact: true }).waitFor();
    assert.match(
      await textOf('permission-ask'),
      new RegExp(
        `### Permission requests waiting\\n- \\[p1\\] tab t\\d+ · ${origin} asks to show notifications: only the user answers`,
      ),
    );
    const permission = page.getByTestId('browser-permission');
    await permission.waitFor();
    assert.match(
      await permission.innerText(),
      new RegExp(`${origin} wants to show notifications`),
    );
    await page.screenshot({ path: join(output, 'browser-permission.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: join(output, 'browser-permission-dark.png'),
    });
    await page.emulateMedia({ colorScheme: null });
    await permission
      .getByRole('button', { name: 'allow', exact: true })
      .click();
    await permission.waitFor({ state: 'hidden' });
    await waitFor(
      async () =>
        (await native(`document.getElementById('out').textContent`)) ===
        'notifications: granted',
      'the page is allowed',
    );
    assert.equal(await native('Notification.permission'), 'granted');
    await send('look again');
    await page.getByText('permission answered', { exact: true }).waitFor();
    const afterPermission = await textOf('permission-after');
    assert(
      afterPermission.includes(
        `permission request p1 (${origin} to show notifications) allowed by the user`,
      ),
    );
    assert.match(afterPermission, /notifications: granted/);
    checks.push(
      "a page's permission request waits in the panel for the person alone; the model sees it waiting and then the answer, and the page gets it",
    );

    // ---- a site's request for a client certificate waits for the person's choice. The
    // system's store is not touched: the request is raised on the tab as Electron raises it.
    const askCertificate = () =>
      app.evaluate(
        ({ BrowserWindow }, [address, list]) => {
          const view =
            BrowserWindow.getAllWindows()[0].contentView.children.find(
              (entry) =>
                entry.getVisible() &&
                entry.webContents.getURL().startsWith('https:'),
            );
          globalThis.chosenCertificate = undefined;
          view.webContents.emit(
            'select-client-certificate',
            { preventDefault() {} },
            address,
            list,
            (certificate) => {
              globalThis.chosenCertificate = certificate
                ? certificate.subjectName
                : 'none';
            },
          );
        },
        [url, clientCertificates],
      );
    const chosenCertificate = () =>
      app.evaluate(() => globalThis.chosenCertificate);
    await send('open the device page and identify yourself');
    await page.getByTestId('browser-operating').waitFor();
    await askCertificate();
    const choicePanel = page.getByTestId('browser-certificate-choice');
    await choicePanel.waitFor();
    // Circle's action waits for the person; nothing covers the choice in the panel
    await page.getByTestId('browser-certificate-request').waitFor();
    assert.match(
      await choicePanel.innerText(),
      new RegExp(`${origin} asks for a certificate to identify you`),
    );
    assert.match(
      await choicePanel.innerText(),
      /CN=Circle Fixture Operator, O=Circle client fixture/,
    );
    // Each place has its own choice, the first certificate to begin with
    for (const place of [
      choicePanel,
      page.getByTestId('browser-certificate-request'),
    ])
      assert.equal(await place.getByRole('radio').first().isChecked(), true);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.find((view) =>
            view.webContents.getURL().includes('circle-mask'),
          )
          ?.getVisible(),
      ),
      false,
    );
    await page.waitForTimeout(1000);
    assert.equal(
      await page.getByText('certificate chosen', { exact: true }).count(),
      0,
    );
    await page.screenshot({ path: join(output, 'browser-certificate.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: join(output, 'browser-certificate-dark.png'),
    });
    await page.emulateMedia({ colorScheme: null });
    await choicePanel
      .getByText('CN=Circle Fixture Admin, O=Circle client fixture', {
        exact: true,
      })
      .click();
    await choicePanel.getByRole('button', { name: 'OK', exact: true }).click();
    await waitFor(
      async () => (await chosenCertificate()) === 'Circle Fixture Admin',
      'the chosen certificate reaches the site',
    );
    releaseHeld();
    await page.getByText('certificate chosen', { exact: true }).waitFor();
    const certificateNav = await textOf('certificate-nav');
    assert(
      certificateNav.includes(
        `client certificate request c1 from ${origin}: the user chose "CN=Circle Fixture Admin, O=Circle client fixture", issued by "CN=Circle Fixture Admin, O=Circle client fixture"`,
      ),
      certificateNav,
    );
    assert.match(certificateNav, /### Result\nLoaded\./);
    // Asked while Circle does not act: the person sends none, and the model learns it
    await askCertificate();
    await choicePanel.waitFor();
    await choicePanel
      .getByRole('button', { name: 'send none', exact: true })
      .click();
    await choicePanel.waitFor({ state: 'hidden' });
    assert.equal(await chosenCertificate(), 'none');
    await send('look again');
    await page.getByText('certificate request seen', { exact: true }).waitFor();
    assert(
      (await textOf('certificate-after')).includes(
        `client certificate request c2 from ${origin}: the user sent no certificate`,
      ),
    );
    checks.push(
      "a site's request for a client certificate waits in the panel and the conversation for the person alone, with nothing over it; Circle's action waits for the choice, which the site gets, and the model learns only which certificate or none",
    );

    // ---- a download the page starts after Circle's turn ended waits; the person keeps it
    await send('click later');
    await page.getByText('clicked later', { exact: true }).waitFor();
    const downloadsList = page.getByTestId('browser-downloads');
    await downloadsList
      .getByText('waiting for approval', { exact: true })
      .waitFor();
    await downloadsList
      .getByRole('button', { name: 'keep', exact: true })
      .click();
    const laterFile = join(dataPath, 'downloads', 'report (1).bin');
    await waitFor(() => existsSync(laterFile), 'the kept download');
    assert.equal(await readFile(laterFile, 'utf8'), 'report bytes');
    await send('look again');
    await page
      .getByText('looked after the download', { exact: true })
      .waitFor();
    const looked = await textOf('later-look');
    assert(
      looked.includes(`the user kept the downloads from ${origin}`),
      looked,
    );
    assert(looked.includes(`finished: ${laterFile}`), looked);
    checks.push(
      "a download a page starts a moment after Circle's click is still Circle's: it waits, and the person keeps it in the panel when Circle's turn has ended",
    );

    // ---- the person's own click on proceed needs no approval, on another port
    const address = page.getByRole('textbox', {
      name: 'browser address',
      exact: true,
    });
    await address.fill(otherUrl);
    await address.press('Enter');
    await page.getByTestId('browser-warning').waitFor();
    await native(`document.getElementById('advanced').click()`);
    await native(`document.getElementById('proceed').click()`);
    await page.getByTestId('browser-insecure').waitFor();
    assert.equal((await browserState(sessionId)).url, otherUrl);
    assert(
      (await state()).interactions.every((row) => row.status !== 'pending'),
    );
    checks.push(
      'the same certificate on another port warns again, and the person passes it in the tab without an approval',
    );

    // ---- auto mode: the person's turn with the browser ends by itself once they stop,
    // and a page's permission request is refused without asking
    const setMode = (mode) =>
      page.evaluate(async (mode) => {
        const current = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'set-mode',
          payload: { mode },
          sessionId: current.snapshot.activeSessionId,
        });
      }, mode);
    await setMode('auto');
    await send('hand me the browser in auto mode');
    await handoffCard.waitFor();
    assert.match(
      await handoffCard.innerText(),
      /Circle goes on by itself once you are done/,
    );
    // The person types in the page, then stops
    const typed = await app.evaluate(({ BrowserWindow }, address) => {
      const tab = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (view) => view.webContents.getURL().startsWith(address),
      );
      if (!tab) return false;
      for (const type of ['keyDown', 'char', 'keyUp'])
        tab.webContents.sendInputEvent({ type, keyCode: 'a' });
      return true;
    }, otherUrl);
    assert.equal(typed, true);
    const stopped = Date.now();
    await page
      .getByText('auto mode took the browser back', { exact: true })
      .waitFor({ timeout: 30_000 });
    assert(Date.now() - stopped >= 4000, 'it waits for the person to stop');
    const autoBack = await textOf('auto-handoff');
    assert.match(
      autoBack,
      /### Result\nCircle took the browser back in auto mode\./,
    );
    assert.match(
      autoBack,
      /- auto mode: Circle took the browser back, as the user stopped/,
    );
    await send('ask for notifications on the other port');
    await page
      .getByText('auto mode refused notifications', { exact: true })
      .waitFor();
    assert.match(
      await textOf('auto-permission-ask'),
      new RegExp(
        `auto mode: ${new URL(otherUrl).origin} asked for notifications; Circle refused it without asking`,
      ),
    );
    assert.equal(await page.getByTestId('browser-permission').count(), 0);
    assert(
      (await state()).interactions.every((row) => row.status !== 'pending'),
    );
    assert.equal(
      await native(`document.getElementById('out').textContent`),
      'notifications: denied',
    );
    await setMode('manual');
    checks.push(
      "auto mode takes the browser back once the person stops, says so to the model, and refuses a page's permission request without asking",
    );
    assert.deepEqual(errors, []);
    // The address draft belongs to the shown tab, even when navigation fails before loading.
    const draftAddress = page.getByRole('textbox', {
      name: 'browser address',
      exact: true,
    });
    const priorBrowser = await browserState(sessionId);
    await draftAddress.fill('invalid://circle-fixture');
    await draftAddress.press('Enter');
    await page.getByText('invalid address', { exact: true }).waitFor();
    const rejectedAddress = await browserState(sessionId);
    assert.equal(rejectedAddress.url, priorBrowser.url);
    assert.equal(rejectedAddress.tab, priorBrowser.tab);
    await page.getByRole('button', { name: 'new tab', exact: true }).click();
    await waitFor(
      async () => (await draftAddress.inputValue()) === '',
      'new tab clears failed address draft',
    );
    await page.evaluate(
      ({ id, tab }) => window.circleDesktop.browserTabs(id, 'select', tab),
      { id: sessionId, tab: priorBrowser.tab },
    );
    await waitFor(
      async () => (await draftAddress.inputValue()) === priorBrowser.url,
      'switch restores real tab address',
    );
    checks.push(
      'failed address drafts clear on new tabs and follow the selected tab',
    );
    await app.evaluate(() => {
      globalThis.closeErrors = [];
      globalThis.closeListener = (error) =>
        globalThis.closeErrors.push(error.message);
      process.on('uncaughtException', globalThis.closeListener);
    });
    await page.evaluate(
      ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
      { id: sessionId, url: url + 'close-opener' },
    );
    const openerState = await browserState(sessionId);
    await native('void window.open("/close-popup")');
    await waitFor(
      async () =>
        (await browserState(sessionId)).tabs.length ===
        openerState.tabs.length + 1,
      'popup adopted',
    );
    // A tab a page opened may close itself, as in any browser.
    await closeView('Self closing popup');
    await waitFor(
      async () =>
        (await browserState(sessionId)).tabs.length === openerState.tabs.length,
      'self-closed popup removed',
    );
    // A tab the person or Circle opened is not the page's to close away: Chrome refuses
    // that, and so does Circle - otherwise a site that ends a side panel with
    // window.close() would empty the browser panel under the person.
    await closeView('Close fixture opener');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      (await browserState(sessionId)).tabs.length,
      openerState.tabs.length,
      'a page closed a tab it did not open',
    );
    assert.deepEqual(await app.evaluate(() => globalThis.closeErrors), []);
    await app.evaluate(() =>
      process.removeListener('uncaughtException', globalThis.closeListener),
    );
    const closedState = await browserState(sessionId);
    assert.ok(closedState.tabs.some((tab) => tab.id === closedState.tab));
    await page.evaluate(
      ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
      { id: sessionId, url },
    );
    assert.equal((await browserState(sessionId)).url, url);
    checks.push(
      'a popup can close itself and a tab the browser opened cannot, without a main-process exception; tabs, address and subsequent navigation recover',
    );
    await page.screenshot({ path: join(output, 'browser-live.png') });
    await app.close();
    app = undefined;
    await requests({ requireComplete: true });

    // ---- after a restart: allowed once is forgotten; the person's way back reaches the model
    requestsPath = join(temp, 'restart-requests.jsonl');
    await script([
      calls('restart-navigate', [
        call('restart-navigate', 'browser_navigate', { url }),
      ]),
      answer('restart-warning', 'warning seen after restart'),
      calls('again', [call('again', 'browser_navigate', { url })]),
      calls('again-advanced', [
        call('again-advanced', 'browser_click', {
          ref: 'e1',
          element: 'Advanced',
        }),
      ]),
      calls('again-proceed', [
        call('again-proceed', 'browser_click', {
          ref: 'e3',
          element: 'Proceed',
        }),
      ]),
      answer('trusted', 'certificate trusted for good'),
    ]);
    await launch();
    assert.equal((await state()).activeSessionId, sessionId);
    // The session's "allow for this session" answer is kept with it across restarts
    await send('open the form after the restart');
    await page
      .getByText('warning seen after restart', { exact: true })
      .waitFor();
    assert.match(
      await textOf('restart-navigate'),
      /certificate is not trusted/,
    );
    await native(`document.getElementById('back').click()`);
    await page.getByTestId('browser-warning').waitFor({ state: 'hidden' });
    await send('try again and trust it for good');
    await approval('trusts an untrusted certificate')
      .getByRole('button', {
        name: 'always trust this certificate on this host',
        exact: true,
      })
      .click();
    await page
      .getByText('certificate trusted for good', { exact: true })
      .waitFor();
    assert.match(await textOf('again'), /the user went back to safety/);
    assert.match(
      await textOf('again-proceed'),
      /trusted on this host from now on/,
    );
    const trusted = JSON.parse(
      await readFile(join(dataPath, 'browser-certificates.json'), 'utf8'),
    );
    assert.deepEqual(
      trusted.certificates.map((entry) => entry.host),
      [host],
    );
    checks.push(
      'an exception allowed once ends with Circle; the person going back reaches the model as an event; trusting for good is saved for this host and certificate',
    );
    await app.close();
    app = undefined;
    await requests({ requireComplete: true });

    requestsPath = join(temp, 'trusted-requests.jsonl');
    // Record actual earlier browser actions, then clean the recording in the original editor.
    const replayFile = 'fixture.circle-browser.json';
    const replayPath = join(sessionWorkspace, replayFile);
    await script([
      calls('trusted-navigate', [
        call('trusted-navigate', 'browser_navigate', { url }),
      ]),
      answer('trusted-done', 'trusted site opened'),
      calls('record-native', [
        call('record-native', 'browser_record', {
          path: replayFile,
          name: 'fixture form',
        }),
      ]),
      answer('record-native-done', 'actual browser actions recorded'),
      calls('replay-failure', [
        call('replay-failure', 'browser_replay', { path: replayFile }),
      ]),
      answer('replay-failure-done', 'replay failure inspected'),
      calls('replay', [
        call('replay', 'browser_replay', { path: replayFile, from: 7 }),
      ]),
      answer('replay-done', 'replay finished'),
    ]);
    await launch();
    await send('open the trusted site');
    await page.getByText('trusted site opened', { exact: true }).waitFor();
    const trustedResult = await textOf('trusted-navigate');
    assert.doesNotMatch(trustedResult, /certificate is not trusted/);
    assert.match(trustedResult, /Local browser form/);
    assert.equal((await browserState(sessionId)).insecure, true);
    checks.push(
      'a certificate trusted for good opens without a warning after another restart',
    );

    await send('record the actual browser actions to a script');
    const recordCard = page
      .locator('.inline-request')
      .filter({ hasText: 'browser_record' });
    await recordCard.waitFor();
    await recordCard
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page
      .getByText('actual browser actions recorded', { exact: true })
      .waitFor();
    const recorded = JSON.parse(await readFile(replayPath, 'utf8'));
    assert.match(await textOf('record-native'), /Recorded \d+ steps? in /);
    const firstSubmit = recorded.steps.findIndex(
      (step) => step.click?.role === 'button' && step.click.name === 'Log in',
    );
    assert(
      firstSubmit > 0,
      'the recording includes the actual successful form submission',
    );
    const formSteps = recorded.steps.slice(0, firstSubmit + 1);
    const username = formSteps
      .filter((step) => step.type?.name === 'Username')
      .at(-1);
    const password = formSteps.find((step) => step.type?.role === 'password');
    const role = formSteps.find((step) => step.select?.name === 'Role');
    const proceed = formSteps.find((step) => step.proceed === 'certificate');
    assert(
      username && password && role && proceed,
      'real recording retains semantic controls and approved certificate step',
    );
    assert.equal(password.text, '%FIXTURE_PASSWORD%');
    const edited = {
      ...recorded,
      name: 'fixture form',
      steps: [
        { ...formSteps.find((step) => 'navigate' in step), navigate: otherUrl },
        proceed,
        { ...username, text: 'replayed' },
        password,
        role,
        formSteps[firstSubmit],
        { expect: 'INTENTIONAL_MISSING_BROWSER_ASSERTION' },
      ],
    };
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const editScript = async (content) => {
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
      await page
        .locator('.file-tree')
        .getByRole('button', {
          name: 'fixture.circle-browser.json',
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: 'edit', exact: true }).click();
      const lines = page.locator('.file-view:visible .view-lines');
      await lines.click();
      const clipboardKey = await preserveNativeClipboard(app);
      let primary;
      try {
        await page.keyboard.press(`${modifier}+a`);
        await app.evaluate(async ({ clipboard }, text) => {
          await clipboard.writeText(text);
        }, content);
        await page.keyboard.press(`${modifier}+v`);
        await page
          .locator('.file-view')
          .getByText('unsaved changes', { exact: true })
          .waitFor();
        await page.keyboard.press(`${modifier}+s`);
        await waitFor(
          async () => (await readFile(replayPath, 'utf8')) === content,
          'real Monaco saves the edited recorded script',
        );
        await page
          .getByRole('button', { name: 'close file', exact: true })
          .click();
      } catch (error) {
        primary = error;
      } finally {
        try {
          await restoreNativeClipboard(app, clipboardKey);
        } catch (cleanup) {
          throw primary
            ? new AggregateError(
                [primary, cleanup],
                'recorded script editing and clipboard restoration failed',
              )
            : cleanup;
        }
      }
      if (primary) throw primary;
    };
    await editScript(JSON.stringify(edited, null, 2) + '\n');
    checks.push(
      'actual browser_record writes semantic actions and the original editor edits the recorded file without exposing secret bytes',
    );
    // ---- the first replay fails only at the added assertion after the original seven-step effects
    const before = posts.length;
    await send('replay the recorded fixture form with its assertion');
    const replayCard = approval('runs a recorded browser script');
    await replayCard.waitFor();
    assert.match(await replayCard.innerText(), /browser_replay/);
    assert(
      (await replayCard.innerText()).includes(new URL(otherUrl).origin),
      'the card names the site the script starts on',
    );
    await replayCard
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await approval('trusts an untrusted certificate')
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page.getByText('replay failure inspected', { exact: true }).waitFor();
    const failed = await textOf('replay-failure');
    assert.match(failed, /Step 7 of 7 could not be done/);
    assert.match(
      failed,
      /Reason: the page does not show "INTENTIONAL_MISSING_BROWSER_ASSERTION"/,
    );
    assert.match(failed, /Steps 1–6 were done/);
    assert.match(failed, /2\. Clicked e\d+ link "Proceed to /);
    assert.match(
      failed,
      /Typed secret FIXTURE_PASSWORD into e2 password "Password"/,
    );
    assert.match(failed, /Circle proceeded, approved by the user/);
    assert.match(failed, /Snapshot/);
    const failureGroup = page
      .locator('.tool-group')
      .filter({ hasText: '1 failed' })
      .last();
    const groupToggle = failureGroup.locator(':scope > .tool-summary');
    if ((await groupToggle.getAttribute('aria-expanded')) !== 'true')
      await groupToggle.click();
    const failureTool = failureGroup
      .locator('.tool-call')
      .filter({ has: page.locator('code[title="browser_replay"]') });
    assert.equal(
      await failureTool.count(),
      1,
      'the latest failed group exposes the actual replay call',
    );
    const failureHead = failureTool.locator('.tool-head');
    if ((await failureHead.getAttribute('aria-expanded')) !== 'true')
      await failureHead.click();
    await failureTool.locator('.tool-content').waitFor({ state: 'visible' });
    assert.match(
      await failureTool.locator('.tool-content').innerText(),
      /Step 7 of 7 could not be done/,
    );
    await page.screenshot({
      path: join(output, 'replay-failed-step-before-edit.png'),
    });

    const browserBeforeFix = await browserState(sessionId);
    edited.steps[6].expect = 'Submitted admin as maintainer';
    await editScript(JSON.stringify(edited, null, 2) + '\n');
    await send('continue the repaired browser script from failed step seven');
    const retryApproval = approval('runs a recorded browser script');
    await retryApproval
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await page.getByText('replay finished', { exact: true }).waitFor();
    const replayed = await textOf('replay');
    assert.match(replayed, /^Replayed "fixture form": steps 7–7 of 7 done\./);
    assert.match(
      replayed,
      /7\. The page shows "Submitted admin as maintainer"/,
    );
    const browserAfterFix = await browserState(sessionId);
    assert.equal(browserAfterFix.sessionId, browserBeforeFix.sessionId);
    assert.equal(browserAfterFix.tab, browserBeforeFix.tab);
    checks.push(
      'recorded replay failure names the precise assertion and current page; the same script is repaired in Monaco and resumes only step seven in the same browser',
    );
    assert.equal(posts.length, before + 1);
    assert.deepEqual(posts.at(-1), {
      username: 'replayed',
      password: 'secret-from-circle',
      role: 'maintainer',
    });
    assert.equal(
      (await readFile(requestsPath, 'utf8')).includes('secret-from-circle'),
      false,
    );
    checks.push(
      "a recorded browser script replays in the panel without the model in between: one approval for the site it starts on, Circle's certificate warning passed with the person's approval, a secret typed by name, and the form's POST reaches the site",
    );
    assert.deepEqual(errors, []);
  }
  await requests({ requireComplete: true });
  await writeFile(
    join(
      output,
      info.packaged ? 'packaged-receipt.json' : 'development-receipt.json',
    ),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'live',
        packaged: info.packaged,
        dataIsolation: true,
        scriptedModel: true,
        localHttps: true,
        viewportSizing,
        checks,
        errors,
        source: await sourceEvidence(),
        renderer: await rendererEvidence(root),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { checks: checks.length, packaged: info.packaged, output },
      null,
      2,
    ),
  );
} catch (error) {
  try {
    const model = await readFile(requestsPath);
    await writeFile(join(output, 'failure-model.jsonl'), model);
    // Retain raw bytes, including any in-flight tail; diagnose complete records only.
    const last = parseModelRequestFrames(model).at(-1);
    if (last)
      console.error(
        last.messages
          .filter((row) => row.role === 'tool')
          .slice(-3)
          .map(
            (row) =>
              `${row.tool_call_id}: ${String(row.content).slice(0, 1500)}`,
          )
          .join('\n---\n'),
      );
  } catch (diagnosticError) {
    console.error('model request diagnostic failed:', String(diagnosticError));
  }
  try {
    await captureFailure(page, error, errors, output);
  } catch (diagnosticError) {
    console.error('failure capture failed:', String(diagnosticError));
  }
  throw error;
} finally {
  if (app) await app.close();
  for (const server of [site, other]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
