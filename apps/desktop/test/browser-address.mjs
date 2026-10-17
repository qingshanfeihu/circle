import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { waitBrowserState } from './helpers/browser-state.mjs';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-address-'));
const output = join(
  root,
  'artifacts/browser-address',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const site = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Circle address fixture</title><h1>local address fixture</h1>',
  );
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const cases = [];
const errors = [];
let app;
let page;
let activeCase;
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(10000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);
  assert.equal(info.frontendOnly, true);
  const route = async (path) => {
    await page.evaluate((path) => {
      location.hash = path;
    }, path);
    await page.waitForURL((url) => url.hash === '#' + path);
  };
  for (const theme of ['light', 'dark']) {
    await route('/page/settings');
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await route('/session/session1');
    const panel = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    await panel.waitFor();
    if ((await panel.getAttribute('aria-pressed')) !== 'true')
      await panel.click();
    const address = page.getByRole('textbox', {
      name: 'browser address',
      exact: true,
    });
    const loadedUrl = `${siteUrl}?theme=${theme}`;
    await address.fill(loadedUrl);
    await address.press('Enter');
    await waitBrowserState(
      page,
      'session1',
      (state) =>
        state.url === loadedUrl &&
        !state.loading &&
        state.title === 'Circle address fixture',
    );
    for (const target of [
      'file:///circle-invalid-address-fixture.txt',
      'invalid://fixture',
    ]) {
      const before = await page.evaluate(() =>
        window.circleDesktop.browserState('session1'),
      );
      activeCase = {
        theme,
        target,
        loadedUrl,
        before,
        stage: 'native rejection',
      };
      assert.equal(before.url, loadedUrl);
      assert.equal(before.title, 'Circle address fixture');
      assert.ok(before.tab);
      const rejected = await page.evaluate(async (target) => {
        try {
          await window.circleDesktop.browserNavigate('session1', target);
          return '';
        } catch (error) {
          return error.message;
        }
      }, target);
      activeCase.rejected = rejected;
      assert.equal(rejected, 'invalid browser address');
      const afterBridge = await page.evaluate(() =>
        window.circleDesktop.browserState('session1'),
      );
      activeCase.afterBridge = afterBridge;
      assert.equal(afterBridge.url, loadedUrl);
      assert.equal(afterBridge.tab, before.tab);
      activeCase.stage = 'address input';
      const toast = page.locator('.toast[role="status"]');
      if (await toast.isVisible()) await toast.waitFor({ state: 'hidden' });
      await address.fill(target);
      await address.press('Enter');
      await toast.waitFor();
      assert.equal(await toast.innerText(), 'invalid address');
      assert.equal(await address.inputValue(), target);
      const state = await page.evaluate(() =>
        window.circleDesktop.browserState('session1'),
      );
      activeCase.afterInput = state;
      assert.equal(
        state.url,
        loadedUrl,
        'invalid input must preserve the actual loaded page',
      );
      assert.equal(state.title, 'Circle address fixture');
      assert.equal(state.tab, before.tab);
      cases.push({
        theme,
        target,
        rejected,
        notification: await toast.innerText(),
        loadedUrl: state.url,
        beforeUrl: before.url,
        afterBridgeUrl: afterBridge.url,
        tab: state.tab,
      });
      await page.screenshot({
        path: join(
          output,
          `${theme}-${target.startsWith('file:') ? 'file' : 'scheme'}.png`,
        ),
      });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { packaged: info.packaged, dataIsolation: true, cases, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      packaged: info.packaged,
      checks: cases.length,
      errors,
      output,
    }),
  );
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      { error: String(error), activeCase, cases, errors },
      null,
      2,
    ),
  );
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections();
  await new Promise((done) => site.close(done));
  await rm(temp, { recursive: true, force: true });
}
