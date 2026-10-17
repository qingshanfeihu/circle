import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RuntimeFixtureModel,
  type RuntimeFixture,
} from '../src/runtime-fixture.js';
import { RuntimeController } from '../src/runtime-controller.js';
import type { TaskArtifact, TaskRecord } from '../src/workspace/task-store.js';
import type { RuntimeCommand } from '../src/runtime-protocol.js';
import type { ModelRequest } from '../../../src/types.js';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.js';
import { patience } from './helpers/patience.mjs';

const helper = await import(
  new URL('./helpers/native-task-fixture.mjs', import.meta.url).href
);
const nativeTaskJourneyFixture = helper.nativeTaskJourneyFixture as (
  requestsPath: string,
) => RuntimeFixture;
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + patience(10000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`fixture timed out: ${label}`);
    await delay(5);
  }
}
const terminal = (task: TaskRecord) =>
  ['succeeded', 'needs_review', 'failed', 'cancelled', 'interrupted'].includes(
    task.state,
  );

for (const order of [
  ['A', 'B'],
  ['B', 'A'],
]) {
  test(`real concurrent worktrees and independent reviewers route by task with approval order ${order.join(' then ')}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-routed-native-'));
    const home = join(root, 'home'),
      workspace = join(root, 'repo'),
      requestsPath = join(root, 'requests.jsonl');
    await mkdir(home);
    await mkdir(workspace);
    await writeFile(
      join(workspace, 'README.md'),
      '# isolated routed fixture\n',
    );
    execFileSync('git', ['init', '-q', workspace]);
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
    const model = new RuntimeFixtureModel(
      nativeTaskJourneyFixture(requestsPath),
    );
    const controller = new RuntimeController({
      home,
      userHome: home,
      workspace,
      model,
      emit() {},
    });
    t.after(async () => {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    });
    const owner = controller.snapshot().activeSessionId;
    const call = async <T = unknown>(
      name: RuntimeCommand['name'],
      payload: Record<string, unknown> = {},
      sessionId = owner,
    ): Promise<T> => {
      const reply = await controller.dispatch({
        id: randomUUID(),
        name,
        sessionId,
        payload,
      });
      assert.equal(reply.ok, true, reply.error);
      return reply.data as T;
    };
    const tasks = () =>
      call<TaskRecord[]>('workspace-service', {
        service: 'tasks',
        method: 'list',
      });
    await call('prompt', { text: 'Prepare native journey' });
    await until(
      () =>
        controller.snapshot().sessions.find((session) => session.id === owner)
          ?.state === 'idle',
      'parent baseline',
    );
    await call('prompt', { text: 'hold parent while children run' });
    await until(() => model.requests.length === 2, 'held parent request');
    await call('workspace-service', {
      service: 'tasks',
      method: 'enqueue',
      params: {
        operationId: 'enqueue-three',
        tasks: [
          {
            id: 'A',
            prompt: 'JOURNEY_WRITE_A',
            access: 'write',
            acceptanceCriteria: ['Inspect actual file and git effects'],
          },
          {
            id: 'B',
            prompt: 'JOURNEY_WRITE_B',
            access: 'write',
            acceptanceCriteria: ['Inspect actual file and git effects'],
          },
          {
            id: 'R',
            prompt: 'JOURNEY_READ_ONLY',
            access: 'readonly',
            acceptanceCriteria: ['Inspect actual file and git effects'],
          },
        ],
      },
    });
    await until(async () => {
      const records = await tasks();
      return (
        records.find((record) => record.spec.id === 'A')?.state === 'waiting' &&
        records.find((record) => record.spec.id === 'B')?.state === 'waiting' &&
        records.find((record) => record.spec.id === 'R')?.state ===
          'needs_review'
      );
    }, 'two writers wait while readonly and its independent reviewer finish');
    const approvals: string[] = [];
    for (const id of order) {
      for (;;) {
        // Terminal state and pending approval are observed together. The final
        // verification phase legitimately has no pending interaction.
        let record!: TaskRecord;
        await until(async () => {
          record = (await tasks()).find((entry) => entry.spec.id === id)!;
          return (
            terminal(record) ||
            controller
              .snapshot()
              .interactions.some(
                (interaction) =>
                  interaction.sessionId === record.runtimeSessionId &&
                  interaction.status === 'pending',
              )
          );
        }, `${id}: terminal or approval`);
        if (terminal(record)) break;
        const interaction = controller
          .snapshot()
          .interactions.find(
            (entry) =>
              entry.sessionId === record.runtimeSessionId &&
              entry.status === 'pending',
          )!;
        approvals.push(`${id}:${interaction.tool ?? interaction.command}`);
        await call(
          'answer',
          {
            id: interaction.id,
            revision: interaction.revision,
            answer: 'approve',
          },
          record.runtimeSessionId,
        );
        await until(
          () =>
            !controller
              .snapshot()
              .interactions.some(
                (entry) =>
                  entry.id === interaction.id && entry.status === 'pending',
              ),
          'approval consumed',
        );
      }
    }
    const records = await tasks();
    assert.deepEqual(
      records.map((record) => record.state),
      ['needs_review', 'needs_review', 'needs_review'],
    );
    assert.equal(new Set(records.map((record) => record.worktree)).size, 3);
    assert.equal(approvals.filter((entry) => entry.startsWith('A:')).length, 2);
    assert.equal(approvals.filter((entry) => entry.startsWith('B:')).length, 1);
    assert.equal(
      await readFile(join(records[0].worktree!, 'agent-result.txt'), 'utf8'),
      'isolated task output\n',
    );
    assert.equal(
      await readFile(join(records[1].worktree!, 'agent-result.txt'), 'utf8'),
      'isolated task output\n',
    );
    await assert.rejects(readFile(join(workspace, 'agent-result.txt')), {
      code: 'ENOENT',
    });
    await assert.rejects(
      readFile(join(records[2].worktree!, 'agent-result.txt')),
      { code: 'ENOENT' },
    );
    assert.equal(model.requests.length, 14);
    assert.equal(
      model.requests.some((request) => request.fixture.error),
      false,
    );
    for (const record of records) {
      const worker = model.requests.filter(
        (request) =>
          request.fixture.role === 'worker' &&
          request.fixture.taskId === record.spec.id,
      );
      const reviewer = model.requests.filter(
        (request) =>
          request.fixture.role === 'reviewer' &&
          request.fixture.taskId === record.spec.id,
      );
      assert.equal(worker.length, 2);
      assert.equal(reviewer.length, 2);
      assert.equal(reviewer[0].fixture.workspace, worker[0].fixture.workspace);
      assert.notEqual(
        reviewer[0].fixture.conversationId,
        worker[0].fixture.conversationId,
      );
      assert.ok(
        reviewer[1].messages.some(
          (message) =>
            message.role === 'tool' &&
            message.status === 'success' &&
            message.content.includes(
              record.spec.access === 'write'
                ? 'isolated task output'
                : 'isolated routed fixture',
            ),
        ),
      );
      assert.ok(
        reviewer.every((request) =>
          request.tools.every(
            (tool) =>
              tool.effect === 'read' &&
              tool.name !== 'execute' &&
              tool.name !== 'task',
          ),
        ),
      );
      const artifacts = await call<TaskArtifact[]>('workspace-service', {
        service: 'tasks',
        method: 'artifacts',
        params: { id: record.spec.id },
      });
      const review = artifacts.find(
        (artifact) => artifact.kind === 'verification',
      )!;
      assert.ok(review, 'independent review is persisted as a real artifact');
      const saved = JSON.parse(await readFile(review.path, 'utf8'));
      assert.ok(
        saved.messages.some(
          (message: { role: string; status?: string }) =>
            message.role === 'tool' && message.status === 'success',
        ),
      );
    }
    const journal = (await readFile(requestsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 14);
    assert.equal(
      journal.filter((request) => request.fixture.role === 'reviewer').length,
      6,
    );
    assert.equal(
      controller.snapshot().sessions.find((session) => session.id === owner)
        ?.state,
      'waiting',
    );
  });
}

function request(
  content: string,
  signal = new AbortController().signal,
  id = randomUUID(),
): ModelRequest {
  return {
    system: '<env>\n  Working directory: /fixture\n</env>',
    messages: [{ id, role: 'user', content }],
    tools: [],
    signal,
    token() {},
  };
}
test('unmatched and exhausted routes are explicit and journaled; conversations cannot share cursors', async () => {
  const model = new RuntimeFixtureModel({
    routes: [
      {
        id: 'parent',
        match: { role: 'parent', firstUser: 'hello' },
        replies: [{ chunks: ['one', 'two'], delayMs: 1 }],
      },
    ],
  });
  const first = request('hello');
  assert.equal((await model.complete(first)).message.content, 'onetwo');
  assert.equal(
    (await model.complete(request('hello'))).message.content,
    'onetwo',
  );
  await assert.rejects(model.complete(first), /has no response at step 1/);
  await assert.rejects(model.complete(request('unmatched')), /found 0/);
  assert.equal(model.requests.length, 4);
  assert.match(model.requests[2].fixture.error!, /step 1/);
  assert.match(model.requests[3].fixture.error!, /found 0/);
});
test('legacy fixtures retain streaming and abort behavior without routed task identity', async () => {
  const model = new RuntimeFixtureModel({
    replies: [{ chunks: ['a', 'b'], delayMs: 1 }, { waitForAbort: true }],
  });
  const chunks: string[] = [];
  const initial = request('legacy');
  initial.token = (chunk) => chunks.push(chunk);
  await model.complete(initial);
  assert.deepEqual(chunks, ['a', 'b']);
  const abort = new AbortController();
  const pending = model.complete(request('hold', abort.signal));
  abort.abort(Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
  assert.equal(model.requests.length, 2);
});
