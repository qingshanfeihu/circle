import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  availableUpdate,
  updateInstalled,
  updateNotice,
} from '../src/update.js';
import { loadRemap } from '../src/keybindings.js';
import { SessionApp } from '../src/tui/session_app.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

function app(t: Parameters<typeof cleanup>[0], home: string): SessionApp {
  const session = new SessionApp(scratch(t), home, defaultSettings());
  const ui = session as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  return session;
}

test('the update check asks once a day, remembers a failed check and shares its file with the Python releases', async (t) => {
  const home = scratch(t);
  let asked = 0;
  const latest = async (): Promise<string> => {
    asked++;
    return '1.2.0';
  };
  assert.equal(await availableUpdate(home, '1.0.0', latest, 1000), '1.2.0');
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')),
    { checked_at: 1000, latest: '1.2.0' },
  );
  assert.equal(await availableUpdate(home, '1.0.0', latest, 2000), '1.2.0');
  assert.equal(asked, 1);
  assert.equal(await availableUpdate(home, '1.2.0', latest, 3000), undefined);
  const failing = async (): Promise<string> => {
    asked++;
    throw new Error('offline');
  };
  // A day later the network fails: the last answer stays and is not asked for again today.
  assert.equal(
    await availableUpdate(home, '1.0.0', failing, 1000 + 86400),
    '1.2.0',
  );
  assert.equal(
    await availableUpdate(home, '1.0.0', failing, 2000 + 86400),
    '1.2.0',
  );
  assert.equal(asked, 2);
  // What 0.5.0 wrote is read as it is.
  writeFileSync(
    join(home, 'update-check.json'),
    JSON.stringify({ checked_at: 5000.25, latest: '0.5.0' }) + '\n',
  );
  assert.equal(await availableUpdate(home, '1.0.0', latest, 5001), undefined);
  assert.equal(asked, 2);
});

test('the terminal shows the update line unless the check is turned off', async (t) => {
  const home = scratch(t);
  const latest = async (): Promise<string> => '9.0.0';
  const previous = process.env.CIRCLE_NO_UPDATE_CHECK;
  cleanup(t, () => {
    if (previous === undefined) delete process.env.CIRCLE_NO_UPDATE_CHECK;
    else process.env.CIRCLE_NO_UPDATE_CHECK = previous;
  });
  delete process.env.CIRCLE_NO_UPDATE_CHECK;
  const shown = app(t, home);
  await shown.checkForUpdate(latest);
  assert.deepEqual(shown.state.notices, [updateNotice('9.0.0')]);
  const off = app(t, scratch(t));
  off.settings.update_check = false;
  await off.checkForUpdate(latest);
  process.env.CIRCLE_NO_UPDATE_CHECK = '1';
  const quiet = app(t, scratch(t));
  await quiet.checkForUpdate(latest);
  assert.deepEqual([...off.state.notices, ...quiet.state.notices], []);
});

test('circle update takes a version the way the Python releases did', async () => {
  const previous = process.env.CIRCLE_INSTALL_PREFIX;
  delete process.env.CIRCLE_INSTALL_PREFIX;
  try {
    for (const args of [['--version', '1.0.1'], ['1.0.1'], ['--check']])
      await assert.rejects(
        updateInstalled(args),
        /requires an installer-managed installation/,
      );
    for (const args of [['--version'], ['1.0.1', '1.0.2'], ['--force']])
      await assert.rejects(updateInstalled(args), /usage: circle update/);
  } finally {
    if (previous !== undefined) process.env.CIRCLE_INSTALL_PREFIX = previous;
  }
});

test('keybindings.json from the Python releases keeps working and its problems are shown', (t) => {
  const home = scratch(t);
  writeFileSync(
    join(home, 'keybindings.json'),
    JSON.stringify({
      'job.background': 'ctrl+k',
      'command.background': 'alt+b',
      'no.such': 'ctrl+y',
    }),
  );
  const { remap, problems } = loadRemap(home);
  assert.equal(remap['ctrl+k'], 'ctrl+b');
  assert.equal(remap['alt+b'], 'ctrl+b');
  assert.deepEqual(problems, ["unknown action 'no.such' in keybindings.json"]);
  const session = app(t, home);
  session.applyRunSettings();
  assert.deepEqual(session.state.notices, [
    "✖ unknown action 'no.such' in keybindings.json",
  ]);
});
