import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/interface');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-interface-'));
const note = join(temp, 'import.md');
await writeFile(note, '# imported by native host\nno execution');
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    files: [note],
    exportPath: join(temp, 'export.md'),
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  cwd: root,
  env,
});
const page = await application.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
observePage(page, errors);
await page
  .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
  .waitFor({ timeout: 30000 });
if (process.env.CIRCLE_DESKTOP_CHECK_NARROW) {
  await page.waitForURL(/^circle:\/\/workbench/);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 650),
  );
  await page.waitForFunction(() => innerWidth <= 1024 && innerHeight <= 650);
  await page.reload();
}
const checks = [];
const viewport = await page.evaluate(() => ({
  width: innerWidth,
  height: innerHeight,
}));
const sourceCommands = (await import('../../../src/tui/slash_commands.ts'))
  .BUILTIN_SLASH;
const state = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1') ?? 'null'),
  );
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
async function reset() {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    location.hash = '/session/session1';
  });
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
}
const expected = {
  help: ['heading', 'commands & help'],
  hotkeys: ['dialog', 'keyboard shortcuts'],
  login: ['dialog', 'connection'],
  logout: ['dialog', 'connection'],
  trust: ['dialog', 'workspace trust'],
  settings: ['heading', 'settings'],
  themes: ['heading', 'settings'],
  mcp: ['heading', 'mcp servers'],
  extensions: ['heading', 'extensions'],
  approvals: ['heading', 'approvals'],
  jobs: ['heading', 'activity'],
  new: ['heading', 'new session'],
  resume: ['heading', 'sessions'],
  continue: ['heading', 'Fix the reconnect race'],
  name: ['dialog', 'rename session'],
  session: ['dialog', 'session details'],
  models: ['heading', 'models'],
  compact: ['dialog', 'compact context'],
  skill: ['heading', 'skills'],
  tree: ['dialog', 'session tree'],
  fork: ['dialog', 'fork session'],
  clone: ['heading', 'copy · Fix the reconnect race'],
  effort: ['heading', 'models'],
  export: ['dialog', 'export session'],
  import: ['heading', 'import.md'],
  share: ['dialog', 'export session'],
  editor: ['dialog', 'draft editor'],
  exit: ['dialog', 'close session'],
};
let clipboard;
try {
  await page.getByRole('heading', { name: 'Fix the reconnect race' }).waitFor();
  clipboard = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  for (const command of sourceCommands) {
    await reset();
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill('/' + command.name + ' ');
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .press('Enter');
    if (expected[command.name]) {
      const [role, name] = expected[command.name];
      await page.getByRole(role, { name, exact: true }).waitFor();
    } else {
      const snapshot = await state();
      if (command.name === 'plan')
        assert.equal(snapshot.sessions[0].readOnly, true);
      else if (command.name === 'yolo')
        assert.equal(snapshot.sessions[0].auto, true);
      else if (command.name === 'thinking')
        assert.equal(snapshot.sessions[0].showThinking, false);
      else if (command.name === 'details')
        await page
          .getByRole('heading', { name: 'raw output', exact: true })
          .first()
          .waitFor();
      else if (command.name === 'undo')
        assert.ok(snapshot.sessions[0].hiddenIds.length);
      else if (command.name === 'redo')
        await page
          .getByRole('status')
          .filter({ hasText: 'nothing to redo' })
          .waitFor();
      else if (command.name === 'init' || command.name === 'reload')
        assert.equal(snapshot.requests[0].kind, command.name);
      else if (command.name === 'copy') {
        await page.getByRole('status').filter({ hasText: 'copied' }).waitFor();
        assert.match(
          await application.evaluate(({ clipboard }) => clipboard.readText()),
          /sample data/,
        );
      } else if (command.name === 'unshare')
        assert.equal(snapshot.sessions[0].shared, false);
      else throw Error('missing UI assertion for ' + command.name);
    }
    checks.push('/' + command.name);
  }
  await reset();
  await page.getByRole('button', { name: 'toggle plan', exact: true }).click();
  assert.equal(await page.locator('.plan-items').count(), 0);
  await page.getByRole('button', { name: 'toggle plan', exact: true }).click();
  assert.equal(await page.locator('.plan-items').count(), 1);
  checks.push('plan folds in place without changing its records');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('keep this draft');
  await route('/page/models');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  await route('/session/session1');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'keep this draft',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('steering update');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('Enter');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('follow-up update');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('Control+q');
  assert.deepEqual(
    (await state()).sessions[0].queue.map((item) => item.kind),
    ['steering', 'follow-up'],
  );
  checks.push('draft persistence and separate queues');
  await reset();
  await route('/page/models');
  await page.getByRole('button', { name: 'connection', exact: true }).click();
  await page
    .getByLabel('api key', { exact: true })
    .fill('synthetic-api-key-not-stored');
  await page
    .getByRole('button', { name: 'save connection draft', exact: true })
    .click();
  assert.equal(
    JSON.stringify(await state()).includes('synthetic-api-key-not-stored'),
    false,
  );
  checks.push('connection secret excluded from stored state');
  await reset();
  if (
    !(await page
      .getByRole('button', { name: 'activity panel', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'toggle inspector', exact: true })
      .click();
  await page
    .getByRole('button', { name: 'activity panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: /execute needs your permission approval/ })
    .click();
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
  const decision = await state();
  assert.equal(decision.interactions[0].status, 'recorded');
  assert.equal(decision.jobs[0].state, 'running');
  checks.push('approval records do not fabricate execution success');
  await reset();
  await route('/page/knowledge');
  await page
    .getByRole('button', { name: /connection lifecycle Product behavior/ })
    .click();
  await page
    .getByRole('button', { name: 'attach revision', exact: true })
    .click();
  const before = await state();
  await page
    .getByRole('combobox', { name: 'source revision' })
    .selectOption('3');
  assert.deepEqual(
    (await state()).sessions[0].attachments,
    before.sessions[0].attachments,
  );
  await page.keyboard.press('Escape');
  checks.push('viewing older knowledge keeps pinned context');
  await route('/page/methods');
  await page
    .getByRole('checkbox', { name: 'load network investigation', exact: true })
    .check();
  const platformBefore = await page.evaluate(() =>
    localStorage.getItem('circle.workbench.platform-preview.v1'),
  );
  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  for (const id of ['knowledge', 'work', 'execution', 'methods'])
    await page
      .getByRole('checkbox', {
        name: 'enable ' + id + ' interface',
        exact: true,
      })
      .uncheck();
  assert.equal(
    await page.getByRole('link', { name: 'knowledge', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('circle.workbench.platform-preview.v1'),
    ),
    platformBefore,
  );
  await route('/session/session1');
  assert.equal(
    await page.getByRole('button', { name: 'knowledge', exact: true }).count(),
    0,
  );
  assert.ok((await state()).sessions[0].attachments.length > 0);
  checks.push(
    'platform plugins can be removed from the UI while retaining data',
  );
  await reset();
  await route('/page/settings');
  await page
    .getByRole('textbox', { name: 'keybindings json', exact: true })
    .fill('{"model.select":"f3"}');
  await page
    .getByRole('button', { name: 'save key preferences', exact: true })
    .click();
  await route('/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).press('F3');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  checks.push('custom key binding invokes its configured action');
  await reset();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(800, 650),
  );
  await page.waitForFunction(() => innerWidth <= 800);
  await page
    .getByRole('dialog', { name: 'inspector', exact: true })
    .waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: join(output, 'desktop-narrow.png') });
  checks.push('native window resizing keeps a bounded layout');
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        sourceFiles: await sourceEvidence(),
        buildFiles: await rendererEvidence(root),
        commands: sourceCommands.length,
        viewport,
        checks,
        errors,
        scope:
          'native desktop UI and local preview behavior; no model or external platform service',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      commands: sourceCommands.length,
      checks: checks.length,
      errors,
    }),
  );
} catch (error) {
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (clipboard !== undefined)
    await application
      .evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboard)
      .catch(() => {});
  await application.close();
  await rm(temp, { recursive: true, force: true });
}
