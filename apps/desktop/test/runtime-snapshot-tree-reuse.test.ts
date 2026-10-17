import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { patience } from './helpers/patience.mjs';

test('one snapshot reads each root tree once while preserving branch selection, labels and real tool history across later appends', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'circle-snapshot-tree-'));
  const home = join(temp, 'home'),
    workspace = join(temp, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const seed = new CheckpointStore(home);
  seed.create(workspace, 'scripted', 'history tree fixture', 'history');
  const rootHead = seed.append('history', [
    { id: 'root-user', role: 'user', content: 'real shared root' },
  ]);
  seed.append('history', [
    { id: 'old-branch', role: 'assistant', content: 'old branch answer' },
  ]);
  seed.setLabel('history', 'old-branch', 'old branch label');
  seed.select('history', rootHead);
  seed.append('history', [
    {
      id: 'new-call',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'read-call',
          name: 'read_file',
          args: { file_path: 'README.md' },
        },
      ],
    },
    {
      id: 'new-result',
      role: 'tool',
      tool_call_id: 'read-call',
      content: 'actual historical README bytes',
    },
    { id: 'new-answer', role: 'assistant', content: 'selected branch answer' },
  ]);
  seed.create(workspace, 'scripted', 'other tree fixture', 'other');
  seed.append('other', [
    { id: 'other-user', role: 'user', content: 'another actual session' },
  ]);
  seed.close();
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: 'history' }),
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'actual-fresh-response',
        role: 'assistant',
        content: 'fresh model answer',
      },
    },
  ]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  const store = (controller as unknown as { store: CheckpointStore }).store;
  const tree = store.tree.bind(store);
  const reads = new Map<string, number>();
  store.tree = (id) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return tree(id);
  };
  const assertOneTree = () => {
    assert.equal(
      reads.get('history'),
      1,
      'history must not be selected/decoded twice per full snapshot',
    );
    assert.equal(
      reads.get('other'),
      1,
      'inactive root must not be selected/decoded twice per full snapshot',
    );
  };
  try {
    const initial = controller.snapshot();
    const history = initial.sessions.find((s) => s.id === 'history')!;
    const old = history.messages.find((m) => m.text === 'old branch answer')!;
    const selected = history.messages.find(
      (m) => m.text === 'selected branch answer',
    )!;
    const tool = history.messages.find((m) => m.tool?.id === 'read-call')!;
    assert.equal(old.label, 'old branch label');
    assert.equal(history.branchIds?.includes(old.id), false);
    assert.equal(history.branchIds?.includes(selected.id), true);
    assert.equal(history.branchIds?.includes(tool.id), true);
    assert.equal(tool.tool?.output, 'actual historical README bytes');
    assert.equal(tool.tool?.status, 'success');
    const firstReads = new Map(reads);
    const reply = await controller.dispatch({
      id: randomUUID(),
      name: 'prompt',
      sessionId: 'history',
      payload: { text: 'continue selected branch' },
    });
    assert.equal(reply.ok, true, reply.error);
    const deadline = Date.now() + patience(8000);
    while (
      !store.messages('history').some((m) => m.id === 'actual-fresh-response')
    ) {
      if (Date.now() > deadline)
        throw Error('actual model append did not settle');
      await delay(5);
    }
    assert.equal(model.requests.length, 1);
    assert(
      model.requests[0]!.messages.some(
        (m) => m.content === 'selected branch answer',
      ),
    );
    assert(
      !model.requests[0]!.messages.some(
        (m) => m.content === 'old branch answer',
      ),
    );
    reads.clear();
    const final = controller
      .snapshot()
      .sessions.find((s) => s.id === 'history')!;
    assert(
      final.messages.some(
        (m) =>
          m.text === 'fresh model answer' && final.branchIds?.includes(m.id),
      ),
    );
    assert.equal(
      final.messages.find((m) => m.id === old.id)?.label,
      'old branch label',
    );
    assertOneTree();
    reads.clear();
    for (const [key, value] of firstReads) reads.set(key, value);
    assertOneTree();
  } finally {
    await controller.close();
    await rm(temp, { recursive: true, force: true });
  }
});
