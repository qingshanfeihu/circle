import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.js';
import { CheckpointStore } from '../../../src/checkpoint_store.js';
import { ScriptedModel } from '../../../src/testing.js';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.js';
import { emptyUsage, type Message } from '../../../src/types.js';
import type { RuntimeCommand } from '../src/runtime-protocol.js';
import type { TaskRecord } from '../src/workspace/task-store.js';
import { patience } from './helpers/patience.mjs';
const assistant = (content: string): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + patience(8000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('task title fixture did not settle');
    await delay(5);
  }
}

test('task titles are persisted from human instructions before the internal prompt, retain manual renames and recover without changing settings or task identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-task-title-'));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', [
    '-C',
    workspace,
    'config',
    '--local',
    'core.autocrlf',
    'false',
  ]);
  await writeFile(join(workspace, 'README.md'), '# task title fixture\n');
  execFileSync('git', ['-C', workspace, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  ]);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const settingsBefore = await readFile(join(home, 'settings.json'));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    async () => {
      await held;
      return {
        message: assistant('candidate ready for review'),
        usage: emptyUsage(),
      };
    },
    {
      message: assistant('independent review still requires human acceptance'),
    },
    { message: assistant('retry candidate ready for review') },
    {
      message: assistant(
        'independent retry review still requires human acceptance',
      ),
    },
  ]);
  let controller = new RuntimeController({
    home,
    userHome: home,
    workspace,
    model,
    emit() {},
  });
  t.after(async () => {
    release();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async <T = unknown>(
    name: RuntimeCommand['name'],
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ): Promise<T> => {
    const reply = await controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId,
    });
    assert.equal(reply.ok, true, reply.error);
    return reply.data as T;
  };
  const tasks = () =>
    call<TaskRecord[]>('workspace-service', {
      service: 'tasks',
      method: 'list',
    });
  const title = '修复登录页面的错误提示 ' + '界面🙂'.repeat(60);
  const prompt = `\n\n${title}\n保留完整需求与验收说明。`;
  const taskId = randomUUID();
  await call('workspace-service', {
    service: 'tasks',
    method: 'enqueue',
    params: {
      operationId: 'human-readable-task',
      tasks: [
        {
          id: taskId,
          prompt,
          access: 'readonly',
          acceptanceCriteria: ['human-readable title remains saved'],
        },
      ],
    },
  });
  await until(() => model.requests.length === 1);
  const record = (await tasks())[0];
  const workerId = record.runtimeSessionId!;
  const expectedTitle = Array.from(title).slice(0, 100).join('');
  assert.ok(workerId);
  assert.equal(
    controller.snapshot().sessions.find((session) => session.id === workerId)
      ?.title,
    expectedTitle,
  );
  const store = new CheckpointStore(home);
  try {
    assert.equal(store.get(workerId)?.title, expectedTitle);
    assert.match(
      store.messages(workerId).find((message) => message.role === 'user')!
        .content,
      new RegExp(`^Task ${taskId}, attempt 1\\.`),
    );
    assert.ok(
      store
        .messages(workerId)
        .find((message) => message.role === 'user')!
        .content.includes(prompt),
    );
    const renamed = '登录错误提示：待产品验收';
    await call('rename-session', { id: workerId, title: renamed });
    release();
    await until(async () => (await tasks())[0].state === 'needs_review');
    assert.equal(
      (await tasks())[0].runtimeSessionId,
      workerId,
      'independent reviewer cannot replace worker identity',
    );
    assert.equal(store.get(workerId)?.title, renamed);
    const reviewers = (await tasks())[0].reviewers ?? [];
    assert.equal(reviewers.length, 1);
    const reviewerId = reviewers[0].sessionId;
    assert.notEqual(reviewerId, workerId);
    const expectedReviewerTitle =
      'review: ' + Array.from(title).slice(0, 92).join('');
    assert.equal(store.get(reviewerId)?.title, expectedReviewerTitle);
    assert.equal(Array.from(store.get(reviewerId)!.title).length, 100);
    assert.equal(
      controller.snapshot().agents.find((agent) => agent.id === reviewerId)
        ?.task?.role,
      'reviewer',
      'the distinct title belongs to the actual registered reviewer',
    );
    const renamedReviewer = '登录错误提示：独立审阅记录';
    await call('rename-session', { id: reviewerId, title: renamedReviewer });
    await call('workspace-service', {
      service: 'tasks',
      method: 'retry',
      params: { id: taskId, operationId: 'second-attempt' },
    });
    await until(
      async () =>
        (await tasks())[0].attempt === 2 &&
        (await tasks())[0].state === 'needs_review',
    );
    const retried = (await tasks())[0];
    assert.notEqual(retried.runtimeSessionId, workerId);
    assert.equal(
      store.get(retried.runtimeSessionId!)?.title,
      Array.from(title).slice(0, 90).join('') + ' · #2',
    );
    assert.equal(
      store.get(workerId)?.title,
      renamed,
      'retry leaves the previous attempt manual title intact',
    );
    assert.equal(
      store.get(reviewerId)?.title,
      renamedReviewer,
      'retry leaves the actual previous reviewer manual title intact',
    );
    const retriedReviewers = retried.reviewers ?? [];
    assert.equal(retriedReviewers.length, 1);
    const retriedReviewerId = retriedReviewers[0].sessionId;
    assert.notEqual(retriedReviewerId, reviewerId);
    assert.notEqual(retriedReviewerId, retried.runtimeSessionId);
    assert.equal(
      store.get(retriedReviewerId)?.title,
      'review: ' + Array.from(title).slice(0, 87).join('') + ' · #2',
    );
    for (const id of [retried.runtimeSessionId!, retriedReviewerId])
      assert.ok(
        Array.from(store.get(id)!.title).length <= 100,
        'the role prefix and retry suffix share the automatic title budget',
      );
    assert.deepEqual(
      await readFile(join(home, 'settings.json')),
      settingsBefore,
      'session_name is run-only and cannot change user settings',
    );
    await controller.close();
    const reopenedModel = new ScriptedModel();
    controller = new RuntimeController({
      home,
      userHome: home,
      workspace,
      model: reopenedModel,
      emit() {},
    });
    assert.equal(
      controller.snapshot().sessions.find((session) => session.id === workerId)
        ?.title,
      renamed,
    );
    assert.equal(store.get(workerId)?.title, renamed);
    assert.equal(store.get(reviewerId)?.title, renamedReviewer);
    assert.equal(
      controller
        .snapshot()
        .sessions.find((session) => session.id === reviewerId)?.title,
      renamedReviewer,
    );
    assert.equal(reopenedModel.requests.length, 0);
    await call('select-session', { id: workerId });
    assert.equal(controller.snapshot().activeSessionId, workerId);
    assert.equal(
      controller.snapshot().sessions.find((session) => session.id === workerId)
        ?.title,
      renamed,
      'opening existing task history does not reapply an automatic name',
    );
    await call('select-session', { id: reviewerId });
    assert.equal(controller.snapshot().activeSessionId, reviewerId);
    assert.equal(
      store.get(reviewerId)?.title,
      renamedReviewer,
      'opening actual reviewer history does not reapply its automatic role title',
    );
    assert.equal(store.get(workerId)?.title, renamed);
    assert.equal(reopenedModel.requests.length, 0);
    assert.deepEqual(
      await readFile(join(home, 'settings.json')),
      settingsBefore,
    );
  } finally {
    store.close();
  }
});
