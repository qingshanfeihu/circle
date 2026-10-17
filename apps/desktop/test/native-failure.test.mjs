import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from 'node:net';
import { captureFailure } from './helpers/diagnostics.mjs';
import {
  captureNativeFailure,
  cleanupNativeTest,
} from './helpers/native-failure.mjs';

function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), 'circle-failure-evidence-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function quiet(t) {
  const original = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  t.after(() => {
    console.error = original;
  });
  return logs;
}

test('failure capture writes unique primary evidence and masks screenshot and accessibility values', async (t) => {
  quiet(t);
  const output = temporary(t);
  const secret = 'synthetic-credential-never-record';
  let screenshots = 0;
  const page = {
    url: () =>
      `circle://user:${secret}@workbench/index.html?token=${secret}#${secret}`,
    pageErrors: async () => [Error('early renderer failure')],
    consoleMessages: async () => [
      {
        type: () => 'error',
        text: () =>
          `failed https://user:${secret}@example.invalid/private?token=${secret}`,
      },
      { type: () => 'error', text: () => `Authorization: Bearer ${secret}` },
      { type: () => 'error', text: () => `{"apiKey":"${secret}"}` },
    ],
    evaluate: async () => ({
      readyState: 'complete',
      rootChildren: 0,
      dialogs: 0,
      inputCount: 0,
      inputs: [],
    }),
    locator: (selector) => ({
      selector,
      ariaSnapshot: async () =>
        `- dialog "connect":\n  - textbox "api key": ${secret}`,
    }),
    screenshot: async (options) => {
      screenshots++;
      assert.equal(
        options.mask[0].selector,
        'input, textarea, [contenteditable]',
      );
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      await writeFile(options.path, 'synthetic screenshot placeholder');
    },
  };
  await captureNativeFailure(page, Error('initial fill failed'), [], output);
  await captureNativeFailure(page, Error('another attempt failed'), [], output);
  assert.equal(screenshots, 2);
  const files = readdirSync(output);
  assert.equal(
    files.filter((name) => name.endsWith('-primary.json')).length,
    2,
  );
  assert.equal(
    files.filter((name) => name.endsWith('-details.json')).length,
    2,
  );
  assert.equal(files.includes('failure.png'), false);
  const records = files
    .filter(
      (name) =>
        name.endsWith('-primary.json') || name.endsWith('-details.json'),
    )
    .map((name) => JSON.parse(readFileSync(join(output, name), 'utf8')));
  assert.equal(JSON.stringify(records).includes(secret), false);
  const details = records.find((record) => record.probes.accessibility);
  assert.deepEqual(details.probes.accessibility.value.roles, [
    'dialog',
    'textbox',
  ]);
  assert.equal(details.probes.page.value.url, 'circle://workbench/index.html');
  assert.equal(details.probes.dom.value.rootChildren, 0);
  assert.equal(
    records.filter((record) => Object.keys(record.probes).length === 0).length,
    2,
  );
});

test(
  'one shared deadline bounds hung evidence probes while keeping the primary record',
  { timeout: 6000 },
  async (t) => {
    const logs = quiet(t);
    const output = temporary(t);
    const never = () => new Promise(() => {});
    const page = {
      url: () => 'about:blank',
      pageErrors: never,
      evaluate: async () => ({ readyState: 'complete', rootChildren: 0 }),
      locator: () => ({ ariaSnapshot: never }),
      screenshot: never,
    };
    await captureNativeFailure(page, Error('original timeout'), [], output);
    const primary = readdirSync(output).find((name) =>
      name.endsWith('-primary.json'),
    );
    assert.ok(primary);
    assert.equal(
      JSON.parse(readFileSync(join(output, primary), 'utf8')).error.message
        .text,
      'original timeout',
    );
    const dom = readdirSync(output).find((name) => name.endsWith('-dom.json'));
    assert.ok(
      dom,
      'a successful probe is persisted even when another exhausts the shared budget',
    );
    assert.equal(
      JSON.parse(readFileSync(join(output, dom), 'utf8')).value.rootChildren,
      0,
    );
    assert.ok(logs.some((line) => line.includes('"rootChildren":0')));
    const final = logs
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.probes?.screenshot);
    assert.equal(final.probes.page.status, 'unavailable');
    assert.equal(final.probes.accessibility.status, 'unavailable');
    assert.equal(final.probes.screenshot.status, 'unavailable');
    assert.equal(final.probes.dom.status, 'captured');
  },
);

test('unwritable evidence and failed screenshots cannot replace a check failure', async (t) => {
  const logs = quiet(t);
  const output = temporary(t);
  const notDirectory = join(output, 'not-a-directory');
  writeFileSync(notDirectory, 'fixture');
  const original = Error('original primary');
  await assert.rejects(
    async () => {
      try {
        throw original;
      } catch (error) {
        await captureFailure(undefined, error, [], notDirectory);
        throw error;
      }
    },
    (error) => error === original,
  );
  assert.ok(logs.some((line) => line.includes('original primary')));
  assert.ok(logs.some((line) => line.includes('evidenceWriteError')));
});

