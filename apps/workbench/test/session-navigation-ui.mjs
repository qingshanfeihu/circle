import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
let page;
const output =
  process.env.CIRCLE_SESSION_NAV_EVIDENCE || '/tmp/circle-session-navigation';
await mkdir(output, { recursive: true });
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(
    server.resolvedUrls.local[0] +
      'test/session-navigation-ui.html#/session/navigation-history',
  );
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const choose = async (title) => {
    await page.keyboard.press('Control+k');
    const search = page.getByRole('textbox', {
      name: 'global search',
      exact: true,
    });
    await search.waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('aria-label') === 'global search',
    );
    await search.fill(title);
    await page
      .locator('.search-results button')
      .filter({ has: page.getByText(title, { exact: true }) })
      .click();
    await search.waitFor({ state: 'hidden' });
  };
  const pending = async (id) =>
    page.waitForFunction((id) => window.navigationFixture.pending.has(id), id);
  const publish = async (id) =>
    page.evaluate((id) => window.navigationFixture.publish(id), id);
  const resolve = async (id) =>
    page.evaluate((id) => window.navigationFixture.resolve(id), id);
  const aligned = async (id, title, index) => {
    await page.waitForFunction(
      ({ id, title, index }) =>
        location.hash === `#/session/${id}` &&
        window.navigationFixture.runtime.getSnapshot().activeSessionId === id &&
        document.querySelector('.session-title')?.textContent === title &&
        document
          .querySelector(`.sidebar a[href="#/session/${id}"]`)
          ?.getAttribute('aria-current') === 'page' &&
        [...document.querySelectorAll('[data-message-id]')].some((el) => {
          const bounds = el.getBoundingClientRect();
          const viewport = document
            .querySelector('.transcript')
            ?.getBoundingClientRect();
          return (
            el.textContent.includes(`ACTUAL_VISIBLE_NAVIGATION_${index}`) &&
            viewport &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.bottom > viewport.top &&
            bounds.top < viewport.bottom
          );
        }),
      { id, title, index },
    );
  };
  await aligned('navigation-history', 'navigation history', 0);
  await choose('navigation alternate');
  await pending('navigation-alternate');
  await publish('navigation-alternate');
  assert.equal(
    await page.evaluate(() => location.hash),
    '#/session/navigation-history',
    'do not commit an unacknowledged selection',
  );
  await resolve('navigation-alternate');
  await aligned('navigation-alternate', 'navigation alternate', 1);
  await page.screenshot({ path: `${output}/single-delayed-selection.png` });
  await choose('navigation history');
  await pending('navigation-history');
  await choose('navigation third');
  assert.equal(
    await page.evaluate(
      () =>
        window.navigationFixture.commands.filter(
          (c) =>
            c.name === 'select-session' && c.payload.id === 'navigation-third',
        ).length,
    ),
    0,
    'new selection waits for in-flight backend ownership change',
  );
  await publish('navigation-history');
  await resolve('navigation-history');
  await pending('navigation-third');
  assert.equal(
    await page.evaluate(() => location.hash),
    '#/session/navigation-alternate',
    'superseded A completion cannot navigate backwards',
  );
  await publish('navigation-third');
  await resolve('navigation-third');
  await aligned('navigation-third', 'navigation third', 2);
  assert.equal(
    await page.locator('.composer textarea').inputValue(),
    'retained navigation draft',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/latest-selection-wins.png` });
  // A page opened while a session is still being selected keeps the screen:
  // the selection completes in the runtime but does not pull the route back.
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const sidebarRow = (id) =>
    page.locator(`.sidebar a[href="#/session/${id}"]`).first();
  for (const [how, select] of [
    ['sidebar', () => sidebarRow('navigation-alternate').click()],
    ['search', () => choose('navigation alternate')],
  ]) {
    await select();
    await pending('navigation-alternate');
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'settings', exact: true })
      .click();
    await page.waitForFunction(() => location.hash === '#/page/settings');
    await publish('navigation-alternate');
    await resolve('navigation-alternate');
    await page.waitForFunction(
      () =>
        window.navigationFixture.runtime.getSnapshot().activeSessionId ===
        'navigation-alternate',
    );
    await frames();
    assert.equal(
      await page.evaluate(() => location.hash),
      '#/page/settings',
      `a ${how} selection that completes after settings opened leaves settings shown`,
    );
    // Back to the third session, as a person would, for the next case.
    await sidebarRow('navigation-third').click();
    await pending('navigation-third');
    await publish('navigation-third');
    await resolve('navigation-third');
    await aligned('navigation-third', 'navigation third', 2);
  }
  assert.deepEqual(errors, []);
  const receipt = await page.evaluate(() => ({
    hash: location.hash,
    activeSessionId:
      window.navigationFixture.runtime.getSnapshot().activeSessionId,
    header: document.querySelector('.session-title')?.textContent,
    ariaCurrent: document
      .querySelector('.sidebar a[aria-current=page]')
      ?.getAttribute('href'),
    commands: window.navigationFixture.commands
      .filter((c) => c.name === 'select-session')
      .map((c) => c.payload.id),
  }));
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        passed: true,
        native: false,
        scope:
          'Full CircleWorkbench with actual LiveRuntime and deliberately delayed command acknowledgements/state events',
        receipt,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, receipt, output }));
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  const actual = await page
    ?.evaluate(() => ({
      hash: location.hash,
      activeSessionId:
        window.navigationFixture?.runtime.getSnapshot().activeSessionId,
      header: document.querySelector('.session-title')?.textContent,
      ariaCurrent: document
        .querySelector('.sidebar a[aria-current=page]')
        ?.getAttribute('href'),
      visibleBody: document.querySelector('.transcript')?.textContent,
    }))
    .catch(() => null);
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ passed: false, error: String(error), actual }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
