import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeTerminalInspector } from '../../desktop/test/helpers/native-terminal-journey.mjs';
const output = process.env.CIRCLE_TERMINAL_SEARCH_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
});
const checks = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  // Every wait here is for a condition; a loaded machine needs more than 3 s.
  page.setDefaultTimeout(10_000);
  const errors = [];
  await page.addInitScript(() => {
    window.__terminalErrors = [];
    window.addEventListener('error', (event) =>
      window.__terminalErrors.push(event.message),
    );
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  for (const profile of [
    { name: 'standalone-light', embedded: false, theme: 'light', width: 1200 },
    { name: 'inspector-light', embedded: true, theme: 'light', width: 420 },
    { name: 'inspector-dark', embedded: true, theme: 'dark', width: 420 },
  ])
    for (const scenario of [
      'search waits for real xterm parsed output',
      'new query supersedes pending search',
      'session switch rejects old search',
      'unmount safely discards pending search',
    ]) {
      try {
        await page.setViewportSize({ width: profile.width, height: 800 });
        await page.goto(
          server.resolvedUrls.local[0] +
            'test/native-terminal-search-ui.html?' +
            new URLSearchParams({
              embedded: String(profile.embedded),
              theme: profile.theme,
              timing: !profile.embedded
                ? 'off'
                : profile.theme === 'dark'
                  ? 'throw'
                  : 'record',
            }),
        );
        if (profile.embedded) {
          await openNativeTerminalInspector(page);
          // A repeated request must not close the original toggle-based Inspector.
          await openNativeTerminalInspector(page);
          assert.equal(
            await page
              .getByRole('button', { name: 'terminal panel', exact: true })
              .getAttribute('aria-pressed'),
            'true',
          );
        }
        // Find opens on demand from the terminal bar.
        await page
          .getByRole('button', { name: 'find in terminal', exact: true })
          .click();
        const find = page.getByRole('textbox', {
          name: 'find in terminal',
          exact: true,
        });
        await find.waitFor();
        await page.waitForFunction(
          () => window.__terminalFixture.requests() > 0,
        );
        await find.fill('CIRCLE_TERMINAL_LINE_0001_中文');
        await find.press('Enter');
        if (scenario.startsWith('new query')) {
          await find.fill('NO_SUCH_MATCH');
          await find.press('Enter');
        } else if (scenario.startsWith('session')) {
          await page.evaluate(() => window.__terminalFixture.switchSession());
          // Both sessions name their terminal alike: wait for session B's own,
          // and for the render that shows it to settle, so the search below
          // targets it rather than being discarded with A's.
          await page.locator('#terminal-B-terminal:not([hidden])').waitFor();
          await page.evaluate(
            () =>
              new Promise((done) =>
                requestAnimationFrame(() => setTimeout(done, 0)),
              ),
          );
          await find.fill('NO_SUCH_MATCH');
          await find.press('Enter');
        } else if (scenario.startsWith('unmount'))
          await page.evaluate(() => window.__terminalFixture.unmount());
        await page.evaluate(() => window.__terminalFixture.release());
        if (scenario.startsWith('search waits')) {
          await page.waitForFunction(
            () =>
              document.querySelector('.xterm-selection')?.children.length > 0,
          );
          await find.press('Escape');
          await page.keyboard.press('Meta+c');
          await page.waitForFunction(
            () =>
              window.__terminalFixture.copied() ===
              window.__terminalFixture.lines[0],
          );
          assert.equal(
            await page.getByText('no matches', { exact: true }).isVisible(),
            false,
          );
          await page
            .getByRole('button', { name: 'copy complete output', exact: true })
            .click();
          await page.waitForFunction(() =>
            window.__terminalFixture
              .copied()
              .includes(window.__terminalFixture.lines[599]),
          );
          assert.deepEqual(
            (await page.evaluate(() => window.__terminalFixture.copied()))
              .trim()
              .split(/\r?\n/),
            await page.evaluate(() => window.__terminalFixture.lines),
          );
          if (profile.embedded) {
            const input = await page
              .locator('.xterm-helper-textarea')
              .elementHandle();
            await page
              .getByRole('button', { name: 'terminal panel', exact: true })
              .click();
            await openNativeTerminalInspector(page);
            assert.equal(
              await input.evaluate(
                (element) =>
                  element.isConnected &&
                  element === document.querySelector('.xterm-helper-textarea'),
              ),
              true,
              'hiding the original Inspector must preserve the mounted terminal',
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .evaluate((element) => element.classList.contains('embedded')),
              true,
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .getByRole('heading')
                .count(),
              0,
              'embedded terminal inherits the original Inspector heading',
            );
            assert.equal(
              await page
                .locator('.native-terminal')
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth,
                ),
              true,
              'narrow original Inspector must not introduce horizontal page overflow',
            );
            assert.ok(
              await page
                .locator('.native-terminal .segmented button.active')
                .count(),
              'terminal tabs use the original segmented control',
            );
            assert.ok(
              await page.locator('.native-terminal .status').count(),
              'terminal state uses the original status component',
            );
            await page.waitForFunction(() =>
              window.__terminalTimings.some(
                (record) => record.phase === 'write-frame',
              ),
            );
            const timings = await page.evaluate(() => window.__terminalTimings);
            for (const record of timings) {
              assert.ok(
                Object.keys(record).every((key) =>
                  [
                    'terminalId',
                    'phase',
                    'at',
                    'cursor',
                    'afterSequence',
                    'eventSequence',
                    'viewInstanceId',
                    'visibilityEpoch',
                  ].includes(key),
                ),
                'timing records must never include terminal text',
              );
              assert.ok(Number.isSafeInteger(record.at));
            }
            for (const phase of [
              'replay-request',
              'replay-response',
              'write-enqueued',
              'write-parsed',
              'write-frame',
            ])
              assert.ok(
                timings.some((record) => record.phase === phase),
                'actual replay/parser/frame timing: ' + phase,
              );
            const response = timings.find(
              (record) =>
                record.phase === 'replay-response' &&
                record.afterSequence === 0,
            );
            assert.equal(
              response.cursor,
              1,
              'product replay timing carries the exact returned cursor',
            );
            assert.ok(
              timings.find((record) => record.phase === 'write-frame').at >=
                timings.find((record) => record.phase === 'write-parsed').at,
            );
          } else {
            assert.deepEqual(
              await page.evaluate(() => window.__terminalTimings),
              [],
              'ordinary terminal use installs no timing observer',
            );
          }
          if (output)
            await page.screenshot({
              path: join(output, profile.name + '.png'),
            });
        } else if (!scenario.startsWith('unmount')) {
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.xterm-accessibility-tree')].some(
              (node) => node.textContent.includes('0600_中文'),
            ),
          );
          await page.getByText('no matches', { exact: true }).waitFor();
        } else
          await page
            .getByRole('region', { name: 'interactive terminal' })
            .waitFor({ state: 'detached' });
        assert.deepEqual(
          errors,
          [],
          'pending search must not throw after identity changes',
        );
        assert.deepEqual(
          await page.evaluate(() => window.__terminalErrors),
          [],
          'terminal resizing must not produce unhandled browser errors',
        );
        checks.push({ profile: profile.name, scenario, status: 'passed' });
      } catch (error) {
        checks.push({
          profile: profile.name,
          scenario,
          status: 'failed',
          error: String(error),
        });
        if (output)
          await page.screenshot({
            path: join(output, `failure-${checks.length}.png`),
          });
      }
    }
  for (const reason of ['exit 1', 'kernel rejected termination']) {
    await page.goto(
      server.resolvedUrls.local[0] +
        'test/native-terminal-search-ui.html?' +
        new URLSearchParams({ status: 'exited', reason, timing: 'off' }),
    );
    const footer = page.locator('.native-terminal-status > span').nth(1);
    await footer.waitFor();
    assert.equal(
      await footer.textContent(),
      reason === 'exit 1' ? 'exited (code 1)' : 'exited (code 1) · ' + reason,
      'identical terminal exit reasons appear once while distinct details remain visible',
    );
    assert.equal(
      await footer.getAttribute('title'),
      reason,
      'complete original exit reason stays available',
    );
    checks.push({
      profile: 'footer',
      scenario: 'exit reason ' + reason,
      status: 'passed',
    });
  }
  await page.goto(
    server.resolvedUrls.local[0] +
      'test/native-terminal-search-ui.html?embedded=true&timing=record',
  );
  await openNativeTerminalInspector(page);
  await page.waitForFunction(() => window.__terminalFixture.requests() > 0);
  await page
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await page.waitForFunction(
    () => window.__terminalTimings.at(-1)?.phase === 'view-inactive',
  );
  await page.evaluate(() => window.__terminalFixture.release());
  await page.waitForFunction(() =>
    window.__terminalTimings.some((record) => record.phase === 'write-parsed'),
  );
  const hiddenParse = await page.evaluate(() =>
    window.__terminalTimings.find((record) => record.phase === 'write-parsed'),
  );
  const inactive = await page.evaluate(() =>
    window.__terminalTimings.findLast(
      (record) => record.phase === 'view-inactive',
    ),
  );
  assert.equal(
    hiddenParse.visibilityEpoch,
    inactive.visibilityEpoch,
    'an already requested replay may finish while its actual view is hidden',
  );
  await openNativeTerminalInspector(page);
  // Find opens on demand with the find shortcut from inside the terminal.
  await page.locator('.xterm-helper-textarea:visible').first().focus();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  );
  const find = page.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'find in terminal',
  );
  await find.fill('CIRCLE_TERMINAL_LINE_0001_中文');
  await find.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.xterm-selection')?.children.length > 0,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const revealed = await page.evaluate(() => window.__terminalTimings);
  const active = revealed.findLast((record) => record.phase === 'view-active');
  assert.equal(
    active.viewInstanceId,
    hiddenParse.viewInstanceId,
    'hide/reveal retains the same view instance',
  );
  assert.ok(active.visibilityEpoch > hiddenParse.visibilityEpoch);
  assert.equal(
    revealed.some(
      (record) =>
        record.phase === 'write-frame' &&
        record.eventSequence === hiddenParse.eventSequence,
    ),
    false,
    'hidden parser completion must not masquerade as a visible frame after reveal',
  );
  await page
    .getByRole('button', { name: 'copy complete output', exact: true })
    .click();
  await page.waitForFunction(() =>
    window.__terminalFixture.copied().includes('0600_中文'),
  );
  assert.deepEqual(
    (await page.evaluate(() => window.__terminalFixture.copied()))
      .trim()
      .split(/\r?\n/),
    await page.evaluate(() => window.__terminalFixture.lines),
    'qualifying timing metadata never drops actual hidden terminal output',
  );
  await page.evaluate(() => window.__terminalFixture.unmount());
  await page
    .getByRole('region', { name: 'interactive terminal' })
    .waitFor({ state: 'detached' });
  await page.evaluate(() => window.__terminalFixture.remount());
  await page.waitForFunction(() =>
    window.__terminalTimings.some(
      (record) =>
        record.phase === 'view-active' &&
        record.viewInstanceId !==
          window.__terminalTimings.find((item) => item.phase === 'view-active')
            .viewInstanceId,
    ),
  );
  const instances = await page.evaluate(() => [
    ...new Set(
      window.__terminalTimings
        .filter((record) => record.phase === 'view-active')
        .map((record) => record.viewInstanceId),
    ),
  ]);
  assert.equal(
    instances.length,
    2,
    'remounting the same terminal identity must not reuse a visibility epoch namespace',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__terminalErrors), []);
  checks.push({
    profile: 'visibility',
    scenario:
      'hidden parse, real reveal, complete copy and remount retain honest frame attribution',
    status: 'passed',
  });
} finally {
  await browser?.close();
  await server.close();
  if (output)
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'actual React NativeTerminal and xterm SearchAddon with controlled replay transport',
          checks,
        },
        null,
        2,
      ),
    );
}
assert.equal(
  checks.filter((item) => item.status === 'failed').length,
  0,
  JSON.stringify(checks),
);
console.log('PASS native terminal search UI scenarios');
