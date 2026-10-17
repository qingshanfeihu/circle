import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { readViewport, setViewport } from './helpers/viewport.mjs';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/interface');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-interface-'));
const note = join(temp, 'import.md');
await writeFile(note, '# imported by native host\nno execution');
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    files: [note],
    exportPath: join(temp, 'export.md'),
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  chromiumSandbox: true,
  executablePath: process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
  args: [appPath],
  cwd: root,
  env,
});
const page = await application.firstWindow();
page.setDefaultTimeout(patience(10000));
const errors = [];
observePage(page, errors);
await page
  .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
  .waitFor({ timeout: 30000 });
let viewportSizing;
if (process.env.CIRCLE_DESKTOP_CHECK_NARROW) {
  await page.waitForURL(/^circle:\/\/workbench/);
  viewportSizing = await setViewport(application, page, {
    width: 1024,
    height: 650,
  });
  await page.reload();
}
const checks = [];
const viewport = await readViewport(page);
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
  await page.evaluate(() =>
    window.addEventListener('pagehide', () => localStorage.clear(), {
      once: true,
    }),
  );
  await page.reload();
  await page.evaluate(() => {
    location.hash = '/session/session1';
  });
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
}
const homeMenuLayouts = [];
async function checkHomeMenu(name, menu) {
  if (name === 'project')
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('aria-label') ===
        'search projects',
    );
  await menu.getByRole('menuitem').first().focus();
  await page.keyboard.press('End');
  const { sample } = await waitDesktopReady(
    () =>
      menu.evaluate((content) => {
        const rect = content.getBoundingClientRect();
        const items = content.querySelectorAll('[role="menuitem"]');
        const last = items[items.length - 1];
        const item = last.getBoundingClientRect();
        const style = getComputedStyle(content);
        const clip = {
          left: rect.left + parseFloat(style.borderLeftWidth),
          right: rect.right - parseFloat(style.borderRightWidth),
          top: rect.top + parseFloat(style.borderTopWidth),
          bottom: rect.bottom - parseFloat(style.borderBottomWidth),
        };
        const inside =
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight;
        return {
          theme: document.documentElement.dataset.theme,
          side: content.getAttribute('data-side'),
          viewport: {
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          },
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          availableHeight: style.getPropertyValue(
            '--radix-dropdown-menu-content-available-height',
          ),
          availableWidth: style.getPropertyValue(
            '--radix-dropdown-menu-content-available-width',
          ),
          maxHeight: style.maxHeight,
          scrollHeight: content.scrollHeight,
          clientHeight: content.clientHeight,
          scrollTop: content.scrollTop,
          lastText: last.textContent,
          lastRect: {
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
          },
          clip,
          lastFocused: document.activeElement === last,
          lastFullyVisible:
            item.top >= clip.top &&
            item.bottom <= clip.bottom &&
            item.left >= clip.left &&
            item.right <= clip.right,
          inside,
          positive: rect.width > 0 && rect.height > 0,
        };
      }),
    (sample) =>
      sample.positive &&
      sample.inside &&
      sample.lastFocused &&
      sample.lastFullyVisible,
    {
      label: `home ${name} fits and its last item is reachable`,
      timeoutMs: 10000,
    },
  );
  assert.equal(sample.side, 'bottom');
  assert.equal(sample.positive, true);
  assert.equal(sample.inside, true);
  assert.equal(sample.lastFocused, true);
  assert.equal(sample.lastFullyVisible, true);
  homeMenuLayouts.push({ name, ...sample });
  await writeFile(
    join(output, 'home-menu-layouts.json'),
    JSON.stringify(homeMenuLayouts, null, 2),
  );
  await page.screenshot({
    path: join(output, `home-menu-${sample.theme}-${name}.png`),
  });
}
async function homeTheme(theme) {
  await route('/page/settings');
  await page.getByRole('button', { name: theme, exact: true }).click();
  await page.waitForFunction(
    (value) => document.documentElement.dataset.theme === value,
    theme,
  );
  await route('/home');
  await page
    .getByRole('heading', {
      name: 'what should we build in orbit-api?',
      exact: true,
    })
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
  variables: ['heading', 'settings'],
  secrets: ['heading', 'settings'],
  mcp: ['heading', 'mcp servers'],
  extensions: ['heading', 'extensions'],
  approvals: ['heading', 'approvals'],
  jobs: ['tab', 'activity'],
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
  await application.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed(),
    );
    // Pointer assertions use the renderer's controlled input, not unrelated desktop movement.
    window?.setIgnoreMouseEvents(true);
    window?.focus();
  });
  clipboard = await preserveNativeClipboard(application);
  const sections = page.locator('.project-list > .project');
  await sections
    .nth(0)
    .getByRole('button', { name: 'recent', exact: true })
    .waitFor();
  const activeLinks = page.locator('.sidebar a.session-link.active');
  const hrefs = await activeLinks.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('href')),
  );
  assert.ok(hrefs.length >= 2);
  assert.equal(new Set(hrefs).size, 1);
  const activeProject = sections
    .filter({ has: page.locator('a.session-link.active') })
    .nth(1);
  const projectName = await activeProject.locator('.project-name').innerText();
  const recentActive = sections.nth(0).locator('a.session-link.active');
  assert.equal((await recentActive.innerText()).includes(projectName), false);
  const recentRow = sections.nth(0).locator('.session-row', {
    has: page.locator('a.session-link.active'),
  });
  await recentActive.hover();
  const hover = page.locator('.session-hover');
  await hover.waitFor();
  assert.match(await hover.innerText(), new RegExp(projectName));
  assert.match(await hover.innerText(), /\btoday\b/);
  assert.doesNotMatch(await hover.innerText(), /updated/);
  const menu = recentRow.getByRole('button', {
    name: 'session actions for Fix the reconnect race',
    exact: true,
  });
  await page.waitForFunction(() => {
    const card = document.querySelector('.session-hover');
    const button = document
      .querySelector(
        '.project-list > .project .session-row a.session-link.active',
      )
      ?.parentElement?.querySelector('button');
    if (!card || !button) return false;
    return (
      card.getBoundingClientRect().x >= button.getBoundingClientRect().right - 1
    );
  });
  const flickered = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 350) {
      if (!document.querySelector('.session-hover')) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  });
  assert.equal(flickered, false);
  await recentActive.click();
  await hover.waitFor();
  await recentActive.click();
  await hover.waitFor();
  checks.push('clicking a row keeps its hover card while the pointer stays');
  await menu.click();
  await page
    .getByRole('menuitem', { name: 'rename session', exact: true })
    .waitFor();
  await page.screenshot({
    path: join(output, 'session-menu-open.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.reload();
  await page.evaluate(() => {
    location.hash = '/session/session1';
  });
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  // Establish a fresh outside→row pointer transition after the document reload;
  // the previous page/menu may have left the controlled pointer over this row.
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .hover();
  await recentActive.hover();
  await hover.waitFor();
  const renameCommand = page.getByRole('textbox', {
    name: 'message',
    exact: true,
  });
  await renameCommand.fill('/name ');
  await hover.waitFor();
  await renameCommand.press('Enter');
  await page
    .getByRole('dialog', { name: 'rename session', exact: true })
    .waitFor();
  assert.equal(await hover.count(), 0);
  await page.keyboard.press('Escape');
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .hover();
  assert.equal(await hover.count(), 0);
  await recentActive.focus();
  await hover.waitFor();
  assert.deepEqual(
    await page
      .locator('.sidebar a.session-link')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.tabIndex === 0)
          .map((node) => node.textContent.trim()),
      ),
    ['Fix the reconnect race'],
  );
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    () =>
      document.activeElement?.textContent?.includes(
        'Review the request lifecycle',
      ) ?? false,
  );
  assert.equal(
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'work without a project', exact: true })
      .count(),
    0,
  );
  await recentActive.focus();
  await page.waitForFunction(() => {
    const tips = document.querySelectorAll('.tooltip');
    const cards = document.querySelectorAll('.session-hover');
    return tips.length === 1 && cards.length === 1;
  });
  const menuTab = await page
    .locator('.sidebar button[aria-label^="session actions"]')
    .evaluateAll((nodes) => nodes.map((node) => node.tabIndex));
  assert.ok(menuTab.length > 1);
  assert.ok(menuTab.every((value) => value === -1));
  await page.keyboard.press('Tab');
  assert.equal(
    (
      await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? '',
      )
    ).startsWith('session actions'),
    false,
  );
  await recentActive.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => {
    const tips = document.querySelectorAll('.tooltip');
    return (
      document.activeElement?.getAttribute('aria-label') ===
        'session actions for Fix the reconnect race' &&
      tips.length === 1 &&
      !document.querySelector('.session-hover')
    );
  });
  await page.keyboard.press('ArrowLeft');
  await recentRow.hover();
  await page.waitForFunction(() => document.querySelector('.session-hover'));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.tooltip')];
    return (
      document.activeElement?.getAttribute('aria-label') ===
        'session actions for Fix the reconnect race' &&
      tips.length === 1 &&
      !tips[0].classList.contains('session-hover')
    );
  });
  checks.push('right arrow replaces the hover card with the menu tip');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('session-link'),
  );
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menuitem', { name: 'rename session', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  checks.push(
    'the open session stays highlighted in recent and in its project',
  );
  checks.push(
    'a recent row shows only its title, and hover or focus shows the project and time',
  );
  checks.push(
    'a recent hover card sits beside the row and its menu opens on the first click',
  );
  checks.push('arrow keys move between sidebar session rows');
  checks.push(
    'tab leaves the session list and a row menu opens from the keyboard without a second tip',
  );
  await renameCommand.fill('x');
  await page.waitForFunction(() =>
    localStorage.getItem('circle.workbench.preview.v1'),
  );
  await renameCommand.fill('');
  await page.evaluate(() => {
    const key = 'circle.workbench.preview.v1';
    const saved = JSON.parse(localStorage.getItem(key));
    const sample = saved.sessions.find((row) => row.id === 'session1');
    for (let index = 0; index < 4; index += 1) {
      saved.sessions.push({
        ...sample,
        id: 'extra' + index,
        title: 'Extra recent ' + index,
        pinned: false,
        messages: sample.messages.map((message, messageIndex) => ({
          ...message,
          id: 'extra' + index + '-' + messageIndex,
        })),
      });
    }
    // Seed after the mounted conversation flushes its state on pagehide.
    window.addEventListener(
      'pagehide',
      () => localStorage.setItem(key, JSON.stringify(saved)),
      { once: true },
    );
  });
  await page.reload();
  await page.evaluate(() => {
    location.hash = '/session/session1';
  });
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  assert.equal(await sections.nth(0).locator('a.session-link').count(), 5);
  await sections
    .nth(0)
    .getByRole('button', { name: 'show 2 more', exact: true })
    .waitFor();
  checks.push('recent shows five sessions before show more');
  const recentRows = sections.nth(0).locator('.session-row');
  await recentRows.nth(0).locator('a.session-link').focus();
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menuitem', { name: 'rename session', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.tooltip')];
    return (
      tips.length === 1 &&
      !tips[0].classList.contains('session-hover') &&
      document.activeElement?.getAttribute('aria-label') ===
        'session actions for Extra recent 0'
    );
  });
  const away = page.getByRole('textbox', { name: 'message', exact: true });
  const expectCard = async (row) => {
    await away.hover();
    await row.hover();
    await page.waitForFunction(() => {
      const tips = [...document.querySelectorAll('.tooltip')];
      return tips.length === 1 && tips[0].classList.contains('session-hover');
    });
  };
  for (const index of [1, 2, 3, 4]) await expectCard(recentRows.nth(index));
  const projectRow = (project, title) =>
    page
      .locator('.project-list > .project')
      .filter({ has: page.getByRole('button', { name: project, exact: true }) })
      .locator('.session-row', { hasText: title });
  await expectCard(projectRow('orbit-api', 'Review the request lifecycle'));
  await expectCard(projectRow('docs-site', 'Tighten the setup guide'));
  await page.keyboard.press('ArrowLeft');
  for (const index of [0, 1, 2, 3, 4]) await expectCard(recentRows.nth(index));
  await expectCard(projectRow('orbit-api', 'Review the request lifecycle'));
  await expectCard(projectRow('docs-site', 'Tighten the setup guide'));
  checks.push(
    'every recent and project row shows its card, including after a dismissed tip',
  );
  await projectRow('orbit-api', 'Fix the reconnect race')
    .locator('a.session-link')
    .click();
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menuitem', { name: 'rename session', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  checks.push('shift+f10 opens the menu on the first press after a click');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMaximized()) window.unmaximize();
  });
  const contentSize = await readViewport(page);
  const restored = {
    width: Math.round(contentSize.width),
    height: Math.round(contentSize.height),
  };
  // The window will not shrink below its 560px minimum.
  await setViewport(application, page, {
    width: restored.width,
    height: Math.min(restored.height, 640),
  });
  const list = page.locator('.project-list');
  const beforeScroll = await list.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  assert.ok(beforeScroll.scrollHeight > beforeScroll.clientHeight);
  await projectRow('orbit-api', 'Fix the reconnect race')
    .locator('a.session-link')
    .focus();
  await expectCard(projectRow('orbit-api', 'Fix the reconnect race'));
  // A keyboard-only step: the pointer rests away from the rows, or the row under
  // it keeps its hover card open, as it should.
  await page.mouse.move(700, 400);
  await recentRows.nth(0).locator('a.session-link').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.tooltip')];
    return tips.length === 1 && !tips[0].classList.contains('session-hover');
  });
  await recentRows.nth(0).locator('a.session-link').hover();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(() => {
    const node = document.querySelector('.project-list');
    return (
      node instanceof HTMLElement &&
      node.scrollTop > 0 &&
      document.querySelectorAll('.tooltip').length === 0
    );
  });
  checks.push('the sidebar list scrolls');
  checks.push('scrolling the sidebar closes a menu tip');
  await list.evaluate((node) => {
    const row = [...node.querySelectorAll('[data-row-key]')].find(
      (item) => item.dataset.rowKey === 'recent:extra3',
    );
    if (!(row instanceof HTMLElement)) return;
    node.scrollTop +=
      row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('.project-list');
    const row = node?.querySelector('[data-row-key="recent:extra3"]');
    if (!(node instanceof HTMLElement) || !(row instanceof HTMLElement))
      return false;
    return (
      Math.abs(
        row.getBoundingClientRect().top - node.getBoundingClientRect().top,
      ) < 2
    );
  });
  const anchored = await list.evaluate((node) => {
    const row = node.querySelector('[data-row-key="recent:extra3"]');
    if (!(row instanceof HTMLElement)) return null;
    return {
      delta: row.getBoundingClientRect().top - node.getBoundingClientRect().top,
      scrollTop: node.scrollTop,
    };
  });
  assert.ok(anchored);
  const still = page.getByRole('textbox', { name: 'message', exact: true });
  await still.fill('keep the sidebar still');
  await still.press('Enter');
  await page
    .locator('article.message.user', { hasText: 'keep the sidebar still' })
    .waitFor();
  const kept = await list.evaluate((node) => {
    const row = node.querySelector('[data-row-key="recent:extra3"]');
    if (!(row instanceof HTMLElement)) return null;
    return {
      delta: row.getBoundingClientRect().top - node.getBoundingClientRect().top,
      scrollTop: node.scrollTop,
    };
  });
  assert.ok(kept);
  assert.ok(Math.abs(kept.delta - anchored.delta) < 2);
  assert.ok(kept.scrollTop > anchored.scrollTop + 8);
  await setViewport(application, page, restored);
  checks.push('sending a message keeps the row at the top of the sidebar');
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
      else if (command.name === 'mode')
        assert.equal(snapshot.sessions[0].mode, 'accept-edits');
      else if (command.name === 'thinking')
        assert.equal(snapshot.sessions[0].showThinking, false);
      else if (command.name === 'details')
        await page
          .getByRole('heading', { name: 'output', exact: true })
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
        const copied = page.getByRole('status').filter({ hasText: 'copied' });
        await copied.waitFor();
        assert.match(
          await application.evaluate(({ clipboard }) => clipboard.readText()),
          /sample data/,
        );
        const toastBox = await copied.boundingBox();
        const inputBox = await page
          .getByRole('textbox', { name: 'message', exact: true })
          .boundingBox();
        assert(
          toastBox &&
            inputBox &&
            (toastBox.y + toastBox.height <= inputBox.y ||
              toastBox.y >= inputBox.y + inputBox.height ||
              toastBox.x + toastBox.width <= inputBox.x ||
              toastBox.x >= inputBox.x + inputBox.width),
          'copy notice leaves the composer clear',
        );
        await copied.waitFor({ state: 'hidden' });
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
  // A long plan shows whole rows, with the step under way in sight
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  await message.fill('x');
  await page.waitForFunction(() =>
    localStorage.getItem('circle.workbench.preview.v1'),
  );
  await message.fill('');
  await page.evaluate(() => {
    const key = 'circle.workbench.preview.v1';
    const saved = JSON.parse(localStorage.getItem(key));
    saved.sessions.find((row) => row.id === 'session1').todos = Array.from(
      { length: 7 },
      (_, index) => ({
        id: 'long' + index,
        text: 'Step ' + (index + 1),
        status: index < 5 ? 'completed' : index === 5 ? 'running' : 'pending',
      }),
    );
    window.addEventListener(
      'pagehide',
      () => localStorage.setItem(key, JSON.stringify(saved)),
      { once: true },
    );
  });
  await page.reload();
  await page.locator('.plan-items .running').waitFor();
  const plan = await page.evaluate(() => {
    const list = document.querySelector('.plan-items');
    // The list scrolls exactly its rows: whatever shows between its edges is a row
    const box = list.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      rows: [...list.children].map((row) => {
        const rect = row.getBoundingClientRect();
        return { status: row.className, top: rect.top, bottom: rect.bottom };
      }),
    };
  });
  const shown = plan.rows.filter(
    (row) => row.bottom > plan.top + 1 && row.top < plan.bottom - 1,
  );
  for (const row of shown)
    assert(
      row.top >= plan.top - 1 && row.bottom <= plan.bottom + 1,
      `a plan row is cut: ${JSON.stringify({ row, plan: [plan.top, plan.bottom] })}`,
    );
  assert(shown.some((row) => row.status === 'running'));
  assert(shown.length >= 3 && shown.length < 7, `rows shown: ${shown.length}`);
  checks.push(
    'a long plan shows whole rows and keeps the step under way in sight',
  );
  await reset();
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
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  const decision = await state();
  assert.equal(decision.interactions[0].status, 'recorded');
  assert.equal(decision.jobs[0].state, 'running');
  checks.push('approval records do not fabricate execution success');
  await reset();
  assert.equal(
    await page.getByRole('link', { name: 'knowledge', exact: true }).count(),
    0,
  );
  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  // Three plain components, GitHub, and the hub interface with the four platform
  // objects, all paired with a runtime extension the preview does not have, so off.
  assert.equal(await page.getByRole('checkbox').count(), 9);
  // Each switch is named by the interface's shown title.
  for (const id of ['GitHub', 'knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page
        .getByRole('checkbox', { name: `enable ${id} interface`, exact: true })
        .isChecked(),
      false,
    );
  assert.equal(
    await page
      .getByRole('checkbox', {
        name: 'enable hub interface',
        exact: true,
      })
      .isChecked(),
    false,
  );
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('circle.workbench.platform-preview.v1'),
    ),
    null,
  );
  checks.push(
    'the Circle interface excludes the four deferred platform objects',
  );
  await reset();
  await route('/page/settings');
  // The default workspace section shows the fixture folder; the native picker
  // exists only in the live app, never in the frontend preview.
  const defaultWorkspace = page.locator('section.settings-block', {
    has: page.getByRole('heading', {
      name: 'default workspace',
      exact: true,
    }),
  });
  await defaultWorkspace.waitFor();
  assert.match(await defaultWorkspace.innerText(), /\/workspace\/orbit-api/);
  assert.equal(
    await defaultWorkspace
      .getByRole('button', { name: 'change…', exact: true })
      .count(),
    0,
  );
  checks.push(
    'the preview settings name the default workspace without a picker',
  );
  // Key preferences are one row per action: change…, then the new key.
  const modelsKey = page.locator('.keybinding-list .setting-row', {
    has: page.getByText('models', { exact: true }),
  });
  await modelsKey.getByRole('button', { name: 'change…', exact: true }).click();
  await modelsKey.getByText('press the new key', { exact: true }).waitFor();
  await page.keyboard.press('F3');
  await modelsKey.getByText('f3', { exact: true }).waitFor();
  await modelsKey
    .getByRole('button', { name: 'reset key', exact: true })
    .waitFor();
  await route('/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).press('F3');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  checks.push('custom key binding invokes its configured action');
  await reset();
  const beforeNew = await state();
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in orbit-api?',
      exact: true,
    })
    .waitFor();
  assert.equal(new URL(page.url()).hash, '#/home');
  // Sample data stays in memory until a view writes it. Home must not add a row.
  const afterNew = await state();
  assert.equal(afterNew?.sessions.length ?? 3, beforeNew?.sessions.length ?? 3);
  assert.equal(
    afterNew?.activeSessionId ?? 'session1',
    beforeNew?.activeSessionId ?? 'session1',
  );
  checks.push('new session opens home without creating an empty session');
  const thinking = page.getByRole('button', {
    name: 'thinking depth',
    exact: true,
  });
  await thinking.waitFor();
  await page
    .getByRole('button', { name: 'approval mode', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'model', exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'attach files', exact: true })
    .waitFor();
  assert.match(await thinking.innerText(), /^high\b/);
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push('new session focuses the composer when home is already open');
  const homeOriginalViewport = await readViewport(page);
  const homeMenuViewport = await setViewport(application, page, {
    width: 1024,
    height: 684,
  });
  await writeFile(
    join(output, 'home-menu-viewport.json'),
    JSON.stringify(homeMenuViewport, null, 2),
  );
  await homeTheme('light');
  await page
    .getByRole('button', { name: 'approval mode', exact: true })
    .click();
  const modeMenu = page.locator('.mode-menu');
  await modeMenu.waitFor();
  assert.equal(await modeMenu.getAttribute('data-side'), 'bottom');
  await checkHomeMenu('mode', modeMenu);
  await page.getByRole('menuitem', { name: /^manual/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  await thinking.click();
  const effortMenu = page.locator('.dropdown.footbar-menu');
  await effortMenu.waitFor();
  assert.equal(await effortMenu.getAttribute('data-side'), 'bottom');
  await checkHomeMenu('effort', effortMenu);
  await page.getByRole('menuitem', { name: 'minimal', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push(
    'home menus open downward and escape returns focus to the composer',
  );
  await page.getByRole('button', { name: 'model', exact: true }).click();
  const homeModelMenu = page.locator('.dropdown.footbar-menu');
  await homeModelMenu.waitFor();
  await checkHomeMenu('model', homeModelMenu);
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  await thinking.click();
  await page.getByRole('menuitem', { name: 'very high', exact: true }).click();
  assert.match(await thinking.innerText(), /very high/);
  checks.push('home composer has the session controls');
  const projectButton = page.getByRole('button', {
    name: 'choose a project',
    exact: true,
  });
  await projectButton.click();
  const projectMenu = page.locator('.project-menu');
  await projectMenu.waitFor();
  assert.equal(await projectMenu.getAttribute('data-side'), 'bottom');
  await checkHomeMenu('project', projectMenu);
  await page
    .getByRole('textbox', { name: 'search projects', exact: true })
    .fill('zzznomatch');
  await projectMenu
    .getByRole('status')
    .getByText('no matching projects')
    .waitFor();
  await projectMenu
    .getByRole('menuitem', { name: 'open folder', exact: true })
    .waitFor();
  await projectMenu
    .getByRole('menuitem', { name: 'no project', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push(
    'a project search with no matches keeps open folder and no project',
  );
  await homeTheme('dark');
  for (const [name, label, selector] of [
    ['mode', 'approval mode', '.mode-menu'],
    ['effort', 'thinking depth', '.dropdown.footbar-menu'],
    ['model', 'model', '.dropdown.footbar-menu'],
    ['project', 'choose a project', '.project-menu'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const opened = page.locator(selector);
    await opened.waitFor();
    await checkHomeMenu(name, opened);
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'message',
    );
  }
  await homeTheme('light');
  await setViewport(application, page, homeOriginalViewport);
  const heldDraft = page.getByRole('textbox', { name: 'message', exact: true });
  await heldDraft.fill('hold this');
  await projectButton.click();
  await page.getByRole('menuitem', { name: 'docs-site', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in docs-site?',
      exact: true,
    })
    .waitFor();
  await route('/session/session1');
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in docs-site?',
      exact: true,
    })
    .waitFor();
  assert.equal(await heldDraft.inputValue(), 'hold this');
  assert.match(await thinking.innerText(), /very high/);
  checks.push(
    'leaving home and opening new session keeps the draft, project and thinking depth',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  const trustDialog = page.getByRole('dialog', {
    name: 'workspace trust',
    exact: true,
  });
  await trustDialog.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.textContent?.includes('trust in preview') ??
      false,
  );
  await trustDialog
    .getByRole('button', { name: 'trust in preview', exact: true })
    .click();
  await page.getByRole('heading', { name: 'hold this', exact: true }).waitFor();
  const trusted = await state();
  const trustedSession = trusted.sessions.find((session) =>
    session.messages.some((item) => item.text === 'hold this'),
  );
  const trustedWorkspace = trusted.workspaces.find(
    (item) => item.id === trustedSession.workspaceId,
  );
  assert.equal(trustedWorkspace.name, 'docs-site');
  assert.equal(trustedWorkspace.trusted, true);
  checks.push(
    'trusting a project focuses the confirm button and sends the waiting message',
  );
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('button', { name: 'choose a project', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'no project', exact: true }).click();
  const homeMessage = page.getByRole('textbox', {
    name: 'message',
    exact: true,
  });
  await homeMessage.click();
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    ),
    'message',
  );
  await page.keyboard.type('focused');
  assert.equal(await homeMessage.inputValue(), 'focused');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'search projects', exact: true })
      .count(),
    0,
  );
  checks.push('choosing no project returns focus to the composer');
  await page.getByRole('button', { name: 'search', exact: true }).click();
  const searchDialog = page.getByRole('dialog', {
    name: 'search',
    exact: true,
  });
  await searchDialog.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'global search',
  );
  await page.keyboard.type('buffer');
  // The dialog hides the composer from the accessibility tree. Read it directly.
  const composerValue = () =>
    page.evaluate(
      () =>
        document.querySelector('textarea[aria-label="message"]')?.value ?? '',
    );
  assert.equal(await composerValue(), 'focused');
  await searchDialog.getByText('pending buffer').waitFor();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('zzznomatch');
  await searchDialog
    .getByRole('heading', { name: 'no results', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await searchDialog.waitFor({ state: 'hidden' });
  assert.equal(await composerValue(), 'focused');
  checks.push(
    'search focuses its box, finds an assistant reply, and shows no results',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByRole('heading', { name: 'focused', exact: true }).waitFor();
  const started = await state();
  const created = started.sessions.find((session) =>
    session.messages.some((item) => item.text === 'focused'),
  );
  assert.equal(created.effort, 'xhigh');
  const workspace = started.workspaces.find(
    (item) => item.id === created.workspaceId,
  );
  assert.equal(workspace.kind, 'scratch');
  checks.push('the first message keeps the thinking depth chosen on home');
  await route('/session/session1');
  await page
    .getByRole('button', { name: 'Fix the reconnect race', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'rename', exact: true }).click();
  const renameBox = page.getByRole('textbox', {
    name: 'session name',
    exact: true,
  });
  await renameBox.waitFor();
  await page.waitForFunction(() => {
    const field = document.activeElement;
    return (
      field instanceof HTMLInputElement &&
      field.getAttribute('aria-label') === 'session name' &&
      field.selectionStart === 0 &&
      field.selectionEnd === field.value.length
    );
  });
  assert.equal(await renameBox.inputValue(), 'Fix the reconnect race');
  assert.equal(
    await renameBox.evaluate(
      (node) =>
        node.selectionStart === 0 && node.selectionEnd === node.value.length,
    ),
    true,
  );
  await page.keyboard.press('Escape');
  checks.push('rename focuses the name and selects it');
  const resetDraft = 'preview reset regression draft';
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill(resetDraft);
  await page.waitForFunction(
    (draft) =>
      localStorage.getItem('circle.workbench.preview.v1')?.includes(draft),
    resetDraft,
  );
  const resetBefore = await state();
  const previewDialog = page.getByRole('dialog', {
    name: 'frontend preview',
    exact: true,
  });
  const openPreview = async () => {
    await page
      .getByRole('button', { name: 'frontend preview', exact: true })
      .click();
    await previewDialog.waitFor();
  };
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'keep local data', exact: true })
    .click();
  assert.deepEqual(await state(), resetBefore);
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .waitFor();
  assert.equal(
    await previewDialog
      .getByRole('button', { name: 'confirm reset', exact: true })
      .count(),
    0,
  );
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  assert.deepEqual(await state(), resetBefore);
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'confirm reset', exact: true })
    .click();
  await previewDialog.waitFor({ state: 'hidden' });
  await page.waitForURL((url) => url.hash === '#/session/session1');
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  const assertResetData = async () => {
    const saved = await state();
    if (!saved) return;
    // Reading-position persistence can create a fresh cache after reset.
    // Every other field must still equal the original sample data.
    for (const session of saved.sessions) delete session.presentation;
    const { createFixtures } =
      await import('../../workbench/src/preview/fixtures.ts');
    assert.deepEqual(saved, createFixtures());
  };
  await assertResetData();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    '',
  );
  await page.reload();
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  await assertResetData();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    '',
  );
  assert.equal(new URL(page.url()).hash, '#/session/session1');
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .waitFor();
  assert.equal(
    await previewDialog
      .getByRole('button', { name: 'confirm reset', exact: true })
      .count(),
    0,
  );
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  checks.push(
    'preview reset cancel, confirmation, reopen and persisted data effects',
  );
  await reset();
  // The panel seen whole, as Codex lets a preview be: the shell offers it, a file list
  // does not, and the conversation underneath keeps what the person had typed.
  const boxes = () =>
    page.evaluate(() => {
      const at = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
          shown: node.checkVisibility(),
        };
      };
      return {
        content: at('.workspace-content'),
        panel: at('.inspector'),
        composer: at('.composer-area'),
        transcript: at('.transcript'),
        sidebar: at('.sidebar'),
        draft: document.querySelector('[aria-label="message"]').value,
      };
    });
  const wholeButton = (name) => page.getByRole('button', { name, exact: true });
  await page
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await page.locator('.inspector').waitFor();
  // A display narrower than the split (a macOS runner's screen is 1024 pixels wide) lays
  // the panel over the conversation, where the full view has nothing to fill: there it is
  // not offered, and the split checks below need a wider window.
  const besideChat = await page.evaluate(
    () => !document.querySelector('.inspector-overlay'),
  );
  if (!besideChat) {
    assert.equal(
      await wholeButton('full view').count(),
      0,
      'a window narrower than the split does not offer the full view',
    );
    checks.push(
      'a window narrower than the split does not offer the full view (the split checks need a wider display)',
    );
  } else {
    assert.equal(
      await wholeButton('full view').count(),
      1,
      'the terminal offers the full view',
    );
    await page
      .getByRole('button', { name: 'files panel', exact: true })
      .click();
    assert.equal(
      await wholeButton('full view').count(),
      0,
      'a file list does not',
    );
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    const draft = 'kept while the panel is whole';
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(draft);
    const split = await boxes();
    assert.ok(
      split.panel.width < split.content.width - 100,
      'the panel starts split: ' + JSON.stringify(split.panel),
    );
    await wholeButton('full view').click();
    const whole = await boxes();
    assert.equal(
      whole.panel.width,
      whole.content.width,
      'the panel fills the workspace: ' + JSON.stringify(whole),
    );
    // The chat and its waiting cards stay below, so the panel trades some height for the
    // width it was asking for: most of the workspace is still page.
    assert.ok(
      whole.panel.height > whole.content.height * 0.5,
      'the panel keeps the height it can: ' +
        JSON.stringify([whole.panel, whole.content]),
    );
    assert.ok(
      whole.composer.height > 40 &&
        whole.composer.height < whole.content.height / 2,
      'the chat is a bar below, not a wall: ' + JSON.stringify(whole.composer),
    );
    assert.ok(
      whole.composer.shown && whole.composer.width === whole.content.width,
      'the chat stays below it: ' + JSON.stringify(whole.composer),
    );
    assert.ok(
      whole.composer.y >= whole.panel.y + whole.panel.height - 2,
      'below, not under: ' + JSON.stringify([whole.panel, whole.composer]),
    );
    assert.ok(!whole.transcript.shown, 'only the record steps aside');
    assert.ok(whole.sidebar.shown, 'the sidebar stays beside the whole panel');
    // The session's own row in its project group: it is also listed under recent, and its
    // row menu button carries its title too.
    assert.ok(
      await page
        .locator('.sidebar .project-list > .project')
        .filter({
          has: page.getByRole('button', { name: 'orbit-api', exact: true }),
        })
        .locator('a.session-link', { hasText: 'Review the request lifecycle' })
        .isVisible(),
      'another session can still be chosen from the full view',
    );
    assert.equal(whole.draft, draft, 'the full view keeps the draft');
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill('typed in the full view');
    assert.equal(
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .inputValue(),
      'typed in the full view',
      'the input still takes what the person types',
    );
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(draft);
    await page.screenshot({ path: join(output, 'inspector-full-view.png') });
    await wholeButton('exit full view').click();
    const back = await boxes();
    assert.ok(back.panel.width < back.content.width - 100, 'the split returns');
    assert.ok(back.transcript.shown, 'the record comes back');
    assert.equal(back.draft, draft);
    await wholeButton('full view').click();
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(() => !!document.querySelector('.inspector-full')),
      false,
      'Escape leaves the full view',
    );
    checks.push(
      'the panel fills the workspace in the full view with the chat kept below it, and back',
    );
  }
  await reset();
  const narrowViewport = await setViewport(application, page, {
    width: 800,
    height: 650,
  });
  await page
    .getByRole('dialog', { name: 'inspector', exact: true })
    .waitFor({ state: 'hidden' });
  // A narrow window already lays the panel over the conversation: there is nothing
  // left to fill, so the view is not offered there.
  const terminalButton = page.getByRole('button', {
    name: 'terminal panel',
    exact: true,
  });
  if (await terminalButton.isVisible()) {
    await terminalButton.click();
    assert.equal(
      await page.getByRole('button', { name: 'full view' }).count(),
      0,
      'a narrow window offers a view it cannot fill',
    );
  }
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
        appPath,
        appPackaged: await page
          .evaluate(() => window.circleDesktop.info())
          .then((info) => info.packaged),
        sourceFiles: await sourceEvidence(),
        buildFiles: await rendererEvidence(root),
        commands: sourceCommands.length,
        viewport,
        viewportSizing,
        narrowViewport,
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
    await restoreNativeClipboard(application, clipboard);
  await application.close();
  await rm(temp, { recursive: true, force: true });
}
