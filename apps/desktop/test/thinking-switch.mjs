// Real native bridge + bundled runtime, local API, and synthetic persisted history.
// Run with root tsx; CIRCLE_DESKTOP_EXECUTABLE selects the packaged application.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { GatewayModel } from '../../../src/model.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../../../src/settings.ts';
import {
  thinkingGateway,
  checkpointRows,
} from '../../../tests/thinking-fixture.ts';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-thinking-'));
const data = join(temp, 'data'),
  home = join(data, 'runtime-home'),
  workspace = join(temp, 'workspace');
const output = resolve(
  root,
  '../../outputs/thinking-switch',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
await mkdir(workspace);
await mkdir(join(home, 'cache'), { recursive: true });
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const gateway = await thinkingGateway();
const settings = trustFolder(defaultSettings(), workspace);
settings.initialized = true;
settings.update_check = false;
settings.auth = {
  ...settings.auth,
  protocol: 'anthropic',
  base_url: gateway.base + '/old',
  model: 'claude-fixture',
};
saveSettings(settings, home);
saveCredentials({ api_key: 'old-key' }, home);
const user = { id: 'user', role: 'user', content: 'synthetic question' };
const old = (
  await new GatewayModel(settings, home).complete({
    system: 'system',
    messages: [user],
    tools: [],
    signal: new AbortController().signal,
    token() {},
  })
).message;
let store = new CheckpointStore(home);
const known = store.create(
  workspace,
  'claude-fixture',
  'known history',
  'circle-known',
);
store.append(known.id, [user, old]);
const legacy = store.create(
  workspace,
  'claude-fixture',
  'legacy history',
  'circle-legacy',
);
const imported = structuredClone(old);
delete imported.thinking_scope;
imported.id = 'legacy-assistant';
store.append(legacy.id, [user, imported]);
const originals = [known, legacy].map((s) => ({
  id: s.id,
  rows: store.tree(s.id),
}));
store.close();
const rawOriginals = await Promise.all(
  originals.map(async (o) => ({
    id: o.id,
    rows: await checkpointRows(home, o.id),
  })),
);
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
let app;
const checks = [];
const ready = async (page) =>
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
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForFunction(() => Boolean(window.circleDesktop));
  assert.equal(
    (await page.evaluate(() => window.circleDesktop.info())).frontendOnly,
    false,
  );
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
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
      await ready(page);
      assert.equal((await state()).activeSessionId, payload.id);
    }
    return reply;
  };
  const done = async (label, expectedRequests, assistantCount) =>
    waitDesktopReady(
      async () => ({
        snapshot: await state(),
        requests: gateway.requests.length,
      }),
      ({ snapshot: s, requests }) => {
        const session = s.sessions.find((row) => row.id === s.activeSessionId);
        return (
          requests === expectedRequests &&
          session?.state === 'idle' &&
          !session.turn &&
          session.messages.filter((m) => m.role === 'assistant').length >=
            assistantCount
        );
      },
      { label, timeoutMs: 15000 },
    );
  await command('select-session', { id: legacy.id });
  await command('configure', {
    protocol: 'anthropic',
    endpoint: gateway.base + '/new',
    apiKey: 'new-key',
    model: 'claude-fixture',
  });
  await command('prompt', { text: 'continue legacy' });
  await done('legacy recovery', 3, 2);
  assert.equal(
    gateway.requests.length,
    3,
    'legacy request rejected once, then accepted',
  );
  assert.equal(gateway.requests[1].rejected, true);
  assert.equal(gateway.requests[2].rejected, false);
  await page.getByText('accepted', { exact: true }).last().waitFor();
  checks.push('native legacy signature rejection recovered with one retry');
  await command('select-session', { id: known.id });
  await command('prompt', { text: 'continue known' });
  await done('known scope switch', 4, 2);
  assert.equal(gateway.requests.length, 4);
  assert.equal(gateway.requests[3].rejected, false);
  checks.push(
    'native API configuration switch strips foreign thinking before sending',
  );
  await command('prompt', { text: 'continue fresh' });
  await done('fresh signed history', 5, 3);
  assert.equal(gateway.requests.length, 5);
  assert.equal(gateway.requests[4].rejected, false);
  assert.ok(
    gateway.requests[4].body.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'thinking'),
    ),
    'same-connection thinking is retained',
  );
  await page.screenshot({ path: join(output, 'native.png') });
  await app.close();
  app = undefined;
  store = new CheckpointStore(home);
  for (const original of originals)
    assert.deepEqual(
      store.tree(original.id).slice(0, original.rows.length),
      original.rows,
    );
  store.close();
  checks.push(
    'original checkpoint rows are unchanged, including signatures and thinking',
  );
  assert.deepEqual(errors, []);
  // Restart the native executable against the same synthetic home and resume old data.
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  const restarted = await app.firstWindow();
  await restarted.waitForFunction(() => Boolean(window.circleDesktop));
  const result = await restarted.evaluate(async (id) => {
    const { snapshot } = await window.circleDesktop.runtimeState();
    return window.circleDesktop.runtimeCommand({
      id: crypto.randomUUID(),
      name: 'select-session',
      payload: { id },
      sessionId: snapshot.activeSessionId,
    });
  }, known.id);
  assert.equal(result.ok, true, result.error);
  await restarted.evaluate((id) => {
    location.hash = '/session/' + id;
  }, known.id);
  await ready(restarted);
  await restarted.evaluate(async () => {
    const { snapshot } = await window.circleDesktop.runtimeState();
    return window.circleDesktop.runtimeCommand({
      id: crypto.randomUUID(),
      name: 'prompt',
      payload: { text: 'after restart' },
      sessionId: snapshot.activeSessionId,
    });
  });
  await waitDesktopReady(
    () =>
      restarted.evaluate(
        async () => (await window.circleDesktop.runtimeState()).snapshot,
      ),
    (s) => {
      const session = s.sessions.find((row) => row.id === s.activeSessionId);
      return (
        gateway.requests.length === 6 &&
        session?.state === 'idle' &&
        !session.turn &&
        session.messages.filter((m) => m.role === 'assistant').length >= 4
      );
    },
    { label: 'native restart', timeoutMs: 15000 },
  );
  assert.equal(gateway.requests.length, 6);
  assert.equal(gateway.requests[5].rejected, false);
  for (const original of rawOriginals)
    assert.deepEqual(
      (await checkpointRows(home, original.id)).slice(0, original.rows.length),
      original.rows,
    );
  checks.push('restart preserves scope and original raw checkpoint JSON bytes');
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        checks,
        requests: gateway.requests,
        executable: process.env.CIRCLE_DESKTOP_EXECUTABLE ?? 'development',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks, requests: gateway.requests.length, output }),
  );
} finally {
  await app?.close();
  await gateway.close();
  await rm(temp, { recursive: true, force: true });
}
