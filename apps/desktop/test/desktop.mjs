import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/desktop');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-desktop-qa-'));
const workspace = join(temp, 'project');
await mkdir(workspace);
const attachment = join(temp, 'note.md');
await writeFile(
  attachment,
  '# native attachment\nselected by the desktop test',
);
await writeFile(
  join(workspace, 'hello.ts'),
  'export const hello = "native workspace";\n',
);
const exportPath = join(temp, 'export.md');
const profile = { files: [attachment], workspace, exportPath };
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify(profile),
};
delete env.ELECTRON_RUN_AS_NODE;
const site = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    '<!doctype html><title>Circle native browser fixture</title><h1>same browser session</h1><p>isolated desktop verification</p>',
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteUrl = 'http://127.0.0.1:' + site.address().port;
const checks = [];
const errors = [];
let app;
let page;
let originalClipboard;
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [process.env.CIRCLE_DESKTOP_APP_PATH ?? root],
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  observePage(page, errors);
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor({ timeout: 30000 });
  if (process.env.CIRCLE_DESKTOP_CHECK_NARROW) {
    await page.waitForURL(/^circle:\/\/workbench/);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1024, 650),
    );
    await page.waitForFunction(() => innerWidth <= 1024 && innerHeight <= 650);
    await page.reload();
  }
  await page
    .getByRole('heading', { name: 'Fix the reconnect race' })
    .waitFor({ timeout: 30000 });
  assert.ok(page.url().startsWith('circle://workbench/index.html'));
  const info = await page.evaluate(() => window.circleDesktop.info());
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.equal(info.kind, 'desktop');
  assert.equal(info.frontendOnly, true);
  assert.equal(info.runtimeConnected, false);
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);
  const isolation = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    ipc: typeof window.ipcRenderer,
    keys: Object.keys(window.circleDesktop),
  }));
  assert.equal(isolation.node, 'undefined');
  assert.equal(isolation.process, 'undefined');
  assert.equal(isolation.ipc, 'undefined');
  assert.ok(!isolation.keys.includes('invoke'));
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const prefs = contents.getLastWebPreferences();
    return {
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      sandbox: prefs.sandbox,
      webSecurity: prefs.webSecurity,
    };
  });
  assert.deepEqual(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  checks.push(
    'native application origin, isolated data and restricted renderer',
  );
  if (
    !(await page
      .getByRole('button', { name: 'browser panel', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'toggle inspector', exact: true })
      .click();
  await page
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .fill(siteUrl);
  await page
    .getByRole('button', { name: 'navigate browser', exact: true })
    .click();
  await page.getByText('native browser', { exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const state = await window.circleDesktop.browserState('session1');
    return !state.loading && state.title === 'Circle native browser fixture';
  });
  const browserState = await page.evaluate(() =>
    window.circleDesktop.browserState('session1'),
  );
  const browserIdentity = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(
      (view) => view.webContents && view.webContents !== window.webContents,
    );
    const prefs = view.webContents.getLastWebPreferences();
    return {
      id: view.webContents.id,
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
      contextIsolation: prefs.contextIsolation,
      preload: prefs.preload,
    };
  });
  assert.equal(browserIdentity.sandbox, true);
  assert.equal(browserIdentity.nodeIntegration, false);
  assert.equal(browserIdentity.contextIsolation, true);
  assert.ok(!browserIdentity.preload);
  assert.equal(browserState.url, siteUrl + '/');
  const firstCapture = await page.evaluate(() =>
    window.circleDesktop.browserCapture('session1'),
  );
  assert.match(firstCapture.dataUrl, /^data:image\/png;base64,/);
  assert.equal(firstCapture.sha256.length, 64);
  assert.ok(firstCapture.attempts >= 1 && firstCapture.attempts <= 3);
  const png = Buffer.from(firstCapture.dataUrl.split(',')[1], 'base64');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
  const waitVisible = (expected) =>
    app.evaluate(async ({ BrowserWindow }, expected) => {
      for (let i = 0; i < 100; i++) {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window.contentView.children.find(
          (view) => view.webContents && view.webContents !== window.webContents,
        );
        if (view?.getVisible() === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error('native browser visibility did not become ' + expected);
    }, expected);
  await waitVisible(true);
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'view')
      .submenu.items.find((item) => item.label === 'session tree')
      .click(),
  );
  const tree = page.getByRole('dialog', { name: 'session tree', exact: true });
  await tree.waitFor();
  await waitVisible(false);
  await tree.getByRole('button', { name: 'close dialog', exact: true }).click();
  await waitVisible(true);
  checks.push(
    'native browser stays visible in its own inspector and hides under other dialogs',
  );
  await page.getByRole('button', { name: 'files panel', exact: true }).click();
  await page
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await page.getByText('native browser', { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.circleDesktop.browserState('session1')))
      .sessionId,
    browserState.sessionId,
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.contentView.children.find(
        (view) => view.webContents && view.webContents !== window.webContents,
      ).webContents.id;
    }),
    browserIdentity.id,
  );
  await assert.rejects(
    () =>
      page.evaluate(() =>
        window.circleDesktop.browserNavigate('session1', 'file:///etc/passwd'),
      ),
    /http/,
  );
  await page.getByRole('button', { name: 'files panel', exact: true }).click();
  checks.push(
    'sandboxed native browser keeps one session identity across panel switches',
  );
  await page.screenshot({ path: join(output, 'desktop-light.png') });
  await route('/page/settings');
  await page.getByRole('button', { name: 'dark', exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === 'dark',
  );
  await route('/session/session1');
  await page.screenshot({ path: join(output, 'desktop-dark.png') });
  checks.push('native window in light and dark palettes');
  if (
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .isVisible()
  )
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .click();
  await page.getByRole('button', { name: 'attach files', exact: true }).click();
  await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
  const attached = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('circle.workbench.preview.v1'))
        .sessions[0].attachments[0],
  );
  assert.equal(
    attached.content,
    '# native attachment\nselected by the desktop test',
  );
  checks.push('native host reads selected file into conversation');
  originalClipboard = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  await page.evaluate(() =>
    window.circleDesktop.copyText('circle native clipboard fixture'),
  );
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'circle native clipboard fixture',
  );
  checks.push('clipboard through restricted native IPC');
  await page.evaluate(() =>
    window.circleDesktop.saveFile({
      name: 'export.md',
      content: 'native export fixture',
    }),
  );
  assert.equal(await readFile(exportPath, 'utf8'), 'native export fixture');
  await assert.rejects(
    () =>
      page.evaluate(() =>
        window.circleDesktop.saveFile({ name: '../escape.md', content: 'x' }),
      ),
    /invalid export name/,
  );
  checks.push(
    'native export writes selected destination and rejects invalid names',
  );
  await page
    .getByRole('button', { name: 'orbit-api fix/reconnect', exact: true })
    .click();
  await page.getByRole('button', { name: 'open folder', exact: true }).click();
  await page
    .getByRole('heading', { name: 'new session', exact: true })
    .waitFor();
  if (
    !(await page
      .getByRole('button', { name: 'files panel', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'toggle inspector', exact: true })
      .click();
  await page.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await page
    .getByText('export const hello = "native workspace";', { exact: true })
    .waitFor();
  assert.equal(
    await readFile(join(workspace, 'hello.ts'), 'utf8'),
    'export const hello = "native workspace";\n',
  );
  await assert.rejects(
    () =>
      page.evaluate(() =>
        window.circleDesktop.readWorkspaceFile('unknown', '../../escape'),
      ),
    /not granted/,
  );
  checks.push(
    'native workspace listing, scoped reading and denied unknown handles',
  );
  await page.getByRole('button', { name: 'close file', exact: true }).click();
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'view')
      .submenu.items.find((item) => item.label === 'session tree')
      .click();
  });
  await page
    .getByRole('dialog', { name: 'session tree', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  checks.push('native application menu dispatches into the session UI');
  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  assert.equal(await page.getByRole('checkbox').count(), 7);
  await page
    .getByRole('checkbox', { name: 'enable knowledge interface', exact: true })
    .uncheck();
  await route('/page/knowledge');
  await page
    .getByRole('heading', { name: 'plugin disabled', exact: true })
    .waitFor();
  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  await page
    .getByRole('checkbox', { name: 'enable knowledge interface', exact: true })
    .check();
  await route('/page/knowledge');
  await page.getByRole('heading', { name: 'knowledge', exact: true }).waitFor();
  checks.push('all four platform plugins installed and independently toggled');
  await route('/page/work');
  await page
    .getByRole('button', { name: /Investigate reconnect behavior/ })
    .click();
  await page
    .getByRole('button', { name: 'request pause', exact: true })
    .click();
  const platform = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.platform-preview.v1')),
  );
  assert.equal(platform.work[0].request, 'pause');
  assert.equal(platform.work[0].status, 'running');
  assert.equal(
    platform.resources.find((item) => item.id === 'resource3').status,
    'running',
  );
  await page.keyboard.press('Escape');
  checks.push('platform pause intent does not fabricate remote stop');
  await route('/page/knowledge');
  await page
    .getByRole('button', { name: /connection lifecycle Product behavior/ })
    .click();
  await page
    .getByRole('combobox', { name: 'source revision' })
    .selectOption('3');
  await page
    .getByRole('button', { name: 'attach revision', exact: true })
    .click();
  const snapshot = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
  );
  assert.ok(
    snapshot.sessions
      .find((item) => item.id === snapshot.activeSessionId)
      .attachments.some((item) => item.id === 'knowledge:source1@3'),
  );
  await page.keyboard.press('Escape');
  checks.push('knowledge revision attaches to the selected Circle session');
  await route('/page/methods');
  await page
    .getByRole('checkbox', { name: 'load network investigation', exact: true })
    .check();
  const methods = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.platform-preview.v1')),
  );
  assert.equal(
    methods.methods.find((item) => item.id === 'method3').status,
    'candidate',
  );
  checks.push('method loading leaves publication state unchanged');
  assert.deepEqual(errors, []);
  if (originalClipboard !== undefined) {
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      originalClipboard,
    );
    originalClipboard = undefined;
  }
  await page.screenshot({ path: join(output, 'desktop-methods.png') });
  await app.close();
  app = undefined;
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [process.env.CIRCLE_DESKTOP_APP_PATH ?? root],
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  await page
    .getByRole('heading', { name: 'new session', exact: true })
    .waitFor();
  const reopened = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
  );
  assert.ok(
    reopened.sessions
      .find((item) => item.id === reopened.activeSessionId)
      .attachments.some((item) => item.id === 'knowledge:source1@3'),
  );
  checks.push(
    'application restart preserves the conversation and pinned input',
  );
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        electron: await app.evaluate(({ app }) => process.versions.electron),
        platform: process.platform,
        appPackaged: info.packaged,
        viewport,
        sourceFiles: await sourceEvidence(),
        buildFiles: await rendererEvidence(root),
        packagedAsarSha256: process.env.CIRCLE_DESKTOP_APP_PATH
          ? createHash('sha256')
              .update(
                await readFile(
                  process.platform === 'darwin'
                    ? join(
                        process.env.CIRCLE_DESKTOP_APP_PATH,
                        'Contents/Resources/app.asar',
                      )
                    : join(
                        process.env.CIRCLE_DESKTOP_APP_PATH,
                        'resources/app.asar',
                      ),
                ),
              )
              .digest('hex')
          : null,
        checks,
        errors,
        frameOrigin: 'circle://workbench',
        isolation: preferences,
        browserIdentity,
        browserCapture: {
          sha256: firstCapture.sha256,
          attempts: firstCapture.attempts,
          retryErrors: firstCapture.retryErrors,
        },
        scope:
          'native frontend and isolated preview services; no Circle model or production service connected',
        exportSha256: createHash('sha256')
          .update(await readFile(exportPath))
          .digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({ checks: checks.length, errors, packaged: info.packaged }),
  );
} catch (error) {
  if (app)
    console.error(
      JSON.stringify(
        await app
          .evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              visible: window.isVisible(),
              bounds: window.getBounds(),
              children: window.contentView.children.map((view) => ({
                bounds: view.getBounds(),
                visible: view.getVisible(),
                title: view.webContents?.getTitle(),
                loading: view.webContents?.isLoading(),
              })),
            })),
          )
          .catch(() => []),
      ),
    );
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (app) {
    if (originalClipboard !== undefined)
      await app
        .evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          originalClipboard,
        )
        .catch(() => {});
    await app.close();
  }
  await new Promise((resolve) => site.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
