import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PlanPanel,
  planRows,
  planStart,
} from '../src/ink/components/plan_panel.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import { InputParser } from '../src/ink/parse_keypress.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Todo } from '../src/tools.js';
import { cleanup, scratch } from './helpers.js';

function todos(): Todo[] {
  return Array.from({ length: 12 }, (_, i) => ({
    content: `任务 ${i + 1}\nsecond line`,
    status: i < 6 ? 'completed' : i === 6 ? 'in_progress' : 'pending',
  }));
}
test('plan follows actual statuses, preserves manual scrolling until updates and fits narrow terminal rows', () => {
  const items = todos();
  assert.equal(planStart(items), 4);
  const panel = new PlanPanel();
  panel.update(items);
  panel.scroll(2);
  assert.equal(panel.start, 6);
  panel.update(structuredClone(items));
  assert.equal(panel.start, 6);
  panel.scroll(100);
  assert.equal(panel.start, 7);
  panel.follow();
  assert.equal(panel.start, 4);
  items[6]!.status = 'completed';
  items[7]!.status = 'in_progress';
  panel.update(items);
  assert.equal(panel.start, 5);
  for (const width of [24, 60, 100]) {
    const rows = planRows(items, width, panel.start);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => stringWidth(row) === width));
    assert.ok(stripAnsi(rows.at(-1)!).includes('6–10 / 12'));
    assert.ok(rows.every((row) => !stripAnsi(row).includes('\n')));
  }
  const allDone = items.map((item) => ({
    ...item,
    status: 'completed' as const,
  }));
  assert.equal(planStart(allDone), 7);
  assert.ok(stripAnsi(planRows(allDone, 60)[0]!).includes('Plan 12/12'));
});

test('actual session input routes wheel events to the plan and Alt+Up takes unsent messages back from the real harness', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.todos = todos();
  const app = new SessionApp(root, root, settings);
  app.runtime = runtime;
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  ui.repaint();
  const top = rendered.findIndex((row) => /^┌.*Plan/.test(stripAnsi(row)));
  assert.ok(top >= 0);
  const initial = app.state.planStart;
  const parser = new InputParser();
  for (const event of parser.feed(`\x1b[<65;3;${top + 2}M`)) ui.handle(event);
  assert.equal(app.state.planStart, initial! + 1);
  assert.equal(app.state.scroll, 0);
  for (const event of parser.feed('\x1b[<64;3;2M')) ui.handle(event);
  assert.equal(app.state.scroll, 3);
  runtime.harness.queue('steer\nnext', 'steer');
  runtime.harness.queue('follow', 'followUp');
  const snapshot = runtime.harness.queuedMessages;
  snapshot.steering.push('must not enter the queue');
  ui.repaint();
  const screen = rendered.map(stripAnsi).join('\n');
  assert.match(screen, /steering: steer next/);
  assert.match(screen, /follow-up: follow/);
  assert.ok(!screen.includes('must not enter the queue'));
  ui.setDraft('draft');
  for (const event of parser.feed('\x1b[1;3A')) ui.handle(event);
  assert.equal(app.state.draft, 'steer\nnext\n\nfollow\n\ndraft');
  assert.deepEqual(runtime.harness.queuedMessages, {
    steering: [],
    followUp: [],
  });
  assert.equal(app.state.draftCursor, Array.from(app.state.draft).length);
  const model = new ScriptedModel([
    { message: { id: 'idle-answer', role: 'assistant', content: 'sent' } },
  ]);
  runtime.harness.model = model;
  ui.setDraft('idle follow-up');
  ui.handle({ type: 'key', key: 'ctrl+q', char: '' });
  for (let i = 0; i < 100 && (!model.requests.length || runtime.busy); i++)
    await delay(10);
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, 'idle follow-up');
  assert.equal(app.state.draft, '');
});
