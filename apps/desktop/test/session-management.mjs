// Real renderer/preload/worker organization: archiving never deletes core history or a folder.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readModelRequests } from './helpers/model-requests.mjs';
import { readViewport, setViewport } from './helpers/viewport.mjs';
import {
  captureSessionFailure,
  cleanupSessionTest,
} from './helpers/session-failure.mjs';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-session-management-'));
const output = resolve(
  root,
  '../../outputs/session-management',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const requests = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath: requests,
    replies: [
      {
        message: {
          id: 'saved',
          role: 'assistant',
          content: 'saved fixture answer',
        },
      },
      {
        message: {
          id: 'write',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'write',
              name: 'write_file',
              args: {
                file_path: 'kept.txt',
                content: 'approved fixture bytes',
              },
            },
          ],
        },
      },
      {
        message: {
          id: 'done',
          role: 'assistant',
          content: 'approved fixture answer',
        },
      },
      ...[2, 120, 0].map((offset, index) => ({
        message: {
          id: `read-${index}`,
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `page-${index}`,
              name: 'read_file',
              args: { file_path: 'source.txt', offset, limit: 20 },
            },
          ],
        },
      })),
      {
        message: {
          id: 'read-done',
          role: 'assistant',
          content: 'read both fixture lines',
        },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot}\\System32`
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let app;
const errors = [];
const checks = [];
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  // Each message box the window mounts, from its first frame. Playwright holds
  // the app's ready event until launch returns, and the window opens only after
  // the runtime has started, so this is in place before the page exists.
  await app.context().addInitScript(() => {
    const boxes = (window.__circleMessageBoxes = []);
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches('textarea[aria-label="message"]')
            ? [node]
            : node.querySelectorAll('textarea[aria-label="message"]');
          for (const box of found)
            boxes.push({ home: !!box.closest('.home'), hash: location.hash });
        }
    }).observe(document, { childList: true, subtree: true });
  });
  let page = await app.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
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
  const until = async (predicate, label) => {
    const end = Date.now() + patience(12000);
    while (!(await predicate())) {
      assert(Date.now() < end, label);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const route = async (path) => {
    await page.evaluate((value) => {
      location.hash = value;
    }, path);
    await page.waitForURL((url) => url.hash === `#${path}`);
  };
  const send = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  await send('first managed fixture');
  await page.getByText('saved fixture answer', { exact: true }).waitFor();
  // The window opens with the home composer and keeps it until the send. Its
  // start route once showed a conversation box first and swapped it for home,
  // dropping what had been typed into the first one (#145).
  const boxes = await page.evaluate(() => window.__circleMessageBoxes);
  assert.ok(boxes, 'message boxes are recorded from the first frame');
  assert.equal(boxes[0]?.home, true, JSON.stringify(boxes));
  assert.equal(
    boxes.filter((box) => box.home).length,
    1,
    JSON.stringify(boxes),
  );
  assert.deepEqual(
    (await readModelRequests(requests, { requireComplete: true }))[0].messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
    ['first managed fixture'],
  );
  checks.push(
    'the composer the window opens with is the one that sends the first request',
  );
  const a = (await state()).activeSessionId;
  assert.equal((await command('new-session')).ok, true);
  const b = (await state()).activeSessionId;
  assert.notEqual(b, a);
  // The sidebar and the session list hide a placeholder title with no messages.
  // Name this one before either surface is asked to open it. Sending would
  // consume the scripted write that the approval turn still needs.
  assert.equal(
    (
      await command('rename-session', {
        id: b,
        title: 'managed fixture B',
      })
    ).ok,
    true,
  );
  await until(
    async () =>
      (await state()).sessions.find((session) => session.id === b).title ===
      'managed fixture B',
    'the second session is named before it is listed',
  );
  const current = (await state()).sessions.find((session) => session.id === a);
  await page
    .getByRole('button', {
      name: `session actions for ${current.title}`,
      exact: true,
    })
    .first()
    .click();
  await page.getByRole('menuitem', { name: /^rename session\b/ }).click();
  const rename = page.getByRole('textbox', {
    name: 'rename session',
    exact: true,
  });
  await rename.fill('managed fixture A');
  await rename.press('Enter');
  await until(
    async () =>
      (await state()).sessions.find((session) => session.id === a).title ===
      'managed fixture A',
    'the selected sidebar row is renamed, not the active session',
  );
  assert.notEqual(
    (await state()).sessions.find((session) => session.id === b).title,
    'managed fixture A',
  );
  checks.push(
    'sidebar rename targets its selected session while another session is open',
  );
  const menu = () =>
    page
      .getByRole('button', {
        name: 'session actions for managed fixture A',
        exact: true,
      })
      .first();
  await menu().click();
  await page
    .getByRole('menuitem', { name: 'pin session', exact: true })
    .click();
  await menu().click();
  await page
    .getByRole('menuitem', { name: 'unpin session', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  checks.push('sidebar pin is retained by the live presentation store');
  const originalViewport = await readViewport(page);
  const focusedRowViewport = await setViewport(app, page, {
    width: 1024,
    height: 684,
  });
  await writeFile(
    join(output, 'focus-lifecycle-viewport.json'),
    JSON.stringify(focusedRowViewport, null, 2) + '\n',
  );
  await menu().focus();
  await page
    .getByRole('tooltip')
    .filter({ hasText: 'session actions for managed fixture A' })
    .waitFor();
  assert.equal(
    (await command('archive-session', { id: a, archived: true })).ok,
    true,
  );
  const restoredRows = () =>
    page
      .locator('.sidebar .session-link')
      .filter({ hasText: 'managed fixture A' });
  await until(
    async () => (await restoredRows().count()) === 0,
    'focused row removed',
  );
  assert.equal(
    (await command('archive-session', { id: a, archived: false })).ok,
    true,
  );
  await until(
    async () => (await restoredRows().count()) > 0,
    'focused row restored',
  );
  const restoredWorkspace = (await state()).workspaces.find(
    (item) => item.id === current.workspaceId,
  );
  await page
    .getByRole('button', {
      name: `workspace actions for ${restoredWorkspace.name}`,
      exact: true,
    })
    .click();
  await page
    .getByRole('menuitem', { name: 'archive all sessions', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page
    .locator('.sidebar .session-link')
    .filter({ hasText: 'managed fixture B' })
    .first()
    .click();
  await until(
    async () => (await state()).activeSessionId === b,
    'restored row does not block B',
  );
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(
    await page
      .getByRole('tooltip')
      .filter({ hasText: 'session actions for managed fixture A' })
      .count(),
    0,
  );
  checks.push(
    'removing a focused sidebar row releases its menu tooltip ownership',
  );
  await setViewport(app, page, originalViewport);
  await menu().click();
  await page
    .getByRole('menuitem', { name: 'archive session', exact: true })
    .click();
  await until(
    async () =>
      !!(await state()).sessions.find((session) => session.id === a).archivedAt,
    'native archive acknowledged',
  );
  assert.equal(
    await page
      .locator('.sidebar .session-link')
      .filter({ hasText: 'managed fixture A' })
      .count(),
    0,
  );
  await route('/page/sessions');
  await page
    .getByRole('checkbox', { name: 'archived sessions', exact: true })
    .check();
  await page
    .locator('.record-row')
    .filter({ hasText: 'managed fixture A' })
    .locator('.record-main')
    .click();
  await page.getByText('saved fixture answer', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'message', exact: true }).count(),
    0,
  );
  const blocked = await command('prompt', {
    text: 'must not reach the model while archived',
  });
  assert.equal(blocked.ok, false);
  await page
    .getByRole('button', { name: 'restore conversation', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  checks.push(
    'archive hides the sidebar row, retains readable history, blocks sending, and restores explicitly',
  );
  await send('write only after approval');
  await until(
    async () =>
      (await state()).interactions.some((row) => row.status === 'pending'),
    'write waits for approval',
  );
  const approvalState = await state();
  const workspace = approvalState.workspaces.find(
    (item) =>
      item.id ===
      approvalState.sessions.find((session) => session.id === a).workspaceId,
  );
  const workspaceMenu = () =>
    page.getByRole('button', {
      name: `workspace actions for ${workspace.name}`,
      exact: true,
    });
  await workspaceMenu().click();
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'archive all sessions', exact: true })
      .getAttribute('data-disabled'),
    '',
  );
  await page.keyboard.press('Escape');
  await page
    .locator('.sidebar .session-link')
    .filter({
      hasText: (await state()).sessions.find((session) => session.id === b)
        .title,
    })
    .first()
    .click();
  await until(
    async () => (await state()).activeSessionId === b,
    'background session selected',
  );
  await page
    .locator('.sidebar .session-link')
    .filter({ hasText: 'managed fixture A' })
    .first()
    .click();
  await until(
    async () => (await state()).activeSessionId === a,
    'approval session selected',
  );
  const decision = (await state()).interactions.find(
    (row) => row.status === 'pending',
  );
  assert.equal(
    (
      await command('answer', {
        id: decision.id,
        revision: decision.revision,
        answer: 'approve',
      })
    ).ok,
    true,
  );
  await page.getByText('approved fixture answer', { exact: true }).waitFor();
  assert.equal(
    await readFile(join(workspace.path, 'kept.txt'), 'utf8'),
    'approved fixture bytes',
  );
  const modelRequests = await readModelRequests(requests, {
    requireComplete: true,
  });
  assert.equal(
    modelRequests
      .at(-1)
      .messages.find((message) => message.tool_call_id === 'write').status,
    'success',
  );
  checks.push(
    'busy bulk archive is disabled, sidebar approval round trip works, and the real write reaches the next model request',
  );
  await until(
    async () =>
      (await state()).sessions.find((session) => session.id === a).state ===
      'idle',
    'approved turn finishes',
  );
  await writeFile(join(workspace.path, 'source.txt'), 'alpha\nbeta\n');
  await send('read the fixture past EOF and recover');
  await page.getByText('read both fixture lines', { exact: true }).waitFor();
  await until(
    async () =>
      (await state()).sessions.find((session) => session.id === a).state ===
      'idle',
    'EOF turn finishes',
  );
  const eofRequests = await readModelRequests(requests, {
    requireComplete: true,
  });
  const eofResults = eofRequests
    .at(-1)
    .messages.filter((message) =>
      /^page-[0-2]$/.test(message.tool_call_id ?? ''),
    );
  assert.deepEqual(
    eofResults.map((message) => message.status),
    ['success', 'success', 'success'],
  );
  assert.match(eofResults[0].content, /offset 2.*2 lines/);
  assert.match(eofResults[1].content, /offset 120.*2 lines/);
  assert.equal(eofResults[2].content, '1: alpha\n2: beta');
  checks.push(
    'native EOF offsets 2 and 120 succeed, a valid reread recovers, and all results reach the next model request',
  );
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await workspaceMenu().click();
    await page
      .getByRole('menuitem', {
        name:
          process.platform === 'darwin' ? 'show in finder' : 'show in folder',
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: join(output, `workspace-menu-${theme}.png`),
    });
    await page.keyboard.press('Escape');
    await route('/page/settings');
    await page.locator('.network-status summary').click();
    const network = (await state()).runtime.network;
    assert(network.authorities > 0);
    await page.getByText('network trust', { exact: false }).waitFor();
    await page.screenshot({ path: join(output, `network-trust-${theme}.png`) });
    await route(`/session/${a}`);
  }
  checks.push(
    'worker network trust and workspace actions are visible in both palettes',
  );
  await workspaceMenu().click();
  await page
    .getByRole('menuitem', { name: 'archive all sessions', exact: true })
    .click();
  await until(
    async () =>
      (await state()).sessions
        .filter((session) => session.workspaceId === workspace.id)
        .every((session) => session.archivedAt),
    'whole workspace archived',
  );
  assert.equal(await page.locator('.sidebar .project').count(), 0);
  assert.equal(
    await readFile(join(workspace.path, 'kept.txt'), 'utf8'),
    'approved fixture bytes',
  );
  checks.push(
    'archive all removes the empty visible group and preserves workspace file bytes',
  );
  await app.close();
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
  await page
    .getByRole('button', { name: 'restore conversation', exact: true })
    .waitFor();
  assert.equal((await state()).activeSessionId, a);
  const persistedReads = (await state()).sessions
    .find((session) => session.id === a)
    .messages.filter((message) => /^page-[0-2]$/.test(message.tool?.id ?? ''));
  assert.deepEqual(
    persistedReads.map((message) => [message.tool.status, message.tool.output]),
    eofResults.map((message) => [message.status, message.content]),
  );
  assert(
    (await state()).sessions
      .filter((session) => session.workspaceId === workspace.id)
      .every((session) => session.archivedAt),
  );
  assert.equal(
    await readFile(join(workspace.path, 'kept.txt'), 'utf8'),
    'approved fixture bytes',
  );
  checks.push(
    'archive state and original workspace bytes survive an actual application restart',
  );
  await route('/page/sessions');
  await page
    .getByRole('checkbox', { name: 'archived sessions', exact: true })
    .check();
  const other = (await state()).sessions.find((session) => session.id === b);
  await page
    .getByRole('button', {
      name: `session actions for ${other.title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole('menuitem', { name: 'delete session', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'delete local session', exact: true })
    .click();
  await until(
    async () => !(await state()).sessions.some((session) => session.id === b),
    'selected archived session deleted after confirmation',
  );
  assert((await state()).sessions.some((session) => session.id === a));
  assert.equal(
    await readFile(join(workspace.path, 'kept.txt'), 'utf8'),
    'approved fixture bytes',
  );
  checks.push(
    'deleting an archived idle session uses the existing confirmation and keeps the open conversation and folder',
  );
  assert.deepEqual(errors, []);
  await readModelRequests(requests, { requireComplete: true });
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        info: await page.evaluate(() => window.circleDesktop.info()),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      packaged: (await page.evaluate(() => window.circleDesktop.info()))
        .packaged,
      errors,
    }),
  );
} catch (error) {
  await captureSessionFailure(app, error, output);
  throw error;
} finally {
  if (
    !(await cleanupSessionTest([
      () => app?.close(),
      () => rm(temp, { recursive: true, force: true }),
    ]))
  )
    process.exitCode = 1;
}
