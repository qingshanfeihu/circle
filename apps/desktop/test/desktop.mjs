import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { readViewport, setViewport } from './helpers/viewport.mjs';
import { waitBrowserState } from './helpers/browser-state.mjs';
import {
  waitDesktopReady,
  freshBrowserCapture,
} from './helpers/desktop-readiness.mjs';
import { waitAnimationFrames } from './helpers/frame-readiness.mjs';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
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
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify(profile),
};
delete env.ELECTRON_RUN_AS_NODE;
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const site = createServer((req, res) => {
  // The page Chrome's controls are checked on: a named icon, a link, an image, a field
  // and words to find
  if (req.url === '/icon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(ICON);
    return;
  }
  if (req.url === '/slow') {
    const timer = setTimeout(() => res.end('<title>slow</title>late'), 4000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (req.url === '/chrome' || req.url === '/linked') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><title>${req.url === '/linked' ? 'Linked fixture' : 'Chrome controls fixture'}</title><link rel="icon" href="/icon.png">` +
        '<style>body{margin:0;font:16px sans-serif}a,img,input,p{display:block;margin:12px}</style>' +
        '<a id="link" href="/linked">a linked page</a>' +
        '<img id="image" src="/icon.png" width="60" height="60" alt="icon">' +
        '<input id="field" value="editable text">' +
        '<p id="plain">needle one, needle two and needle three</p>' +
        '<div id="blank" style="height:200px"></div>',
    );
    return;
  }
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
let viewportSizing;
let nativeWindowId;
let startupReadiness;
let browserPanelReadiness;
let captureReadiness;
// Chrome's controls on the real native page: the icon, the page's own right-click menu,
// shortcuts pressed in the page, find, zoom, stop, the last tab and the menu that the
// page steps aside for. The page's input goes through Electron as a person's does.
async function chromeControls() {
  const mac = process.platform === 'darwin';
  const command = mac ? 'meta' : 'control';
  const state = () =>
    page.evaluate(() => window.circleDesktop.browserState('session1'));
  const until = async (check, label, timeout = 10000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw Error('timed out: ' + label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const shown = () =>
    app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.contentView.children.some(
        (view) =>
          view.webContents &&
          view.webContents !== window.webContents &&
          view.getVisible(),
      );
    });
  // The page that shows, by its address
  const inPage = (script, prefix = siteUrl + '/chrome') =>
    app.evaluate(
      ({ webContents }, { script, prefix }) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(prefix))
          .executeJavaScript(script),
      { script, prefix },
    );
  const send = (events, prefix = siteUrl + '/chrome') =>
    app.evaluate(
      ({ webContents }, { events, prefix }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(prefix));
        contents.focus();
        for (const event of events) contents.sendInputEvent(event);
      },
      { events, prefix },
    );
  const key = (keyCode, modifiers = []) =>
    send([
      { type: 'keyDown', keyCode, modifiers },
      { type: 'keyUp', keyCode, modifiers },
    ]);
  const rightClick = async (selector) => {
    const box = await inPage(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 20)), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    await app.evaluate(() => globalThis.circleMenus.splice(0));
    await send([
      { type: 'mouseMove', ...box },
      { type: 'mouseDown', ...box, button: 'right', clickCount: 1 },
      { type: 'mouseUp', ...box, button: 'right', clickCount: 1 },
    ]);
    await until(
      () => app.evaluate(() => globalThis.circleMenus.length > 0),
      'context menu for ' + selector,
    );
    return app.evaluate(() =>
      globalThis.circleMenus[0].items.map((item) =>
        item.type === 'separator'
          ? '-'
          : item.label + (item.enabled ? '' : ' (disabled)'),
      ),
    );
  };
  // A right-click on macOS selects the word under it, and Chrome then offers to copy
  // it too
  const besideWord = (items) =>
    items.join('|').replace('|-|Copy|', '|').split('|');
  const choose = (label) =>
    app.evaluate(
      (_electron, label) =>
        globalThis.circleMenus[0].items
          .find((item) => item.label === label)
          .click(),
      label,
    );
  // A popup would hold the main process: the menu is kept to be read and chosen from
  await app.evaluate(({ Menu }) => {
    globalThis.circleMenus = [];
    Menu.prototype.popup = function () {
      globalThis.circleMenus.push(this);
    };
  });
  const address = page.getByRole('textbox', {
    name: 'browser address',
    exact: true,
  });
  await address.fill(siteUrl + '/chrome');
  await address.press('Enter');
  await until(
    async () => (await state()).title === 'Chrome controls fixture',
    'chrome fixture loaded',
  );
  // The icon the page names shows in its tab, read by the main process
  await until(
    async () =>
      (await state()).tabs
        .find((tab) => tab.active)
        ?.favicon?.startsWith('data:image/png;base64,'),
    'the page icon in its tab',
  );
  await page.locator('.browser-tab.active .browser-tab-icon img').waitFor();
  checks.push('a tab shows the icon its page names');

  assert.deepEqual(await rightClick('#blank'), [
    'Back',
    'Forward (disabled)',
    'Reload',
    '-',
    'Inspect',
  ]);
  assert.deepEqual(besideWord(await rightClick('#link')), [
    'Open link in new tab',
    'Copy link address',
    '-',
    'Inspect',
  ]);
  const before = await state();
  await choose('Open link in new tab');
  const opened = await until(async () => {
    const value = await state();
    return value.tabs.length === before.tabs.length + 1 &&
      value.tabs.some((tab) => tab.url === siteUrl + '/linked')
      ? value
      : undefined;
  }, 'the link in a new tab');
  // Behind the shown tab, as Chrome opens it
  assert.equal(opened.tab, before.tab);
  // The person's clipboard is put back afterwards
  const clipboardBefore = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  try {
    await rightClick('#link');
    await choose('Copy link address');
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      siteUrl + '/linked',
    );
  } finally {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      clipboardBefore,
    );
  }
  assert.deepEqual(besideWord(await rightClick('#image')), [
    'Open image in new tab',
    'Copy image',
    'Copy image address',
    '-',
    'Inspect',
  ]);
  // Paste is offered while the clipboard holds text, as in Chrome; a runner's may be empty.
  const clipboardForField = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  let fieldMenu;
  try {
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText('circle paste fixture'),
    );
    fieldMenu = await rightClick('#field');
  } finally {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      clipboardForField,
    );
  }
  assert.deepEqual(fieldMenu, [
    'Undo (disabled)',
    'Redo (disabled)',
    '-',
    // The word the right-click selected on macOS can be cut and copied
    mac ? 'Cut' : 'Cut (disabled)',
    mac ? 'Copy' : 'Copy (disabled)',
    'Paste',
    'Select all',
    '-',
    'Inspect',
  ]);
  // The menu speaks the window's language
  await page.evaluate(() => window.circleDesktop.setLanguage('zh-CN'));
  assert.deepEqual((await rightClick('#link')).slice(0, 2), [
    '在新标签页中打开链接',
    '复制链接地址',
  ]);
  await page.evaluate(() => window.circleDesktop.setLanguage('en'));
  // Inspect opens the panel's developer tools under the page
  await rightClick('#blank');
  await choose('Inspect');
  await page.locator('.browser-diagnostics').waitFor();
  await page
    .getByRole('button', { name: 'close developer tools', exact: true })
    .click();
  await page.locator('.browser-diagnostics').waitFor({ state: 'detached' });
  checks.push("the page's right-click menu is Chrome's and does what it says");

  // Shortcuts pressed in the page
  // The page's device pixel ratio includes its zoom, so it shows when the
  // page itself, not only the browser, has a new zoom.
  const unzoomedRatio = await inPage('window.devicePixelRatio');
  await key('=', [command]);
  await until(async () => (await state()).zoom === 110, 'zoom in to 110%');
  await page.getByRole('button', { name: 'zoom 110%', exact: true }).waitFor();
  // The page itself is drawn at 110%
  assert.equal(
    await app.evaluate(
      ({ webContents }, prefix) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(prefix))
          .getZoomFactor(),
      siteUrl + '/chrome',
    ),
    1.1,
  );
  // Circle's own clicks go to CSS pixels, which the page's zoom leaves where they are:
  // a click at a field's CSS centre still lands on it at 125%
  await key('=', [command]);
  await until(async () => (await state()).zoom === 125, 'zoom in to 125%');
  // The browser reports the zoom before the page renders with it, and a click
  // sent in between is placed with the old zoom: wait for the page.
  await until(
    async () =>
      Math.abs(
        (await inPage('window.devicePixelRatio')) - unzoomedRatio * 1.25,
      ) < 0.01,
    'the page renders at 125%',
  );
  const target = await inPage(
    `(() => { document.activeElement?.blur(); const r = document.querySelector('#field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await app.evaluate(
    async ({ webContents }, { prefix, target }) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(prefix));
      for (const type of ['mousePressed', 'mouseReleased'])
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type,
          ...target,
          button: 'left',
          clickCount: 1,
        });
    },
    { prefix: siteUrl + '/chrome', target },
  );
  assert.equal(await inPage('document.activeElement?.id'), 'field');
  await key('0', [command]);
  await until(async () => (await state()).zoom === 100, 'zoom back to 100%');
  await key('F', [command]);
  const find = page.getByRole('textbox', { name: 'find in page', exact: true });
  await find.waitFor();
  await find.fill('needle');
  await until(
    async () => (await state()).find?.matches === 3,
    'three matches in the page',
  );
  await page.getByTestId('browser-find-count').getByText('1/3').waitFor();
  await find.press('Enter');
  await page.getByTestId('browser-find-count').getByText('2/3').waitFor();
  await find.press('Shift+Enter');
  await page.getByTestId('browser-find-count').getByText('1/3').waitFor();
  await find.press('Escape');
  await find.waitFor({ state: 'detached' });
  assert.equal((await state()).find, undefined);
  checks.push('find in page counts and steps through matches');
  await key('F12');
  await page.locator('.browser-diagnostics').waitFor();
  await key('F12');
  await page.locator('.browser-diagnostics').waitFor({ state: 'detached' });
  await key('L', [command]);
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'browser address',
  );
  const tabsBefore = (await state()).tabs.length;
  await key('T', [command]);
  await until(
    async () => (await state()).tabs.length === tabsBefore + 1,
    'a new tab from the page',
  );
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'browser address',
  );
  await page
    .getByRole('tab')
    .filter({ hasText: 'Chrome controls fixture' })
    .getByRole('button')
    .first()
    .click();
  await until(
    async () => (await state()).title === 'Chrome controls fixture',
    'back on the fixture tab',
  );
  const shownTab = (await state()).tab;
  await key('Tab', ['control']);
  await until(async () => (await state()).tab !== shownTab, 'ctrl+tab');
  await page
    .getByRole('tab')
    .filter({ hasText: 'Chrome controls fixture' })
    .getByRole('button')
    .first()
    .click();
  await until(async () => (await state()).tab === shownTab, 'tab shown again');
  await key('W', [command]);
  await until(
    async () => !(await state()).tabs.some((tab) => tab.id === shownTab),
    'the shown tab closed from the page',
  );
  checks.push("Chrome's shortcuts work while the page has the keyboard");

  // Reload turns into stop while a page loads, and stop stops it
  await address.fill(siteUrl + '/slow');
  await address.press('Enter');
  const stop = page.getByRole('button', { name: 'stop loading', exact: true });
  await stop.waitFor();
  await stop.click();
  await until(async () => !(await state()).loading, 'loading stopped', 3000);
  // Stopped by the person, the page is no failure
  assert.equal((await state()).failure, undefined);
  assert.equal(await page.getByTestId('browser-load-failure').count(), 0);
  await page
    .getByRole('button', { name: 'reload page', exact: true })
    .waitFor();
  checks.push('stop ends a page that is loading');

  // The ⋮ menu: the page steps aside for it and comes back
  await address.fill(siteUrl + '/chrome');
  await address.press('Enter');
  await until(
    async () => (await state()).title === 'Chrome controls fixture',
    'fixture again',
  );
  await until(shown, 'the page shows');
  await page.getByRole('button', { name: 'browser menu', exact: true }).click();
  await page.getByRole('menu').waitFor();
  await until(
    async () => !(await shown()),
    'the page steps aside for the menu',
  );
  await page.locator('.browser-frozen').waitFor();
  await page.screenshot({ path: join(output, 'browser-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await until(shown, 'the page back after the menu');
  checks.push('the ⋮ menu shows over a still of the page, never under it');

  // Closing the last tab leaves a new, empty one, as in Chrome
  for (;;) {
    const value = await state();
    if (value.tabs.length === 1) break;
    await page.evaluate(
      ({ tab }) => window.circleDesktop.browserTabs('session1', 'close', tab),
      { tab: value.tabs.find((entry) => !entry.active).id },
    );
  }
  const last = (await state()).tab;
  const closeTab = page.getByRole('button', { name: 'close tab', exact: true });
  // The strip can still show the tabs closed above for a frame or two.
  await until(async () => (await closeTab.count()) === 1, 'one tab shown');
  await closeTab.click();
  const fresh = await until(async () => {
    const value = await state();
    return value.tabs.length === 1 && value.tab !== last ? value : undefined;
  }, 'a new tab after the last one closed');
  assert.equal(fresh.url, 'about:blank');
  checks.push('closing the last tab leaves a new empty tab');
  await address.fill(siteUrl);
  await address.press('Enter');
  await until(
    async () => (await state()).url === siteUrl + '/',
    'the fixture site again',
  );
}
const nativeState = (childId) =>
  app.evaluate(
    async ({ BrowserWindow }, { windowId, childId }) => {
      const window = windowId
        ? BrowserWindow.fromId(windowId)
        : BrowserWindow.getAllWindows()[0];
      if (!window) throw Error('the test native window was not found');
      const [width, height] = window.getContentSize();
      const child = childId
        ? window.contentView.children.find(
            (view) => view.webContents?.id === childId,
          )
        : undefined;
      return {
        id: window.id,
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        bounds: window.getBounds(),
        content: { width, height },
        child: child
          ? {
              id: child.webContents.id,
              visible: child.getVisible(),
              bounds: child.getBounds(),
              url: child.webContents.getURL(),
              title: child.webContents.getTitle(),
              loading: child.webContents.isLoading(),
              viewport: await child.webContents.executeJavaScript(
                '({width:innerWidth,height:innerHeight,readyState:document.readyState})',
              ),
            }
          : undefined,
      };
    },
    { windowId: nativeWindowId, childId },
  );
const panelState = async () => ({
  native: await nativeState(),
  renderer: await page
    .getByRole('button', { name: 'browser panel', exact: true })
    .evaluate((button) => {
      const inspect = (element) => {
        if (!element) return undefined;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: element.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
        };
      };
      return {
        button: {
          ...inspect(button),
          enabled: !button.disabled,
          pressed: button.getAttribute('aria-pressed'),
        },
        inspector: inspect(document.querySelector('.inspector')),
        viewport: { width: innerWidth, height: innerHeight },
      };
    }),
});
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  // Starting the application, from its first window to one that renders, has one budget
  const renderDeadline = Date.now() + 30000;
  page.setDefaultTimeout(patience(10000));
  observePage(page, errors);
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor({ timeout: Math.max(1, renderDeadline - Date.now()) });
  // DOM readiness does not prove the initially hidden native window was shown.
  // This harness owns the window; disclose any intervention instead of treating
  // it as evidence that production's ready-to-show lifecycle worked.
  const startupDeadline = Date.now() + patience(10000);
  const initialWindow = (
    await waitDesktopReady(nativeState, () => true, {
      label: 'initial native window',
      stableMs: 0,
    })
  ).sample;
  nativeWindowId = initialWindow.id;
  startupReadiness = {
    initial: initialWindow,
    harnessShow: !initialWindow.visible,
  };
  let showRequested = initialWindow.visible;
  startupReadiness.shown = await waitDesktopReady(
    async () => {
      if (!showRequested) {
        showRequested = true;
        await app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id).show(),
          nativeWindowId,
        );
      }
      return nativeState();
    },
    (state) => state.visible && !state.minimized,
    {
      label: 'test native window shown',
      timeoutMs: Math.max(1, startupDeadline - Date.now()),
      stableMs: 0,
    },
  );
  // A shown, laid-out window is not yet a rendering one. On a runner's first launch the
  // GPU process can spend seconds loading Mesa, and until it is up the page runs no
  // animation frames, so no click can find its element stable (#124).
  startupReadiness.frames = await waitAnimationFrames(page, {
    label: 'test native window renders animation frames',
    timeoutMs: Math.max(1, renderDeadline - Date.now()),
  });
  if (process.env.CIRCLE_DESKTOP_CHECK_NARROW) {
    await page.waitForURL(/^circle:\/\/workbench/);
    viewportSizing = await setViewport(app, page, { width: 1024, height: 650 });
    await page.reload();
  }
  await page
    .getByRole('heading', { name: 'Fix the reconnect race' })
    .waitFor({ timeout: 30000 });
  assert.ok(page.url().startsWith('circle://workbench/index.html'));
  const info = await page.evaluate(() => window.circleDesktop.info());
  const viewport = await readViewport(page);
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
  const panelDeadline = Date.now() + patience(10000);
  browserPanelReadiness = await waitDesktopReady(
    panelState,
    ({ native, renderer }) =>
      native.visible &&
      !native.minimized &&
      renderer.button.visible &&
      renderer.button.enabled &&
      renderer.button.rect.width > 0 &&
      renderer.button.rect.height > 0,
    { label: 'browser panel actionability', stableMs: 50 },
  );
  await writeFile(
    join(output, 'browser-panel-readiness.json'),
    JSON.stringify(browserPanelReadiness, null, 2) + '\n',
  );
  await page
    .getByRole('button', { name: 'browser panel', exact: true })
    .click({ timeout: Math.max(1, panelDeadline - Date.now()) });
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .fill(siteUrl);
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .press('Enter');
  await page.getByText('native browser', { exact: true }).waitFor();
  const browserState = await waitBrowserState(
    page,
    'session1',
    (state) =>
      state.url === siteUrl + '/' &&
      !state.loading &&
      state.title === 'Circle native browser fixture',
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
  captureReadiness = await freshBrowserCapture(
    async () => ({
      state: await page.evaluate(() =>
        window.circleDesktop.browserState('session1'),
      ),
      renderer: await page.evaluate(() => {
        const rect = document
          .querySelector('.native-browser-viewport')
          ?.getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          rect: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : undefined,
        };
      }),
      native: await nativeState(browserIdentity.id),
    }),
    () => page.evaluate(() => window.circleDesktop.browserCapture('session1')),
    { url: siteUrl + '/', title: 'Circle native browser fixture' },
  );
  const firstCapture = captureReadiness.capture;
  assert.match(firstCapture.dataUrl, /^data:image\/png;base64,/);
  assert.equal(firstCapture.sha256.length, 64);
  assert.ok(firstCapture.attempts >= 1 && firstCapture.attempts <= 8);
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
  // A non-web scheme is refused as an address the bar cannot read, not as a
  // network failure; and a bare host the person typed is accepted, completed
  // with https (#67).
  await assert.rejects(
    () =>
      page.evaluate(() =>
        window.circleDesktop.browserNavigate('session1', 'file:///etc/passwd'),
      ),
    /invalid browser address/,
  );
  const bareHost = await page.evaluate(() =>
    window.circleDesktop
      .browserNavigate('session1', '127.0.0.1:1')
      .then(() => 'opened')
      .catch((error) => String((error && error.message) || error)),
  );
  assert.ok(
    !bareHost.includes('invalid browser address'),
    'a bare host must pass address parsing: ' + bareHost,
  );
  // And through the real address bar: typing an unreadable address notifies
  // the person with the invalid-address message, not a network failure (#67).
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .fill('file:///etc/passwd');
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .press('Enter');
  await page
    .getByRole('status')
    .getByText('invalid address', { exact: true })
    .waitFor();
  await page.waitForFunction(() => !document.querySelector('.toast'));
  checks.push('the address bar says invalid address, not navigation failed');
  await chromeControls();
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
  // Open folder sits in the sidebar, under the folders and their sessions.
  await page.getByRole('button', { name: 'open folder', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in project?',
      exact: true,
    })
    .waitFor();
  const sessionsBeforeSend = (
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
    )
  ).sessions.length;
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('look at hello');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'workspace trust', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'trust in preview', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'look at hello', exact: true })
    .waitFor();
  assert.equal(
    (
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
      )
    ).sessions.length,
    sessionsBeforeSend + 1,
  );
  // The side panel starts closed; the top bar's files icon opens it.
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  if ((await files.getAttribute('aria-pressed')) !== 'true')
    await files.click();
  await page.getByRole('button', { name: 'hello.ts', exact: true }).click();
  const fileLines = page.locator('.file-view .native-code-editor .view-lines');
  await fileLines.waitFor({ state: 'visible' });
  assert.equal(await fileLines.count(), 1, 'one visible source editor');
  await page.waitForFunction(() => {
    const lines = document.querySelector(
      '.file-view .native-code-editor .view-lines',
    );
    return (
      lines?.textContent.replaceAll('\u00a0', ' ') ===
      'export const hello = "native workspace";'
    );
  });
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
  // Each switch is named by the interface's shown title.
  const expectedInterfaces = [
    'GitHub',
    'file and diff inspector',
    'activity inspector',
    'browser pane',
    'hub',
    'knowledge',
    'work',
    'execution',
    'methods',
  ].map((title) => `enable ${title} interface`);
  assert.equal(
    await page.getByRole('checkbox').count(),
    expectedInterfaces.length,
  );
  for (const name of expectedInterfaces)
    assert.equal(
      await page.getByRole('checkbox', { name, exact: true }).count(),
      1,
      `the interface list contains exactly one ${name} checkbox`,
    );
  for (const id of ['knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page
        .getByRole('checkbox', { name: `enable ${id} interface`, exact: true })
        .isChecked(),
      false,
    );
  // The hub interface and the four platform objects are paired with its
  // runtime extension, which the preview does not have, so they stay off.
  assert.equal(
    await page
      .getByRole('checkbox', {
        name: 'enable hub interface',
        exact: true,
      })
      .isChecked(),
    false,
  );
  const pairedNotes = page.getByText(
    /paired with runtime extension hub · 0\.1\.0 · runtime extension hub is not installed/,
  );
  await pairedNotes.first().waitFor();
  // hub and the four platform objects share one runtime extension.
  assert.equal(await pairedNotes.count(), 5);
  for (const id of ['knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page.getByRole('link', { name: id, exact: true }).count(),
      0,
    );
  await page
    .getByRole('checkbox', {
      name: 'enable file and diff inspector interface',
      exact: true,
    })
    .uncheck();
  await page
    .getByRole('checkbox', {
      name: 'enable file and diff inspector interface',
      exact: true,
    })
    .check();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('circle.workbench.platform-preview.v1'),
    ),
    null,
  );
  checks.push(
    'Circle-only components are shown without starting platform previews',
  );
  assert.deepEqual(errors, []);
  if (originalClipboard !== undefined) {
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      originalClipboard,
    );
    originalClipboard = undefined;
  }
  await page.screenshot({ path: join(output, 'desktop-circle.png') });
  const beforeRestart = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
  );
  await app.close();
  app = undefined;
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  await page
    .getByRole('heading', { name: 'look at hello', exact: true })
    .waitFor();
  const reopened = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1')),
  );
  assert.equal(reopened.activeSessionId, beforeRestart.activeSessionId);
  assert.deepEqual(
    reopened.sessions.find((item) => item.id === reopened.activeSessionId)
      .messages,
    beforeRestart.sessions.find(
      (item) => item.id === beforeRestart.activeSessionId,
    ).messages,
  );
  checks.push(
    'application restart preserves the Circle conversation and selected input',
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
        viewportSizing,
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
        startupReadiness,
        browserPanelReadiness,
        captureReadiness: {
          last: captureReadiness.last,
          reads: captureReadiness.reads,
          captures: captureReadiness.captures,
          rejected: captureReadiness.rejected,
        },
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
  const captureEvidence = error.readiness ?? captureReadiness;
  const readiness = {
    error: String(error),
    startupReadiness,
    browserPanelReadiness,
    captureReadiness: captureEvidence
      ? {
          last: captureEvidence.last,
          reads: captureEvidence.reads,
          captures: captureEvidence.captures,
          rejected: captureEvidence.rejected,
        }
      : undefined,
  };
  // Save the already-observed state before asking a potentially stalled IPC
  // endpoint for any further diagnostics. Extra evidence cannot replace the
  // original failure or keep its bounded rejection waiting indefinitely.
  await writeFile(
    join(output, 'readiness-failure.json'),
    JSON.stringify(readiness, null, 2) + '\n',
  );
  readiness.panel = await waitDesktopReady(panelState, () => true, {
    label: 'failure DOM/native state',
    timeoutMs: 2000,
    stableMs: 0,
  })
    .then((result) => result.sample)
    .catch((error) => ({ unavailable: String(error) }));
  await writeFile(
    join(output, 'readiness-failure.json'),
    JSON.stringify(readiness, null, 2) + '\n',
  );
  console.error(JSON.stringify({ readiness }));
  if (app)
    console.error(
      JSON.stringify(
        await waitDesktopReady(
          () =>
            app.evaluate(({ BrowserWindow }) =>
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
            ),
          () => true,
          { label: 'failure native snapshot', timeoutMs: 2000, stableMs: 0 },
        )
          .then((result) => result.sample)
          .catch((error) => ({ unavailable: String(error) })),
      ),
    );
  await waitDesktopReady(
    async () => {
      await captureFailure(page, error, errors, output);
      return true;
    },
    () => true,
    { label: 'failure renderer snapshot', timeoutMs: 2000, stableMs: 0 },
  ).catch((error) => console.error(String(error)));
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
