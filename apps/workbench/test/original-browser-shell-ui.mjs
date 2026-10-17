import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
const out =
  process.env.CIRCLE_BROWSER_SHELL_EVIDENCE ||
  '/tmp/circle-original-browser-shell-ui';
await mkdir(out, { recursive: true });
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 684 } });
page.setDefaultTimeout(5000);
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
let sawClosedTools = false;
try {
  await page.addInitScript(() => {
    localStorage.setItem('circle.workbench.language', 'en');
    const state = {
      sessionId: 'browser:session1',
      url: 'http://localhost/fixture',
      title: 'synthetic page',
      tab: 't1',
      tabs: [
        { id: 't1', url: 'http://localhost/fixture', title: 'synthetic page' },
      ],
    };
    const listeners = new Set();
    const captures = [];
    window.__browserCaptureFixture = {
      count: () => captures.length,
      resolve: (index, hash) =>
        captures[index].resolve({
          dataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhJkAAAAASUVORK5CYII=',
          sha256: hash,
          observedAt: '2026-10-16T00:00:00Z',
        }),
      reject: (index) => captures[index].reject(Error('old capture failed')),
      tabs: () => {
        state.tabs = [
          {
            id: 't1',
            title: 'synthetic page',
            url: 'http://localhost/fixture',
          },
          { id: 't2', title: 'other fixture', url: 'http://localhost/other' },
        ];
        for (const listener of listeners) listener({ ...state });
      },
    };
    window.circleDesktop = new Proxy(
      {
        info: async () => ({
          frontendOnly: true,
          platform: 'darwin',
          language: 'en',
        }),
        onBrowserEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        browserState: async (id) => {
          state.sessionId = 'browser:' + id;
          return { ...state };
        },
        browserCapture: () =>
          new Promise((resolve, reject) => captures.push({ resolve, reject })),
        browserNavigate: async (id, url) => {
          state.url = url;
          for (const listener of listeners) listener({ ...state });
        },
        browserTabs: async (id, action, tab) => {
          state.tab = tab;
          state.url = state.tabs.find((item) => item.id === tab).url;
          for (const listener of listeners) listener({ ...state });
        },
        browserDiagnostics: async () => ({
          state: {
            owner: 'circle',
            console: [],
            network: [],
            debugger: {
              paused: false,
              pauseEpoch: 1,
              breakpoints: [],
              stackFrames: [],
            },
          },
          stream: { epoch: 'e', sequence: 0 },
        }),
        onBrowserDiagnosticEvent: () => () => {},
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : (...args) =>
                key.toString().startsWith('on') ? () => {} : Promise.resolve(),
      },
    );
  });
  await page.clock.setFixedTime(new Date('2026-10-16T00:00:00Z'));
  // The page opens 1400 px wide.
  let previousWidth = 1400;
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [1400, 760, 290])
        for (const height of [684, 970]) {
          await page.setViewportSize({ width, height });
          await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
          await page.locator('.workbench').waitFor();
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          await page.evaluate(
            async ({ language, theme }) => {
              (await import('/src/i18n/index.ts')).setLanguage(language);
              (await import('/src/theme.ts')).applyTheme(theme);
            },
            { language, theme },
          );
          await page.evaluate(() => document.fonts.ready);
          // At most 1050 px wide the app closes the side panel (useNarrow in
          // App.tsx). The close is a render after the narrow layout's, and a
          // slow runner reports the new width to the page late, so the panel
          // can read as open here and close a moment later. Wait for this
          // width's layout and, after crossing into narrow, for that close,
          // before reading or opening the panel.
          const narrow = width <= 1050;
          await page.waitForFunction(
            (narrow) =>
              document
                .querySelector(
                  '#workbench-columns > #inspector .inspector-column',
                )
                ?.classList.contains('inspector-overlay') === narrow,
            narrow,
          );
          if (narrow && previousWidth > 1050)
            await page
              .locator("#workbench-columns[data-inspector-mode='closed']")
              .waitFor({ state: 'attached' });
          previousWidth = width;
          const browserPanel = page.getByRole('button', {
            name: language === 'en' ? 'browser panel' : '浏览器面板',
            exact: true,
          });
          if ((await browserPanel.getAttribute('aria-pressed')) !== 'true')
            await browserPanel.click();
          await page
            .getByRole('button', {
              name: language === 'en' ? 'browser menu' : '浏览器菜单',
              exact: true,
            })
            .waitFor();
          // Developer tools take no room until asked for, as in Chrome. They
          // stay open across the loop's in-page route changes.
          if (!sawClosedTools) {
            assert.equal(await page.locator('.browser-diagnostics').count(), 0);
            sawClosedTools = true;
          }
          assert.equal(
            await page
              .getByRole('button', {
                name: language === 'en' ? 'page diagnostics' : '页面诊断',
                exact: true,
              })
              .count(),
            0,
          );
          const iconSizes = await page
            .locator('.native-browser .icon-button')
            .evaluateAll((buttons) =>
              buttons
                .filter((button) => button.getClientRects().length)
                .map((button) => {
                  const box = button.getBoundingClientRect();
                  return [
                    box.width,
                    box.height,
                    getComputedStyle(button).borderRadius,
                  ];
                }),
            );
          for (const size of iconSizes) assert.deepEqual(size, [26, 26, '6px']);
          for (const expanded of [false, true]) {
            const shown =
              (await page.locator('.browser-diagnostics').count()) > 0;
            if (expanded && !shown) {
              await page
                .getByRole('button', {
                  name: language === 'en' ? 'browser menu' : '浏览器菜单',
                  exact: true,
                })
                .click();
              await page
                .getByRole('menuitem', {
                  name: language === 'en' ? 'developer tools' : '开发工具',
                })
                .click();
              await page.locator('.browser-diagnostics').waitFor();
            } else if (!expanded && shown)
              await page
                .getByRole('button', {
                  name:
                    language === 'en'
                      ? 'close developer tools'
                      : '关闭开发工具',
                  exact: true,
                })
                .click();
            // Locale changes may load CJK fonts after React commits. Capture the
            // browser beside a settled conversation at its explicit end position.
            await page.evaluate(async () => {
              await document.fonts.ready;
              const transcript = document.querySelector('.transcript');
              if (transcript) transcript.scrollTop = transcript.scrollHeight;
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
            });
            const geometry = await page.evaluate(() => {
              const selectors = [
                '.inspector-body',
                '.inspector-resource-view[data-inspector-resource=browser]:not([hidden])',
                '.native-browser',
                '.native-browser-viewport',
                '.native-browser-footer',
                '.browser-diagnostics',
              ];
              return selectors.map((selector) => {
                const node = document.querySelector(selector);
                if (!node) return { selector, missing: true };
                const r = node.getBoundingClientRect(),
                  s = getComputedStyle(node);
                return {
                  selector,
                  top: r.top,
                  bottom: r.bottom,
                  height: r.height,
                  paddingBottom: Number.parseFloat(s.paddingBottom),
                  cssheight: s.height,
                  display: s.display,
                  flex: s.flex,
                };
              });
            });
            await page.mouse.move(0, 0);
            assert.equal(
              await page.locator('html').getAttribute('data-theme'),
              theme,
            );
            await page.screenshot({
              animations: 'disabled',
              path:
                out +
                `/${language}-${theme}-${width}-${height}-${expanded ? 'expanded' : 'closed'}.png`,
            });
            const [body, wrapper, native, viewport, footer, docked] = geometry;
            // Closed, the footer is the last row; open, the developer tools are
            assert.equal(!!docked.missing, !expanded);
            const diagnostics = docked.missing ? footer : docked;
            assert.equal(
              body.paddingBottom,
              0,
              'the browser fills the inspector to its edges, as in Claude',
            );
            assert(
              Math.abs(wrapper.bottom - (body.bottom - body.paddingBottom)) <=
                1,
              'browser wrapper fills original inspector content box',
            );
            assert(
              Math.abs(native.bottom - wrapper.bottom) <= 1,
              'native browser fills its bounded parent',
            );
            assert(
              Math.abs(diagnostics.bottom - native.bottom) <= 1,
              'diagnostics end at bounded browser bottom',
            );
            assert(
              viewport.height >= 80,
              'guest retains usable actual viewport',
            );
            assert(footer.bottom <= body.bottom, 'page footer remains visible');
            assert(
              diagnostics.bottom <= body.bottom,
              'expanded diagnostics never overflow inspector',
            );
            assert(
              body.bottom - diagnostics.bottom <= 32,
              'do not weaken native blank-under-panel acceptance',
            );
            checks.push({ height, expanded, geometry });
          }
          const pair = checks.slice(-2);
          assert(
            pair[0].geometry[3].height > pair[1].geometry[3].height,
            'expanded diagnostics resize the actual guest within the same fixed parent',
          );
        }
  await page.setViewportSize({ width: 1400, height: 970 });
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.evaluate(async () =>
    (await import('/src/i18n/index.ts')).setLanguage('en'),
  );
  const openBrowser = async () => {
    const toggle = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page
      .getByRole('button', { name: 'browser menu', exact: true })
      .waitFor();
  };
  await openBrowser();
  // Take screenshot lives in the browser's ⋮ menu, as Chrome keeps its tools there
  const capture = {
    click: async () => {
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'take screenshot', exact: true })
        .click();
      await page.getByRole('menu').waitFor({ state: 'detached' });
    },
  };
  const waitCaptureCount = async (count) =>
    page.waitForFunction(
      (count) => window.__browserCaptureFixture.count() === count,
      count,
    );
  const settle = async () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  await capture.click();
  await waitCaptureCount(1);
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .fill('http://localhost/new-page');
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .press('Enter');
  await page.evaluate(() =>
    window.__browserCaptureFixture.resolve(0, 'old-navigation'),
  );
  await settle();
  assert.equal(
    await page.getByText('captured observation', { exact: true }).count(),
    0,
    'late pre-navigation capture cannot reappear on another page',
  );
  checks.push({
    scenario: 'late navigation capture rejected',
    status: 'passed',
  });
  await page.evaluate(() => window.__browserCaptureFixture.tabs());
  await capture.click();
  await waitCaptureCount(2);
  await page
    .getByRole('button', { name: 'other fixture', exact: true })
    .click();
  await page.evaluate(() =>
    window.__browserCaptureFixture.resolve(1, 'old-tab'),
  );
  await settle();
  assert.equal(
    await page.getByText('captured observation', { exact: true }).count(),
    0,
    'late old-tab capture cannot reappear',
  );
  checks.push({ scenario: 'late tab capture rejected', status: 'passed' });
  await capture.click();
  await waitCaptureCount(3);
  await page
    .locator('.sidebar [data-row-key="recent:session2"] a.session-link')
    .click();
  await openBrowser();
  await page.evaluate(() =>
    window.__browserCaptureFixture.resolve(2, 'old-session'),
  );
  await settle();
  assert.equal(
    await page.getByText('captured observation', { exact: true }).count(),
    0,
    'late old-session capture cannot reappear',
  );
  checks.push({ scenario: 'late session capture rejected', status: 'passed' });
  await capture.click();
  await capture.click();
  await waitCaptureCount(5);
  await page.evaluate(() =>
    window.__browserCaptureFixture.resolve(4, 'latest-capture'),
  );
  await page.getByText('captured observation', { exact: true }).click();
  await page.getByText('latest-capture', { exact: true }).waitFor();
  await page.evaluate(() =>
    window.__browserCaptureFixture.resolve(3, 'earlier-capture'),
  );
  await settle();
  assert.equal(
    await page.getByText('earlier-capture', { exact: true }).count(),
    0,
    'earlier capture cannot replace latest result',
  );
  assert.equal(
    await page.getByText('latest-capture', { exact: true }).count(),
    1,
  );
  checks.push({
    scenario: 'capture generation preserves latest response',
    status: 'passed',
  });
  await capture.click();
  await waitCaptureCount(6);
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .fill('http://localhost/last');
  await page
    .getByRole('textbox', { name: 'browser address', exact: true })
    .press('Enter');
  await page.evaluate(() => window.__browserCaptureFixture.reject(5));
  await settle();
  assert.equal(
    await page.getByText('browser capture failed', { exact: true }).count(),
    0,
    'obsolete capture failure cannot notify a new page',
  );
  checks.push({ scenario: 'obsolete capture error ignored', status: 'passed' });
  assert.deepEqual(errors, [], 'full application renders without page errors');
  console.log(
    'PASS original full-app browser inspector bounds closed and expanded',
  );
} catch (error) {
  await page.screenshot({ path: out + '/failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
  await writeFile(
    out + '/receipt.json',
    JSON.stringify(
      {
        kind: 'actual full App with synthetic native browser host; no Electron foreground',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
