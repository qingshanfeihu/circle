// Issues #5/#22 through the sandboxed native renderer, preload and real worker/Harness.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readModelRequests } from './helpers/model-requests.mjs';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-ui-issues-'));
const output = resolve(
  root,
  '../../outputs/ui-issues',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
// The synthetic child uses an explicit test program, never a Node found on the host PATH.
const fixtureNode =
  process.platform === 'win32'
    ? `"${process.execPath.replaceAll('"', '""')}"`
    : `'${process.execPath.replaceAll("'", "'\\''")}'`;
const childCommand = `${fixtureNode} -e "setTimeout(() => {}, 1200)"`;
const todos = Array.from({ length: 12 }, (_, i) => ({
  content: `fixture step ${i + 1}`,
  status: 'pending',
}));
const done = todos.map((todo) => ({ ...todo, status: 'completed' }));
const call = (id, name, args) => ({
  message: {
    id,
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `${id}-tool`, name, args }],
  },
});
const answer = (id, content) => ({
  message: { id, role: 'assistant', content },
});
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      call('pending-todos', 'write_todos', { todos }),
      { waitForAbort: true },
      call('complete-todos', 'write_todos', { todos: done }),
      call('repeat-todos', 'write_todos', { todos: done }),
      answer('completion-answer', 'completion answer'),
      call('exit-plan', 'plan_exit', {}),
      answer('continue-plan', 'plan retained'),
      call('parent-task', 'task', {
        description: 'check activity fixture',
        subagent_type: 'general-purpose',
      }),
      call('child-command', 'execute', {
        command: childCommand,
      }),
      call('child-write', 'write_file', {
        file_path: 'activity.txt',
        content: 'actual child bytes',
      }),
      answer('child-answer', 'child fixture finished'),
      answer('parent-answer', 'parent fixture finished'),
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let application;
const errors = [];
const checks = [];
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
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
  const until = async (check, label) => {
    const deadline = Date.now() + patience(12000);
    while (!(await check())) {
      assert(Date.now() < deadline, label);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  await send('show pending plan');
  const plan = page.getByRole('region', { name: 'plan steps' });
  await plan.waitFor();
  await until(
    async () => (await readModelRequests(requestsPath)).length >= 2,
    'waiting model request',
  );
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    const composer = page.getByRole('textbox', {
      name: 'message',
      exact: true,
    });
    await composer.fill('kept draft\nsecond line');
    await composer.press('Alt+p');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'plan steps',
    );
    await plan.evaluate((element) => {
      element.scrollTop = 0;
    });
    await plan.press('ArrowDown');
    assert((await plan.evaluate((element) => element.scrollTop)) > 0);
    await page.screenshot({ path: join(output, `plan-focus-${theme}.png`) });
    await plan.press('Escape');
    assert(
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .evaluate((element) => document.activeElement === element),
    );
    assert.equal(await composer.inputValue(), 'kept draft\nsecond line');
  }
  checks.push(
    'native plan owns arrow scrolling and Escape returns to the unchanged composer in both themes',
  );
  await command('abort');
  await send('complete the plan');
  await page.getByText('completion answer', { exact: true }).waitFor();
  assert.equal(await page.locator('.plan').count(), 0);
  assert.equal(
    await page.getByText('plan completed · 12 steps', { exact: true }).count(),
    1,
  );
  const finished = await state();
  const session = finished.sessions.find(
    (row) => row.id === finished.activeSessionId,
  );
  assert.equal(session.todos.length, 12);
  const notice = session.messages.findIndex(
    (message) => message.planCompleted === 12,
  );
  await writeFile(
    join(output, 'completion-state.json'),
    JSON.stringify(session, null, 2),
  );
  assert(
    notice >= 0 &&
      notice <
        session.messages.findIndex(
          (message) => message.text === 'completion answer',
        ),
  );
  checks.push(
    'native completed plan hides, keeps runtime steps and emits one anchored notice despite a duplicate todo update',
  );
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page
    .getByRole('group', { name: 'language', exact: true })
    .getByRole('button', { name: '简体中文', exact: true })
    .click();
  await page.evaluate((id) => {
    location.hash = '/session/' + id;
  }, finished.activeSessionId);
  await page.getByText('计划已完成 · 12 个步骤', { exact: true }).waitFor();
  assert.equal(
    await page.getByText('completion answer', { exact: true }).count(),
    1,
  );
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await page.screenshot({ path: join(output, `completion-zh-${theme}.png`) });
  }
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.evaluate((id) => {
    location.hash = '/session/' + id;
  }, finished.activeSessionId);
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  checks.push(
    'native completion notice is translated in Chinese under both palettes without translating model content',
  );
  await command('set-plan-mode', { enabled: true });
  await send('review completed plan');
  await page.locator('.inline-request[data-kind="question"]').waitFor();
  await writeFile(
    join(output, 'plan-exit-state.json'),
    JSON.stringify(
      { snapshot: await state(), body: await page.locator('body').innerText() },
      null,
      2,
    ),
  );
  await plan.waitFor();
  await page
    .getByRole('radio', { name: 'continue planning', exact: true })
    .check();
  await page.getByRole('button', { name: 'send answer', exact: true }).click();
  await page.getByText('plan retained', { exact: true }).waitFor();
  assert.equal(await page.locator('.plan').count(), 0);
  checks.push(
    'native plan-exit approval retains the completed plan for review',
  );
  await command('set-plan-mode', { enabled: false });
  await send('start activity fixture');
  await page.locator('.inline-request[data-kind="approval"]').waitFor();
  assert.match(
    await page.locator('.running-strip').innerText(),
    /waiting for you/,
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
  await until(
    async () => /Bash\(/.test(await page.locator('.running-strip').innerText()),
    'actual running command activity',
  );
  await page.screenshot({ path: join(output, 'agent-actual-step.png') });
  assert(
    (await state()).agents.some(
      (agent) =>
        agent.activity?.startsWith('Bash(') &&
        agent.messages.some(
          (message) => message.tool?.input.command === childCommand,
        ),
    ),
  );
  await page.locator('.inline-request[data-kind="approval"]').waitFor();
  assert.match(
    await page.locator('.running-strip').innerText(),
    /waiting for you/,
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
  await page.getByText('parent fixture finished', { exact: true }).waitFor();
  await until(async () => {
    const current = await state();
    return !current.sessions.find((row) => row.id === current.activeSessionId)
      .turn;
  }, 'parent turn finishes');
  const result = await state();
  const workspace = result.workspaces.find(
    (row) =>
      row.id ===
      result.sessions.find((row) => row.id === result.activeSessionId)
        .workspaceId,
  ).path;
  assert.equal(
    await readFile(join(workspace, 'activity.txt'), 'utf8'),
    'actual child bytes',
  );
  const requests = await readModelRequests(requestsPath, {
    requireComplete: true,
  });
  assert(
    requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content.includes('child fixture finished'),
      ),
  );
  checks.push(
    'native tool-only child activity comes from real events, approvals gate actual effects and the parent receives the result',
  );
  await command('archive-session', {
    id: result.activeSessionId,
    archived: true,
  });
  await page.getByTestId('archive-banner').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'message', exact: true }).count(),
    0,
  );
  await page
    .getByRole('button', { name: 'restore conversation', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  checks.push(
    'archived native conversation remains readable without a composer and restores explicitly',
  );
  assert.deepEqual(errors, []);
  await readModelRequests(requestsPath, { requireComplete: true });
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { checks, packaged: info.packaged, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} finally {
  await application?.close();
  await rm(temp, { recursive: true, force: true });
}
