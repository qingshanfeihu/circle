import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings.ts';
import { openNativeTerminalInspector } from './helpers/native-terminal-journey.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboardWithRecovery,
} from './helpers/native-clipboard.mjs';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = await mkdtemp(
  join(tmpdir(), 'circle-native-terminal-accessibility-'),
);
const data = join(temp, 'data'),
  home = join(data, 'runtime-home'),
  workspace = join(temp, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace);
const output = process.env.CIRCLE_NATIVE_AX_EVIDENCE ?? join(temp, 'evidence');
await mkdir(output, { recursive: true });
const sessionId = 'native-accessibility';
saveSettings(trustFolder(defaultSettings(), workspace), home);
const store = new CheckpointStore(home);
store.create(workspace, 'fixture', 'terminal accessibility', sessionId);
store.append(sessionId, [
  {
    id: 'intro',
    role: 'assistant',
    content: 'Native terminal accessibility acceptance.',
  },
]);
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId }),
);
const fixture = join(temp, 'model.json');
await writeFile(fixture, JSON.stringify({ replies: [] }));
await writeFile(
  join(workspace, 'output.cjs'),
  "for(let n=1;n<=600;n++)console.log('AX_LINE_'+String(n).padStart(4,'0')+'_中文');\n",
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
const report = { checks: [] };
let app, page, clipboard, terminalId;
const until = async (predicate, label) => {
  const end = Date.now() + patience(15000);
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error('native accessibility timeout: ' + label);
};
try {
  app = await electron.launch({
    executablePath: process.env.CIRCLE_DESKTOP_EXECUTABLE,
    args: [root],
    cwd: root,
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  clipboard = await preserveNativeClipboard(app);
  const query = (service, method, params = {}) =>
    page.evaluate(
      async ({ sessionId, service, method, params }) => {
        const r = await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: { service, method, params },
        });
        if (!r.ok) throw Error(r.error);
        return r.data;
      },
      { sessionId, service, method, params },
    );
  const panel = await openNativeTerminalInspector(page);
  await panel
    .locator('.native-terminal-toolbar')
    .getByRole('button', { name: 'new terminal', exact: true })
    .click();
  await until(async () => {
    terminalId = (await query('terminal', 'list'))[0]?.id;
    return !!terminalId;
  }, 'real terminal creation');
  const first = (await query('terminal', 'list'))[0],
    surface = panel.locator('#terminal-' + terminalId),
    input = surface.locator('.xterm-helper-textarea');
  await input.waitFor();
  const inputNode = await input.elementHandle();
  await input.focus();
  await page.keyboard.insertText(
    `'${process.execPath.replaceAll("'", "'\\''")}' output.cjs`,
  );
  await page.keyboard.press('Enter');
  let raw = '';
  await until(async () => {
    let cursor = 0;
    raw = '';
    for (let i = 0; i < 20; i++) {
      const p = await query('terminal', 'replay', {
        id: terminalId,
        afterSequence: cursor,
        limit: 512,
      });
      raw += p.events
        .filter((e) => e.kind === 'data')
        .map((e) => e.data ?? '')
        .join('');
      cursor = p.nextSequence;
      if (!p.hasMore) break;
    }
    return raw.includes('AX_LINE_0600_中文');
  }, '600 real PTY output lines');
  await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
  await until(
    () =>
      page.evaluate(
        () =>
          !!document
            .querySelector(
              '.native-terminal-surface:not([hidden]) .xterm-accessibility-tree',
            )
            ?.textContent.includes('AX_LINE_0600_中文'),
      ),
    'AUTO native accessibility enabled and actual text',
  );
  const cdp = await page.context().newCDPSession(page);
  const ax = await cdp.send('Accessibility.getFullAXTree');
  await writeFile(
    join(output, 'actual-ax-tree.json'),
    JSON.stringify(ax, null, 2),
  );
  const axRows = ax.nodes.filter((n) => n.role?.value === 'listitem');
  assert(axRows.length > 0, 'actual AX listitems exist');
  const byId = new Map(ax.nodes.map((n) => [n.nodeId, n]));
  const rowText = (node) =>
    [
      node.name?.value ?? '',
      ...(node.childIds ?? []).map((id) => rowText(byId.get(id) ?? {})),
    ].join(' ');
  assert(
    axRows.some((n) => rowText(n).includes('AX_LINE_')),
    'actual AX row text is exposed through its text descendants',
  );
  // Find opens on demand from the terminal bar.
  await panel
    .getByRole('button', { name: 'find in terminal', exact: true })
    .click();
  const find = panel.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  await find.fill('AX_LINE_0599_中文');
  await find.press('Enter');
  await until(
    () =>
      surface
        .locator('.xterm-selection div')
        .count()
        .then((n) => n > 0),
    'actual xterm selection',
  );
  const scrollBefore = await surface
    .locator('.xterm-viewport')
    .evaluate((n) => n.scrollTop);
  await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(false));
  await until(
    () =>
      page.evaluate(async () => {
        const s = await window.circleDesktop.nativeAccessibility();
        return (
          !s.enabled &&
          !document.querySelector(
            '.native-terminal-surface:not([hidden]) .xterm-accessibility-tree',
          )
        );
      }),
    'AUTO follows actual native false',
  );
  assert.equal(await input.evaluate((n, old) => n === old, inputNode), true);
  assert((await surface.locator('.xterm-selection div').count()) > 0);
  assert.equal(
    await surface.locator('.xterm-viewport').evaluate((n) => n.scrollTop),
    scrollBefore,
  );
  await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
  await until(
    () =>
      surface
        .locator('.xterm-accessibility-tree')
        .count()
        .then((n) => n === 1),
    'AUTO dynamic reenable',
  );
  assert.equal(await input.evaluate((n, old) => n === old, inputNode), true);
  assert.equal((await query('terminal', 'list'))[0].pid, first.pid);
  await panel
    .getByRole('button', { name: 'copy complete output', exact: true })
    .click();
  const copied = await app.evaluate(async ({ clipboard }) =>
    clipboard.readText(),
  );
  for (let n = 1; n <= 600; n++)
    assert.equal(
      copied.split('AX_LINE_' + String(n).padStart(4, '0') + '_中文').length -
        1,
      1,
    );
  await writeFile(join(output, '600-copy.txt'), copied);
  await panel
    .locator('.native-terminal-toolbar')
    .getByRole('button', { name: 'new terminal', exact: true })
    .click();
  await until(
    async () => (await query('terminal', 'list')).length === 2,
    'second actual PTY',
  );
  await surface.waitFor({ state: 'hidden' });
  const hiddenAX = await cdp.send('Accessibility.getFullAXTree');
  await writeFile(
    join(output, 'hidden-pane-ax-tree.json'),
    JSON.stringify(hiddenAX, null, 2),
  );
  const hiddenById = new Map(hiddenAX.nodes.map((n) => [n.nodeId, n]));
  const hiddenRowText = (n) =>
    [
      n.name?.value ?? '',
      ...(n.childIds ?? []).map((id) =>
        hiddenRowText(hiddenById.get(id) ?? {}),
      ),
    ].join(' ');
  assert(
    !hiddenAX.nodes
      .filter((n) => n.role?.value === 'listitem')
      .some((n) => hiddenRowText(n).includes('AX_LINE_')),
    'hidden terminal output is absent from actual AX listitems (search value remains accessible)',
  );
  await panel
    .locator(`[role="tab"][aria-controls="terminal-${terminalId}"]`)
    .click();
  assert.equal(await input.evaluate((n, old) => n === old, inputNode), true);
  report.checks.push(
    'trusted native true/false/true updates existing xterm without recreating DOM or PID; actual AX listitems/text; selection and scroll retained; all 600 CJK lines copied once',
  );
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const choices = page.getByRole('group', {
    name: 'terminal screen reader',
    exact: true,
  });
  await choices.getByRole('button', { name: 'always on', exact: true }).click();
  assert.equal(
    await choices
      .getByRole('button', { name: 'always on', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(false));
  await page
    .locator(`[data-row-key="recent:${sessionId}"] .session-link`)
    .click();
  const panelAgain = await openNativeTerminalInspector(page);
  await until(
    () =>
      panelAgain
        .locator(
          '.native-terminal-surface:not([hidden]) .xterm-accessibility-tree',
        )
        .count()
        .then((n) => n === 1),
    'ALWAYS ON retains AX despite trusted false',
  );
  assert.equal((await query('terminal', 'list'))[0].pid, first.pid);
  assert.equal(
    await input.evaluate((n, old) => n === old, inputNode),
    true,
    'Settings mode change preserves existing terminal DOM',
  );
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page
    .getByRole('group', { name: 'terminal screen reader', exact: true })
    .getByRole('button', { name: 'follow system', exact: true })
    .click();
  await page.screenshot({ path: join(output, 'original-settings.png') });
  report.checks.push(
    'original Settings ALWAYS ON override and AUTO selection use original controls; terminal process preserved across original routes',
  );
  report.status = 'passed';
  console.log(
    'native terminal accessibility AUTO/ALWAYS, actual AX, keyboard/search/selection/600copy/PID PASS',
  );
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app && clipboard)
    await restoreNativeClipboardWithRecovery(app, clipboard, {
      retryPath: join(output, 'retry-clipboard-restore'),
      onFailure: async (e) =>
        writeFile(join(output, 'clipboard-restore-error.txt'), String(e)).catch(
          (error) => {
            console.error(
              'could not save clipboard recovery diagnostics',
              error,
            );
          },
        ),
    });
  if (app && terminalId && page)
    await page
      .evaluate(
        async ({ sessionId, id }) =>
          window.circleDesktop.runtimeCommand({
            id: crypto.randomUUID(),
            name: 'workspace-service',
            sessionId,
            payload: { service: 'terminal', method: 'close', params: { id } },
          }),
        { sessionId, id: terminalId },
      )
      .catch(() => {});
  if (clipboard) report.clipboardRestored = true;
  await app?.close();
  report.applicationClosed = true;
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(report, null, 2),
  );
}
