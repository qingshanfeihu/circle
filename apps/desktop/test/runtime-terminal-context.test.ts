import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import type { RuntimeCommand, RuntimeUpdate } from '../src/runtime-protocol.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import type {
  TerminalReplay,
  TerminalSnapshot,
} from '../src/workspace/terminal.ts';
import { LiveRuntime } from '../../workbench/src/model/live.ts';
import {
  appendTerminalSelection,
  type TerminalSelectionCapture,
} from '../../workbench/src/model/terminal-context.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { patience } from './helpers/patience.mjs';

test('authorized terminal capture stays in the original draft until explicit send reaches the next ScriptedModel request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-terminal-context-'));
  const workspace = join(root, 'project'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const text = 'SELECTED_CONTEXT_中文\nsecond line  exact spaces  ';
  const script = join(workspace, 'source.cjs');
  await writeFile(
    script,
    `console.log(${JSON.stringify(text)});setInterval(()=>{},1000);`,
  );
  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: 'captured context received',
      },
    },
  ]);
  const listeners = new Set<(update: RuntimeUpdate) => void>();
  let seq = 0;
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (update) => {
      for (const receive of listeners) receive({ ...update, seq: ++seq });
    },
  });
  const state = (): RuntimeUpdate => ({
    seq: ++seq,
    connected: true,
    snapshot: controller.snapshot(),
  });
  const commands: RuntimeCommand[] = [];
  const bridge = {
    runtimeState: async () => state(),
    runtimeCommand: (command: RuntimeCommand) => {
      commands.push(command);
      return controller.dispatch(command);
    },
    onRuntime: (receive: (update: RuntimeUpdate) => void) => {
      listeners.add(receive);
      return () => listeners.delete(receive);
    },
  } as unknown as DesktopBridge;
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  let runtime = new LiveRuntime(bridge, state(), storage);
  t.after(async () => {
    runtime.dispose();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const sessionId = runtime.getSnapshot().activeSessionId;
  const service = async <T>(
    method: string,
    params: Record<string, unknown>,
    owner = sessionId,
  ): Promise<T> => {
    const result = await controller.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId: owner,
      payload: { service: 'terminal', method, params },
    });
    if (!result.ok) throw Error(result.error);
    return result.data as T;
  };
  const terminal = await service<TerminalSnapshot>('create', {
    command: { file: process.execPath, args: [script] },
  });
  let page!: TerminalReplay;
  const deadline = Date.now() + patience(8000);
  do {
    page = await service<TerminalReplay>('replay', {
      id: terminal.id,
      afterSequence: 0,
      limit: 256,
    });
    if (
      page.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('SELECTED_CONTEXT_中文')
    )
      break;
    if (Date.now() > deadline)
      throw Error('actual terminal did not produce source text');
    await delay(5);
  } while (true);
  const capture: TerminalSelectionCapture = {
    operationId: randomUUID(),
    sourceSessionId: sessionId,
    terminalId: terminal.id,
    terminalEpoch: terminal.epoch,
    outputSequence: page.nextSequence,
    capturedAt: new Date().toISOString(),
    cols: terminal.cols,
    rows: terminal.rows,
    range: { start: { x: 0, y: 0 }, end: { x: 27, y: 1 } },
    text,
  };
  runtime.updateSessionView(sessionId, {
    draft: 'please inspect my selected output',
    attachments: [],
  });
  const replay = () =>
    service<TerminalReplay>('replay', {
      id: capture.terminalId,
      afterSequence: capture.outputSequence,
      limit: 1,
    });
  await appendTerminalSelection(runtime, capture, replay);
  assert.equal(
    model.requests.length,
    0,
    'adding context must not send a model request',
  );
  assert.equal(
    commands.filter((command) => command.name === 'prompt').length,
    0,
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!.draft,
    'please inspect my selected output',
  );
  const attached = runtime
    .getSnapshot()
    .sessions.find((s) => s.id === sessionId)!.attachments[0];
  assert.ok(attached.content.startsWith(text));
  assert.ok(attached.content.includes(terminal.id));
  assert.ok(attached.content.includes(terminal.epoch));
  assert.ok(attached.content.includes('user-selected capture'));

  // Reopening the renderer view retains the exact ordinary composer attachment.
  runtime.dispose();
  runtime = new LiveRuntime(bridge, state(), storage);
  assert.deepEqual(
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!.attachments,
    [attached],
  );
  assert.equal(
    (await service<TerminalSnapshot[]>('list', {}))[0].pid,
    terminal.pid,
  );
  assert.equal(
    (await service<TerminalSnapshot[]>('list', {}))[0].status,
    'running',
  );

  // A different session cannot use this terminal's source route.
  const other = await runtime.newSession();
  await assert.rejects(
    service('replay', { id: terminal.id, afterSequence: 0 }, other),
    /terminal not found/,
  );
  await runtime.selectSession(sessionId);
  assert.equal(
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!.draft,
    'please inspect my selected output',
  );
  assert.deepEqual(
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!.attachments,
    [attached],
  );

  // Existing chip removal semantics remove only the selected attachment.
  runtime.updateSessionView(sessionId, { attachments: [] });
  assert.equal(model.requests.length, 0);
  await appendTerminalSelection(
    runtime,
    { ...capture, operationId: randomUUID() },
    replay,
  );
  const sent = runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!
    .attachments[0];
  await runtime.send();
  const modelDeadline = Date.now() + patience(8000);
  while (Number(model.requests.length) !== 1) {
    if (Date.now() > modelDeadline)
      throw Error('explicit send did not reach ScriptedModel');
    await delay(5);
  }
  const user = model.requests[0].messages.find(
    (message) => message.role === 'user',
  )!;
  assert.equal(typeof user.content, 'string');
  assert.ok(
    (user.content as string).includes(sent.content),
    'next actual model request receives source metadata and complete original selection',
  );
  assert.ok(
    (user.content as string).startsWith('please inspect my selected output'),
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((s) => s.id === sessionId)!.attachments
      .length,
    0,
  );
  assert.equal(
    (await service<TerminalSnapshot[]>('list', {}))[0].pid,
    terminal.pid,
    'context send does not rerun or replace the existing process',
  );
});
