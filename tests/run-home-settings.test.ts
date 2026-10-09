import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsForRun,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

test('running Circle in the folder that holds CIRCLE_HOME does not read the global settings as a project', async (t) => {
  // `CIRCLE_HOME=C:\Users\jiang\.circle` while running in `C:\Users\jiang`: the workspace's
  // `.circle/settings.json` is the global file, not a project's.
  const workspace = scratch(t);
  const home = join(workspace, '.circle');
  let saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved.theme = 'dark';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  const { settings, problems } = settingsForRun(home, workspace);
  assert.deepEqual(problems, []);
  assert.equal(settings.auth.model, 'saved-model');
  assert.equal(settings.theme, 'dark');
  const file = loadSettings(home);
  assert.equal(file.auth.model, 'saved-model');
  assert.equal(file.theme, 'dark');
});

test('a project settings file inside the home folder still applies and reports unknown keys', async (t) => {
  // The workspace's `.circle` is not CIRCLE_HOME, but a real project file next to it.
  const workspace = scratch(t);
  const home = join(workspace, 'elsewhere');
  let saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved.theme = 'dark';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'settings.json'),
    JSON.stringify({ model: 'project-model', theme: 'light', version: 1 }),
  );
  const { settings, problems } = settingsForRun(home, workspace);
  assert.deepEqual(problems, [
    `${join(workspace, '.circle', 'settings.json')}: 'version' is not a project setting`,
  ]);
  assert.equal(settings.auth.model, 'project-model');
  assert.equal(settings.theme, 'light');
  assert.equal(loadSettings(home).theme, 'dark');
});
