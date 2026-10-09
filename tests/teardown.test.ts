import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

test('a repaint that comes after the runtime closed reads nothing from the closed session store', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let painted = 0;
  ui.screen.render = () => {
    painted++;
  };
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  app.runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  ui.repaint();
  assert.equal(painted, 1);
  // a stopped job or a late reply settles after leaving and asks for a repaint
  await app.runtime.close();
  assert.doesNotThrow(() => ui.repaint());
  assert.equal(painted, 1);
});
