import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../../../src/settings.ts';
import {
  pairingGateway,
  pairingRows,
} from '../../../tests/tool-pairing-fixture.ts';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import { patience } from './helpers/patience.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  require = createRequire(import.meta.url);
const output = resolve(
  root,
  '../../outputs/mode-tool-pairing',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
for (const protocol of ['anthropic', 'openai']) {
  const temp = await mkdtemp(join(tmpdir(), 'circle-native-pairing-')),
    data = join(temp, 'data'),
    home = join(data, 'runtime-home'),
    workspace = join(temp, 'workspace');
  await mkdir(workspace);
  await mkdir(join(home, 'cache'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'alpha');
  await writeFile(join(workspace, 'b.txt'), 'beta');
  await writeFile(
    join(home, 'cache', 'models-dev.json'),
    JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
  );
  const gateway = await pairingGateway(protocol);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.update_check = false;
  settings.auth = {
    ...settings.auth,
    protocol,
    base_url: gateway.base,
    model: 'gateway',
  };
  saveSettings(settings, home);
  saveCredentials({ api_key: 'fixture' }, home);
  const store = new CheckpointStore(home),
    session = store.create(workspace, 'gateway', 'mode test', 'circle-mode');
  store.close();
  const env = {
    ...process.env,
    CIRCLE_HOME: join(temp, 'cli-home'),
    CIRCLE_WORKBENCH_DATA_DIR: data,
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_NO_MODELS_REFRESH: '1',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
  if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
    env.PATH =
      process.platform === 'win32'
        ? process.env.SystemRoot + '\\System32'
        : '/usr/bin:/bin:/usr/sbin:/sbin';
  let app, page;
  const errors = [];
  const launch = async () => {
    app = await electron.launch({
      executablePath:
        process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
      args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
      cwd: root,
      env,
      chromiumSandbox: true,
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(patience(15000));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.waitForFunction(() => Boolean(window.circleDesktop));
  };
  const routeReady = () =>
    waitDesktopReady(
      () =>
        page.evaluate(async () => {
          const { snapshot } = await window.circleDesktop.runtimeState();
          return {
            active: snapshot.activeSessionId,
            configured: snapshot.runtime?.configured,
            connected: snapshot.runtime?.connected,
            hash: location.hash,
          };
        }),
      (s) =>
        Boolean(
          s.configured && s.connected && s.hash === '#/session/' + s.active,
        ),
      { label: 'native renderer route ready', timeoutMs: 15000 },
    );
  const command = async (name, payload = {}) => {
    const reply = await page.evaluate(
      async ({ name, payload }) => {
        const { snapshot } = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: snapshot.activeSessionId,
        });
      },
      { name, payload },
    );
    assert.equal(reply.ok, true, `${name}: ${reply.error}`);
    if (name === 'select-session') {
      await page.evaluate((id) => {
        location.hash = '/session/' + id;
      }, payload.id);
      await routeReady();
      const { snapshot } = await page.evaluate(() =>
        window.circleDesktop.runtimeState(),
      );
      assert.equal(snapshot.activeSessionId, payload.id);
    }
    return reply;
  };
  const done = async (count, assistantCount) =>
    waitDesktopReady(
      async () => ({
        snapshot: (
          await page.evaluate(() => window.circleDesktop.runtimeState())
        ).snapshot,
        requests: gateway.requests.length,
      }),
      ({ snapshot: s, requests }) => {
        const current = s.sessions.find((row) => row.id === s.activeSessionId);
        return (
          requests === count &&
          current?.state === 'idle' &&
          !current.turn &&
          current.messages.filter((m) => m.role === 'assistant').length >=
            assistantCount
        );
      },
      { label: protocol + ' native mode switch', timeoutMs: 15000 },
    );
  try {
    await launch();
    assert.equal(
      (await page.evaluate(() => window.circleDesktop.info())).frontendOnly,
      false,
    );
    await command('select-session', { id: session.id });
    await command('prompt', { text: 'enter plan and read both files' });
    await done(2, 1);
    await page.getByText('paired response', { exact: true }).waitFor();
    const original = await pairingRows(home, session.id);
    const raw = original.map((row) => JSON.parse(row.message));
    const index = raw.findIndex((m) => m.tool_calls?.length === 3);
    assert.ok(index >= 0);
    assert.equal(raw[index + 1].internal, 'mode-boundary');
    assert.equal(raw.filter((m) => m.role === 'tool').length, 3);
    assert.ok(
      raw.filter((m) => m.role === 'tool').every((m) => m.status === 'success'),
    );
    assert.match(raw.find((m) => m.tool_call_id === 'call-a').content, /alpha/);
    assert.match(raw.find((m) => m.tool_call_id === 'call-b').content, /beta/);
    await command('set-mode', { mode: 'manual' });
    await command('prompt', { text: 'after plan to manual' });
    await done(3, 2);
    await command('set-mode', { mode: 'plan' });
    await command('set-mode', { mode: 'auto' });
    await command('prompt', { text: 'after plan to auto' });
    await done(4, 3);
    assert.deepEqual(
      (await pairingRows(home, session.id)).slice(0, original.length),
      original,
    );
    await page.screenshot({ path: join(output, protocol + '.png') });
    await app.close();
    app = undefined;
    await launch();
    await command('select-session', { id: session.id });
    await command('prompt', { text: 'after native restart' });
    await done(5, 4);
    assert.ok(gateway.requests.every((r) => !r.error));
    assert.deepEqual(
      (await pairingRows(home, session.id)).slice(0, original.length),
      original,
    );
    assert.deepEqual(errors, []);
    const receipt = {
      protocol,
      checks: [
        'actual plan_enter plus two read_file results',
        'plan to manual and plan to auto',
        'restart of native executable',
        'unchanged original checkpoint JSON',
        'all wire tool batches accepted',
      ],
      requests: gateway.requests,
      errors,
    };
    await writeFile(
      join(output, protocol + '.json'),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      JSON.stringify({
        protocol,
        requests: gateway.requests.length,
        checks: receipt.checks,
        output,
      }),
    );
  } finally {
    await app?.close();
    await gateway.close();
    await rm(temp, { recursive: true, force: true });
  }
}
