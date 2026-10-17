// Native renderer/preload/worker regression: two real model calls remain in flight
// in the same folder while selecting, stopping and deleting independent sessions.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { readModelRequests } from './helpers/model-requests.mjs';
import { readViewport, setViewport } from './helpers/viewport.mjs';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-parallel-sessions-'));
const packaged = Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
const output = resolve(
  root,
  '../../outputs/parallel-sessions',
  packaged ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
await Promise.all(
  [
    'receipt.json',
    'failure.json',
    'failure.png',
    'tool-hover-hit-target.json',
  ].map((name) => rm(join(output, name), { force: true })),
);
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
const longAnswer = Array.from(
  { length: 80 },
  (_, index) => `fixture line ${index + 1}\n\n`,
).join('');
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        message: {
          id: 'a-saved',
          role: 'assistant',
          content: longAnswer,
          thinking: 'A independent reasoning',
        },
      },
      { waitForAbort: true },
      { waitForAbort: true },
      {
        message: {
          id: 'b-write',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'b-file',
              name: 'write_file',
              args: { file_path: 'only-b.txt', content: 'B approved bytes\n' },
            },
          ],
        },
      },
      {
        message: {
          id: 'b-saved',
          role: 'assistant',
          content: 'B independently completed',
          thinking: 'B independent reasoning',
        },
      },
      { waitForAbort: true },
      { waitForAbort: true },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (packaged)
  env.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot}\\System32`
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const browserServer = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    `<title>synthetic browser ${request.url}</title><p>isolated browser fixture</p>`,
  );
});
await new Promise((done) => browserServer.listen(0, '127.0.0.1', done));
const browserUrl = `http://127.0.0.1:${browserServer.address().port}`;
let app;
let page;
const checks = [];
const errors = [];
let lastState;
const modelRequests = (options) => readModelRequests(requestsPath, options);
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
  const state = async () => {
    lastState = await page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
    return lastState;
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + patience(12000);
    while (!(await predicate())) {
      assert(Date.now() < deadline, label);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const command = async (name, payload = {}, sessionId) => {
    const reply = await page.evaluate(
      async ({ name, payload, sessionId }) => {
        const current = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: sessionId ?? current.snapshot.activeSessionId,
        });
      },
      { name, payload, sessionId },
    );
    return reply;
  };
  const okay = async (...args) => {
    const reply = await command(...args);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const session = async (id) =>
    (await state()).sessions.find((item) => item.id === id);
  const select = async (id) => {
    await page
      .locator(`.sidebar .session-link[href="#/session/${id}"]`)
      .first()
      .click();
    await until(
      async () => (await state()).activeSessionId === id,
      `select ${id}`,
    );
  };
  const send = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  const newSession = async (name) => {
    const { sessionId } = await okay('new-session');
    await okay('rename-session', { id: sessionId, title: name });
    await page.evaluate((id) => {
      location.hash = '/session/' + id;
    }, sessionId);
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
    return sessionId;
  };
  const remove = async (id, label) => {
    await page
      .getByRole('button', {
        name: `session actions for ${label}`,
        exact: true,
      })
      .first()
      .click();
    await page
      .getByRole('menuitem', { name: 'delete session', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {
        name: 'stop work and delete session',
        exact: true,
      })
      .click();
    await until(async () => !(await session(id)), `delete ${label}`);
  };
  const addPicture = async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      );
      transfer.items.add(
        new File([bytes], 'A-picture.png', { type: 'image/png' }),
      );
      document.querySelector('textarea[aria-label="message"]').dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.getByText('A-picture.png', { exact: true }).waitFor();
  };
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.circleDesktop.info())).packaged,
    packaged,
  );
  const a = (await state()).activeSessionId;
  // The home composer reuses this untitled session for the first message.
  // Naming it first would make that message start a different session.
  await send('A saved baseline');
  await page.getByText('fixture line 80', { exact: true }).waitFor();
  await okay('rename-session', { id: a, title: 'parallel A' });
  await until(async () => (await session(a)).state === 'idle', 'A saved');
  await send('A hold open');
  await until(
    async () => (await modelRequests()).length === 2,
    'A request in flight',
  );
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('A unsent draft');
  await addPicture();
  await page.locator('details.thinking > summary').click();
  await page.evaluate(() => {
    const box = document.querySelector('.transcript');
    box.scrollTo({ top: 120, behavior: 'instant' });
    box.dispatchEvent(new Event('scroll'));
  });
  const savedTop = await page
    .locator('.transcript')
    .evaluate((box) => box.scrollTop);
  assert(savedTop > 0);
  const b = await newSession('parallel B');
  assert.equal((await session(a)).workspaceId, (await session(b)).workspaceId);
  await send('B hold open');
  await until(
    async () => (await modelRequests()).length === 3,
    'B request in flight before A finishes',
  );
  assert.equal((await session(a)).state, 'waiting');
  assert.equal((await session(b)).state, 'waiting');
  checks.push(
    'same-folder A and B model requests are simultaneously in flight',
  );
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('B unsent draft');
  await select(a);
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'A unsent draft',
  );
  assert.equal(
    await page.locator('details.thinking').evaluate((element) => element.open),
    true,
  );
  assert(
    Math.abs(
      (await page.locator('.transcript').evaluate((box) => box.scrollTop)) -
        savedTop,
    ) < 2,
    `A scroll restored to ${savedTop}; view ${JSON.stringify(await page.evaluate(() => ({ top: document.querySelector('.transcript').scrollTop, local: localStorage.getItem('circle.workbench.live.views.v1') })))}`,
  );
  await page.getByText('A-picture.png', { exact: true }).waitFor();
  await select(b);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'B unsent draft',
  );
  assert.equal(await page.locator('.attachment-strip').count(), 0);
  checks.push(
    'draft, picture attachment, thinking fold and manual scroll survive switching running sessions',
  );
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('Home');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('ArrowUp');
  await select(a);
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('ArrowDown');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'A unsent draft',
    'B history navigation cannot restore B draft into A',
  );
  await select(b);
  await page
    .getByRole('button', { name: 'pause conversation', exact: true })
    .click();
  await until(async () => (await session(b)).state !== 'waiting', 'B stopped');
  assert.equal((await session(a)).state, 'waiting');
  checks.push('stopping B leaves A model request running');
  await send('B write after approval');
  await until(
    async () =>
      (await state()).interactions.some(
        (item) => item.sessionId === b && item.status === 'pending',
      ),
    'B approval',
  );
  await select(a);
  assert.equal((await state()).activeSessionId, a);
  const pending = (await state()).interactions.find(
    (item) => item.sessionId === b && item.status === 'pending',
  );
  assert(pending);
  await page
    .locator(`.sidebar .session-link[href="#/session/${b}"] .attention-dot`)
    .first()
    .waitFor();
  assert.equal(
    await page.locator('.inline-request').count(),
    0,
    'background approval does not take A focus',
  );
  await select(b);
  await okay(
    'answer',
    { id: pending.id, revision: pending.revision, answer: 'approve' },
    b,
  );
  await page.getByText('B independently completed', { exact: true }).waitFor();
  await until(
    async () => (await session(b)).state === 'idle',
    'B completes independently',
  );
  const bWorkspaceId = (await session(b)).workspaceId;
  const workspace = (await state()).workspaces.find(
    (item) => item.id === bWorkspaceId,
  );
  assert.equal(
    await readFile(join(workspace.path, 'only-b.txt'), 'utf8'),
    'B approved bytes\n',
  );
  const requests = await modelRequests();
  assert.equal(
    requests
      .at(-1)
      .messages.find((message) => message.tool_call_id === 'b-file').status,
    'success',
  );
  assert(
    !requests
      .at(-1)
      .messages.some((message) => message.content === 'A hold open'),
  );
  assert.equal((await session(a)).state, 'waiting');
  checks.push(
    'background approval remains reachable and produces B-only file effect and next model request',
  );
  const toolViewport = await readViewport(page);
  await setViewport(app, page, { width: 1024, height: 700 });
  await page.locator('.tool-summary').scrollIntoViewIfNeeded();
  const sessionLink = page
    .locator(`.sidebar .session-link[href="#/session/${b}"]`)
    .first();
  // Move onto the row in steps, as a hand does: a single jump after the
  // resize can land where the sidebar still counts as just scrolled.
  const row = await sessionLink.boundingBox();
  await page.mouse.move(row.x + row.width / 2, row.y - 40);
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2, {
    steps: 8,
  });
  await sessionLink.hover();
  // Focus opens the same card; Windows runners do not always report the hover.
  await sessionLink.focus();
  // Bring the tool row under the hover card: where they meet depends on each
  // platform's fonts, and the check below needs them to overlap.
  await page.waitForFunction(
    () =>
      document
        .querySelector('.session-hover')
        ?.closest('[data-radix-popper-content-wrapper]'),
    undefined,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const button = document.querySelector('.tool-summary');
    const card = document
      .querySelector('.session-hover')
      .closest('[data-radix-popper-content-wrapper]')
      .getBoundingClientRect();
    const transcript = button.closest('.transcript');
    const tool = button.getBoundingClientRect();
    transcript.scrollTop +=
      tool.top - (card.top + card.height / 2 - tool.height / 2);
  });
  await page.waitForFunction(() => {
    const button = document.querySelector('.tool-summary');
    const tooltip = document.querySelector('.session-hover');
    const wrapper = tooltip?.closest('[data-radix-popper-content-wrapper]');
    if (!button || !wrapper) return false;
    const tool = button.getBoundingClientRect();
    const card = wrapper.getBoundingClientRect();
    return (
      Math.min(tool.right, card.right) - Math.max(tool.left, card.left) > 2 &&
      Math.min(tool.bottom, card.bottom) - Math.max(tool.top, card.top) > 2
    );
  });
  const toolHoverHitTarget = await page
    .locator('.tool-summary')
    .evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const tooltip = document.querySelector('.session-hover');
      const wrapper = tooltip.closest('[data-radix-popper-content-wrapper]');
      const card = wrapper.getBoundingClientRect();
      const left = Math.max(rect.left, card.left);
      const right = Math.min(rect.right, card.right);
      const top = Math.max(rect.top, card.top);
      const bottom = Math.min(rect.bottom, card.bottom);
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        point: { x, y },
        position: { x: x - rect.x, y: y - rect.y },
        intersection: { left, right, top, bottom },
        tooltipBounds: {
          x: card.x,
          y: card.y,
          width: card.width,
          height: card.height,
        },
        overlaps: right - left > 2 && bottom - top > 2,
        tooltipPointerEvents: getComputedStyle(tooltip).pointerEvents,
        wrapperPointerEvents: getComputedStyle(wrapper).pointerEvents,
        hitClass: hit?.className,
        hitWrapper: hit === wrapper,
        hitButton: hit === button || button.contains(hit),
      };
    });
  await writeFile(
    join(output, 'tool-hover-hit-target.json'),
    JSON.stringify(toolHoverHitTarget, null, 2) + '\n',
  );
  assert.equal(toolHoverHitTarget.overlaps, true);
  await page
    .locator('.tool-summary')
    .click({ position: toolHoverHitTarget.position });
  assert.equal(toolHoverHitTarget.hitButton, true);
  assert.equal(
    await page.locator('.tool-summary').getAttribute('aria-expanded'),
    'true',
  );
  await page.locator('.tool-summary').click();
  assert.equal(
    await page.locator('.tool-summary').getAttribute('aria-expanded'),
    'false',
  );
  await page.locator('.tool-summary').click();
  await page.locator('.tool-head').click();
  await page
    .locator('.tool-toolbar')
    .getByRole('button', { name: 'arguments', exact: true })
    .click();
  await select(a);
  await select(b);
  assert.equal(
    await page.locator('.tool-summary').getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(
    await page.locator('.tool-head').getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(
    await page.locator('.tool-toolbar button.active').innerText(),
    'arguments',
  );
  checks.push('individual tool folds and tool input tabs are per session');
  await setViewport(app, page, {
    width: toolViewport.width,
    height: toolViewport.height,
  });
  const c = await newSession('parallel C');
  await page.evaluate(
    ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
    { id: c, url: browserUrl + '/C' },
  );
  await send('C hold open');
  await until(async () => (await modelRequests()).length === 6, 'C started');
  const d = await newSession('parallel D');
  await page.evaluate(
    ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
    { id: d, url: browserUrl + '/D' },
  );
  const browserContents = () =>
    app.evaluate(
      ({ webContents }, origin) =>
        webContents
          .getAllWebContents()
          .filter((content) => content.getURL().startsWith(origin))
          .map((content) => ({ id: content.id, url: content.getURL() })),
      browserUrl,
    );
  const browserBefore = await browserContents();
  const browserC = browserBefore.find(
    (content) => content.url === browserUrl + '/C',
  );
  const browserD = browserBefore.find(
    (content) => content.url === browserUrl + '/D',
  );
  assert(browserC && browserD);
  await send('D hold open');
  await until(async () => (await modelRequests()).length === 7, 'D started');
  const unconfirmed = await command('delete-session', { id: c });
  assert.equal(unconfirmed.ok, false);
  assert(await session(c));
  assert.equal((await state()).activeSessionId, d);
  await remove(c, 'parallel C');
  await until(
    async () =>
      !(await browserContents()).some((content) => content.id === browserC.id),
    'deleted C browser WebContents destroyed',
  );
  assert(
    (await browserContents()).some((content) => content.id === browserD.id),
    'D browser kept alive',
  );
  await assert.rejects(
    page.evaluate(
      ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
      { id: c, url: browserUrl + '/stale' },
    ),
    /deleted|no longer|not found/,
  );
  checks.push(
    'deleting C destroys only its browser WebContents, retains D and rejects a late C navigation',
  );
  assert.equal((await state()).activeSessionId, d);
  assert.equal((await session(d)).state, 'waiting');
  assert.equal((await session(a)).state, 'waiting');
  assert.equal(
    (await state()).runtime.error,
    undefined,
    'background deletion does not report an error on the active session',
  );
  checks.push(
    'background busy deletion requires confirmation, stops its work, and leaves active and other sessions running',
  );
  await remove(d, 'parallel D');
  assert.notEqual((await state()).activeSessionId, d);
  assert.equal((await session(a)).state, 'waiting');
  checks.push(
    'active busy deletion selects an available same-folder session after cleanup',
  );
  await select(b);
  for (const theme of ['dark', 'light']) {
    await okay('save-settings', { settings: { theme } });
    await page.screenshot({ path: join(output, `parallel-${theme}.png`) });
  }
  await select(a);
  await okay('abort', {}, a);
  await until(
    async () => (await session(a)).state !== 'waiting',
    'A final stop',
  );
  const histories = {};
  for (const id of [a, b]) {
    await select(id);
    const exported = await okay('export', { format: 'jsonl' });
    histories[id] = exported.content;
    await writeFile(
      join(output, id === a ? 'A-history.jsonl' : 'B-history.jsonl'),
      exported.content,
    );
  }
  assert(!histories[a].includes('B write after approval'));
  assert(!histories[b].includes('A hold open'));
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'requests.jsonl'),
    (await modelRequests({ requireComplete: true }))
      .map((request) => JSON.stringify(request))
      .join('\n') + '\n',
  );
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        info: await page.evaluate(() => window.circleDesktop.info()),
        isolated: true,
        checks,
        errors,
        sources: await sourceEvidence(),
        renderer: await rendererEvidence(root),
        packagedAsarSha256: packaged
          ? createHash('sha256')
              .update(
                await readFile(
                  join(
                    process.env.CIRCLE_DESKTOP_APP_PATH,
                    process.platform === 'darwin'
                      ? 'Contents/Resources/app.asar'
                      : 'resources/app.asar',
                  ),
                ),
              )
              .digest('hex')
          : null,
        deletedSessionIds: [c, d],
        remainingSessionIds: (await state()).sessions.map((item) => item.id),
        effect: {
          file: 'only-b.txt',
          content: await readFile(join(workspace.path, 'only-b.txt'), 'utf8'),
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ packaged, checks: checks.length, errors, output }),
  );
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      { error: String(error), checks, errors, lastState },
      null,
      2,
    ),
  );
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  browserServer.closeAllConnections();
  await new Promise((done) => browserServer.close(done));
  await rm(temp, { recursive: true, force: true });
}
