// One serialized native app only. Every mutation below is a visible GUI action;
// the supplied query bridge observes actual debugger/PTY effects.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { patience } from './patience.mjs';
const program = 'native-debug-interaction.cjs';
const marker = '.circle-native-debug-interaction.json';
const source = [
  "'use strict';",
  "const readline = require('node:readline');",
  'let value = 4;',
  'function inner(input) {',
  '  let doubled = input * 2;',
  '  return doubled;',
  '}',
  'function outer(input) {',
  '  const result = inner(input);',
  '  return result + 1;',
  '}',
  'let answer = outer(value);',
  "console.log('NATIVE_DEBUG_ANSWER:' + answer);",
  'const reader = readline.createInterface({ input: process.stdin });',
  "reader.on('line', (line) => console.log('NATIVE_DEBUG_STDIN:' + line));",
  "console.log('NATIVE_DEBUG_READY');",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');
export async function createNativeDebugFixture(workspace) {
  await mkdir(workspace, { recursive: true });
  for (const path of [program, marker]) {
    try {
      await access(join(workspace, path));
      throw Error(`debug fixture already exists: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeFile(join(workspace, program), source);
  await writeFile(
    join(workspace, marker),
    JSON.stringify({ version: 1, program }),
  );
  return { program, breakpoint: 12 };
}
async function portIsClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(Error('inspector TCP probe timed out'));
    });
  });
}
/** Uses the existing Inspector and returns from the main file viewer first. */
export async function openNativeDebugInspector(
  page,
  kind = 'activity',
  tab = 'debug',
) {
  const closeFile = page.getByRole('button', {
    name: 'close file',
    exact: true,
  });
  if (await closeFile.isVisible()) await closeFile.click();
  const toggle = page.getByRole('button', {
    name: `${kind} panel`,
    exact: true,
  });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click();
  await page.locator(`#inspector-${kind}-tab-${tab}`).click();
  await page.locator(`#inspector-${kind}-${tab}`).waitFor({ state: 'visible' });
}

export async function runNativeDebugJourney({
  page,
  workspace,
  sessionId,
  query,
  until,
  output,
  screenshot,
}) {
  assert.equal(await readFile(join(workspace, program), 'utf8'), source);
  const ownership = JSON.parse(await readFile(join(workspace, marker), 'utf8'));
  assert.deepEqual(ownership, { version: 1, program });
  const report = {
    sessionId,
    program,
    checks: [],
    startedAt: new Date().toISOString(),
  };
  const wait =
    until ??
    (async (predicate, label) => {
      const deadline = Date.now() + patience(15000);
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await page.waitForTimeout(30);
      }
      throw Error(`native debug timed out: ${label}`);
    });
  const observe =
    query ??
    ((service, method, params = {}) =>
      page.evaluate(
        async (input) => {
          const reply = await window.circleDesktop.runtimeCommand({
            id: crypto.randomUUID(),
            name: 'workspace-service',
            sessionId: input.sessionId,
            payload: {
              service: input.service,
              method: input.method,
              params: input.params,
            },
          });
          if (!reply.ok) throw Error(reply.error);
          return reply.data;
        },
        { sessionId, service, method, params },
      ));
  const capture = async (name) => {
    if (screenshot) await screenshot(name);
    else if (output) {
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: join(output, `${name}.png`) });
    }
  };
  const showDebug = () => openNativeDebugInspector(page);
  const panel = page.locator('.debug-panel');
  const button = (name) => panel.getByRole('button', { name, exact: true });
  const stack = () => observe('debug', 'stackTrace');
  let launched = false;
  let terminal, inspectorPort;
  try {
    const files = page.getByRole('button', {
      name: 'files panel',
      exact: true,
    });
    if ((await files.getAttribute('aria-pressed')) !== 'true')
      await files.click();
    await page
      .locator('.file-tree')
      .getByRole('button', { name: program, exact: true })
      .click();
    await page.getByRole('button', { name: 'debug file', exact: true }).click();
    await wait(
      async () =>
        (await panel
          .getByLabel('program path', { exact: true })
          .inputValue()) === program,
      'source prepared in original debug panel',
    );
    const previous = await observe('debug', 'snapshot');
    if (!['idle', 'stopped', 'failed'].includes(previous.status))
      throw Error('finish prior debug journey before starting this helper');
    const beforeTerminals = new Set(
      (await observe('terminal', 'list')).map((item) => item.id),
    );
    report.checks.push(
      'source file prepares original debugger without launching',
    );
    const options = panel.locator('.debug-launch-options');
    if ((await options.getAttribute('open')) === null)
      await options.locator('summary').click();
    await panel
      .getByRole('checkbox', { name: 'pause at entry', exact: true })
      .uncheck();
    // The preceding literal-argv phase may leave draft rows. Remove them visibly.
    while (
      await panel.getByRole('button', { name: /^remove argument / }).count()
    )
      await panel
        .getByRole('button', { name: /^remove argument / })
        .first()
        .click();
    const breakpoints = panel.locator('details.debug-run');
    if ((await breakpoints.getAttribute('open')) === null)
      await breakpoints.locator('summary').click();
    await panel.getByLabel('breakpoint line', { exact: true }).fill('12');
    await button('set breakpoint').click();
    await button('launch').click();
    launched = true;
    await wait(
      async () => (await observe('debug', 'snapshot')).status === 'paused',
      'new fixture breakpoint',
    );
    await wait(
      async () => (await stack()).stackFrames?.[0]?.line === 12,
      'actual top-level call site',
    );
    const evaluateGUI = async (expression, expected) => {
      await panel
        .getByLabel('debug expression', { exact: true })
        .fill(expression);
      await button('evaluate').click();
      await wait(
        async () =>
          (await panel.locator('form output').innerText()).trim() === expected,
        `GUI evaluate ${expression}`,
      );
    };
    await evaluateGUI('value = 7', '7');
    await evaluateGUI('value', '7');
    report.checks.push({ name: 'GUI modifies one live variable', value: 7 });
    await panel
      .getByLabel('debug expression', { exact: true })
      .fill('process.debugPort');
    await button('evaluate').click();
    await wait(
      async () =>
        /^\d+$/.test((await panel.locator('form output').innerText()).trim()) &&
        Number((await panel.locator('form output').innerText()).trim()) > 1024,
      'actual inspector port from GUI',
    );
    inspectorPort = Number(
      (await panel.locator('form output').innerText()).trim(),
    );
    const step = async (name, predicate, label) => {
      const before = (await observe('debug', 'snapshot')).pauseId;
      await button(name).click();
      await wait(async () => {
        const state = await observe('debug', 'snapshot');
        if (state.status !== 'paused' || state.pauseId === before) return false;
        return predicate((await stack()).stackFrames?.[0]);
      }, label);
      const frame = (await stack()).stackFrames[0];
      report.checks.push({
        name: label,
        frame: {
          name: frame.name,
          line: frame.line,
          source: frame.source?.path,
        },
      });
    };
    await step(
      'step into',
      (frame) => frame?.name === 'outer' && frame.line === 9,
      'step into outer',
    );
    await step(
      'step into',
      (frame) => frame?.name === 'inner' && frame.line === 5,
      'step into inner',
    );
    await step(
      'step over',
      (frame) => frame?.name === 'inner' && frame.line === 6,
      'step over actual multiplication',
    );
    await step(
      'step out',
      (frame) => frame?.name === 'outer' && frame.line === 10,
      'step out to outer caller',
    );
    await step(
      'step out',
      (frame) =>
        frame &&
        !['inner', 'outer'].includes(frame.name) &&
        [12, 13].includes(frame.line),
      'step out to top-level caller',
    );
    await capture('debug-variable-and-single-stepping');
    await button('continue').click();
    await wait(async () => {
      terminal = (await observe('terminal', 'list')).find(
        (item) => !beforeTerminals.has(item.id) && item.sessionId === sessionId,
      );
      if (!terminal) return false;
      return JSON.stringify(
        await observe('terminal', 'replay', { id: terminal.id, limit: 512 }),
      ).includes('NATIVE_DEBUG_READY');
    }, 'owner debug terminal received real output');
    let replay = JSON.stringify(
      await observe('terminal', 'replay', { id: terminal.id, limit: 512 }),
    );
    assert.ok(
      replay.includes('NATIVE_DEBUG_ANSWER:15'),
      'changed live value affects actual program output',
    );
    await openNativeDebugInspector(page, 'terminal', 'terminal');
    await page
      .locator(
        `.native-terminal-tabs [aria-controls="terminal-${terminal.id}"]`,
      )
      .click();
    const terminalInput = page
      .locator(`#terminal-${terminal.id}`)
      .getByLabel('terminal input', { exact: true });
    await terminalInput.focus();
    await page.keyboard.type('debug-human-input');
    await page.keyboard.press('Enter');
    await wait(
      async () =>
        JSON.stringify(
          await observe('terminal', 'replay', { id: terminal.id, limit: 512 }),
        ).includes('NATIVE_DEBUG_STDIN:debug-human-input'),
      'debuggee reads actual GUI stdin',
    );
    report.checks.push({
      name: 'owner PTY stdin reaches debuggee',
      id: terminal.id,
      pid: terminal.pid,
    });
    await capture('debug-owner-terminal-stdin');
    await showDebug();
    await button('stop').click();
    await wait(
      async () => (await observe('debug', 'snapshot')).status === 'stopped',
      'debug state stopped',
    );
    await wait(async () => {
      const current = (await observe('terminal', 'list')).find(
        (item) => item.id === terminal.id,
      );
      return !current || ['exited', 'failed'].includes(current.status);
    }, 'owned PTY exited');
    if (terminal.pid) {
      await wait(async () => {
        try {
          process.kill(terminal.pid, 0);
          return false;
        } catch (error) {
          if (error.code === 'ESRCH') return true;
          throw error;
        }
      }, 'actual owned PID exit');
    }
    await wait(
      () => portIsClosed(inspectorPort),
      'inspector TCP port released',
    );
    report.checks.push({
      name: 'stop releases owned PID and actual inspector port',
      pid: terminal.pid,
      port: inspectorPort,
    });
    await capture('debug-stopped-and-port-released');
    report.passed = true;
    return report;
  } catch (error) {
    report.passed = false;
    report.error = String(error);
    report.debugSnapshot = await observe('debug', 'snapshot').catch(
      (failure) => ({ error: String(failure) }),
    );
    report.actualFixture = await readFile(
      join(workspace, program),
      'utf8',
    ).catch(String);
    report.terminals = await observe('terminal', 'list').catch((failure) => ({
      error: String(failure),
    }));
    await capture('debug-interaction-failure').catch(() => {});
    throw error;
  } finally {
    if (launched) {
      await showDebug().catch(() => {});
      if (
        await button('stop')
          .isEnabled()
          .catch(() => false)
      )
        await button('stop')
          .click()
          .catch(() => {});
    }
    report.finishedAt = new Date().toISOString();
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, 'native-debug-interaction-receipt.json'),
        JSON.stringify(report, null, 2),
      );
    }
  }
}