test('cleanup attempts every owned operation and leaves a pending primary failure unchanged', async (t) => {
  const logs = quiet(t);
  const original = Error('primary check failure');
  const secondary = Error('app close failure');
  const effects = [];
  await assert.rejects(
    async () => {
      try {
        throw original;
      } finally {
        assert.equal(
          await cleanupNativeTest([
            () => {
              effects.push('app');
              throw secondary;
            },
            () => effects.push('server'),
            () => effects.push('scratch'),
          ]),
          false,
        );
      }
    },
    (error) => error === original,
  );
  assert.deepEqual(effects, ['app', 'server', 'scratch']);
  assert.equal(
    await cleanupNativeTest([
      () => {
        throw secondary;
      },
    ]),
    false,
  );
  const second = Error('other cleanup');
  assert.equal(
    await cleanupNativeTest([
      () => {
        throw secondary;
      },
      () => {
        throw second;
      },
    ]),
    false,
  );
  assert.equal(await cleanupNativeTest([() => {}]), true);
  assert.equal(
    await cleanupNativeTest([
      () => {
        throw new Proxy(
          {},
          {
            get() {
              throw Error('uninspectable throwable');
            },
          },
        );
      },
    ]),
    false,
  );
  assert.ok(logs.some((line) => line.includes('app close failure')));
  assert.ok(logs.some((line) => line.includes('other cleanup')));
});

test('a successful check with failed cleanup naturally exits with a failure status', (t) => {
  const folder = temporary(t);
  const helper = new URL('./helpers/native-failure.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {cleanupNativeTest} from ${JSON.stringify(helper)};
    if (!(await cleanupNativeTest([() => {throw Error('synthetic cleanup after success');}]))) process.exitCode=1;
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CIRCLE_HOME: join(folder, 'home') },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /synthetic cleanup after success/);
});

for (const { brokenCapture, closeFailure } of [
  { brokenCapture: false, closeFailure: false },
  { brokenCapture: false, closeFailure: true },
  { brokenCapture: true, closeFailure: true },
])
  test(`the actual coordinate entry keeps its fill failure and naturally exits with closeFailure=${closeFailure}, brokenCapture=${brokenCapture}`, async (t) => {
    const folder = temporary(t);
    const output = join(folder, 'evidence');
    mkdirSync(output);
    const closeMarker = join(folder, 'closed');
    const portFile = join(folder, 'port.json');
    const sharedOutput = fileURLToPath(
      new URL('../artifacts/browser-coordinate-live', import.meta.url),
    );
    const hook = join(folder, 'hook.mjs');
    const fakeNative = `
    import { writeFileSync } from 'node:fs';
    const endpoint = { async fill() { throw Error('synthetic original fill failure'); }, async isVisible() { return true; }, or() { return { first() { return { async waitFor() {} }; } }; } };
    const page = {
      on() {}, setDefaultTimeout(value) { if (value !== (process.env.CI ? 60000 : 20000)) throw Error('original timeout changed'); },
      getByRole(role, options) { if (role === 'textbox' && options.name === 'base url') return endpoint; if (role === 'button' && options.name === 'connect a model') return { first() { return this; } }; throw Error('unexpected operation before original fill'); },
      url() { return 'circle://workbench/index.html'; },
      async pageErrors() { return [Error('synthetic early bootstrap failure')]; },
      async consoleMessages() { return []; }, async evaluate() { return { readyState: 'complete', rootChildren: 0 }; },
      locator() { return { async ariaSnapshot() { return '- dialog "connect"'; } }; },
      async screenshot() { throw Error('synthetic screenshot unavailable'); }
    };
    export const _electron = { async launch() { return {
      context() { return { on() {} }; }, async firstWindow() { return page; },
      async evaluate() {}, async close() { writeFileSync(${JSON.stringify(closeMarker)}, 'attempted'); if (${closeFailure}) throw Error('synthetic cleanup secondary'); }
    }; } };
  `;
    const fakeFs = `
    import * as fs from 'node:fs/promises'; import { join, basename } from 'node:path';
    export * from 'node:fs/promises';
    const target = (path) => typeof path === 'string' && path.startsWith(${JSON.stringify(sharedOutput)}) ? join(${JSON.stringify(output)}, basename(path)) : path;
    export const mkdir = (path, options) => fs.mkdir(path === ${JSON.stringify(sharedOutput)} ? ${JSON.stringify(output)} : path, options);
    export const writeFile = (path, ...args) => {
      if (${JSON.stringify(brokenCapture)} && target(path) !== path) throw Error('synthetic evidence write failure');
      return fs.writeFile(target(path), ...args);
    };
  `;
    const fakeHttp = `
    import * as http from 'node:http'; import { writeFileSync } from 'node:fs'; export * from 'node:http';
    export function createServer(...args) { const server = http.createServer(...args); server.once('listening', () => writeFileSync(${JSON.stringify(portFile)}, JSON.stringify(server.address()))); return server; }
  `;
    writeFileSync(
      hook,
      `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'playwright') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fakeNative)}), shortCircuit: true };
    if (!context.parentURL?.startsWith('data:') && specifier === 'node:fs/promises') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fakeFs)}), shortCircuit: true };
    if (!context.parentURL?.startsWith('data:') && specifier === 'node:http') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fakeHttp)}), shortCircuit: true };
    return next(specifier, context);
  } });`,
    );
    const entry = fileURLToPath(
      new URL('browser-coordinate-live.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(hook).href, entry],
      {
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env: {
          ...process.env,
          CIRCLE_HOME: join(folder, 'home'),
          CIRCLE_WORKBENCH_DATA_DIR: join(folder, 'data'),
          CIRCLE_DESKTOP_EXECUTABLE: 'synthetic-native-not-launched',
          CIRCLE_DESKTOP_TEST_EXPLICIT_CONNECT: '',
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /synthetic original fill failure/);
    if (closeFailure)
      assert.match(result.stderr, /synthetic cleanup secondary/);
    assert.equal(readFileSync(closeMarker, 'utf8'), 'attempted');
    if (brokenCapture)
      assert.match(result.stderr, /synthetic evidence write failure/);
    else
      assert.ok(
        readdirSync(output).some((name) => name.endsWith('-primary.json')),
      );
    const { port } = JSON.parse(readFileSync(portFile, 'utf8'));
    await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        reject(Error('owned server was left listening'));
      });
      socket.once('error', (error) => {
        if (error.code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
    });
  });
