import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { SessionApp } from '../src/tui/session_app.js';
import { rpcMessage } from '../src/rpc_codec.js';
import { validateMessages } from '../src/session_graph.js';
import { cleanup, scratch } from './helpers.js';
const command = (
  root: string,
  code: string,
  filename = 'command.cjs',
): string => {
  const path = join(root, filename);
  writeFileSync(path, code);
  return `"${process.execPath}" "${path}"`;
};
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('user command did not settle');
    await delay(10);
  }
}
test('user commands execute without a model turn, share exact output with the next request and restore after export/restart', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    { message: { id: 'answer', role: 'assistant', content: 'seen' } },
  ]);
  const settings = defaultSettings();
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const text = command(
    root,
    "require('node:fs').writeFileSync('receipt', 'written'); console.log('actual 中文🙂 output');",
  );
  const result = await runtime.userShells.run(text);
  assert.equal(result.exit_code, 0);
  assert.equal(model.requests.length, 0);
  assert.equal(readFileSync(join(root, 'receipt'), 'utf8'), 'written');
  const message = runtime.harness.messages[0]!;
  assert.equal(message.shell!.output, 'actual 中文🙂 output\n');
  assert.equal(message.display, '!' + text);
  assert.equal(
    (rpcMessage(message).data.additional_kwargs as any).circle_shell.output,
    message.shell!.output,
  );
  await runtime.harness.run('Use my command output');
  assert.equal(
    model.requests[0]!.messages[0]!.shell!.output,
    message.shell!.output,
  );
  validateMessages(runtime.harness.messages);
  const sessionId = runtime.session.id;
  const messages = runtime.harness.messages;
  const bundle = runtime.exportSession();
  await runtime.close();
  const reopened = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    sessionId,
  });
  cleanup(t, () => reopened.close());
  assert.deepEqual(reopened.harness.messages, messages);
  const imported = new AgentRuntime({
    workspace: root,
    home: join(root, 'imported'),
    settings,
    model: new ScriptedModel(),
  });
  cleanup(t, () => imported.close());
  await imported.importSession(bundle);
  assert.deepEqual(imported.harness.messages, messages);
});

test('quiet foreground and background commands make real effects without entering the next model request or saved history', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    { message: { id: 'answer', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.userShells.run(
    command(root, "console.log('private foreground receipt');"),
    true,
  );
  const running = runtime.userShells.run(
    command(
      root,
      "require('node:fs').writeFileSync('started', 'yes'); setTimeout(() => { console.log('private background receipt'); require('node:fs').writeFileSync('finished', 'yes'); }, 150);",
      'background.cjs',
    ),
    true,
  );
  await until(() => existsSync(join(root, 'started')));
  assert.equal(runtime.jobs.backgroundForeground(), 1);
  const result = await running;
  assert.ok(result.job);
  await until(() => runtime.userShells.views.at(-1)!.status === 'done');
  assert.equal(existsSync(join(root, 'finished')), true);
  assert.equal(runtime.jobs.hasNotices(runtime.session.id), false);
  assert.equal(runtime.harness.messages.length, 0);
  await runtime.harness.run('A new request');
  assert.ok(
    !JSON.stringify(model.requests).includes('private foreground receipt'),
  );
  assert.ok(
    !JSON.stringify(model.requests).includes('private background receipt'),
  );
  assert.ok(
    runtime.userShells.views[0]!.output.includes('private foreground receipt'),
  );
});

test('cancellation stops a real user process tree, blocks concurrent model starts and does not share an incomplete result', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
  });
  cleanup(t, () => runtime.close());
  writeFileSync(
    join(root, 'child.cjs'),
    "require('node:fs').writeFileSync('ready', 'yes'); setTimeout(() => require('node:fs').writeFileSync('late', 'bad'), 1500);",
  );
  const running = runtime.userShells.run(
    command(
      root,
      "require('node:child_process').spawn(process.execPath, ['child.cjs'], {stdio:'ignore'}); setTimeout(() => {}, 10000);",
    ),
  );
  // Observe rejection immediately so intentional cancellation is never unhandled.
  const outcome = running.then(
    () => 'finished',
    () => 'stopped',
  );
  await until(() => existsSync(join(root, 'ready')));
  assert.equal(runtime.busy, true);
  await assert.rejects(
    runtime.harness.run('must not start'),
    /user command is running/,
  );
  await runtime.cancel();
  assert.equal(await outcome, 'stopped');
  assert.equal(runtime.busy, false);
  await delay(1700);
  assert.equal(existsSync(join(root, 'late')), false);
  assert.equal(runtime.harness.messages.length, 0);
  assert.equal(runtime.userShells.views[0]!.status, 'stopped');
});

test('terminal ! and !! submissions use owned execution; queued prompts start after the command and include only shared output', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel([
    { message: { id: 'answer', role: 'assistant', content: 'queued answer' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  const app = new SessionApp(root, root, settings);
  app.runtime = runtime;
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const running = app.submit(
    '!' + command(root, "setTimeout(() => console.log('shared result'), 100);"),
  );
  await app.submit('Queued prompt');
  assert.equal(runtime.harness.pendingMessageCount, 1);
  await running;
  await until(() => model.requests.length === 1 && !runtime.busy);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, 'Queued prompt');
  assert.ok(
    model.requests[0]!.messages.some((message) =>
      message.shell?.output.includes('shared result'),
    ),
  );
  await app.submit(
    '!!' + command(root, "console.log('only on screen');", 'quiet.cjs'),
  );
  assert.equal(model.requests.length, 1);
  assert.ok(
    !JSON.stringify(runtime.harness.messages).includes('only on screen'),
  );
  runtime.setPlanMode(true);
  await assert.rejects(runtime.userShells.run('echo blocked'), /Plan mode/);
});
