import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller';
import { ScriptedModel } from '../../../src/testing';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../../../src/types';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings';
import { agentState, isAgentActive } from '../../workbench/src/model/activity';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
} from '../src/runtime-protocol';
import { TaskStore, type TaskRecord } from '../src/workspace/task-store';
import { patience } from './helpers/patience.mjs';

const assistant = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({ id: randomUUID(), role: 'assistant', content, tool_calls });
async function until(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + patience(8000);
  while (!(await check())) {
    if (Date.now() > until) throw Error('reviewer fixture timed out');
    await delay(10);
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    wait: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    },
  };
}
test('the real reviewer is durably identified before its request and owns read-only sources independently of the finished worker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-real-reviewer-')),
    home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(root, 'project'));
  const workspace = await realpath(join(root, 'project'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(workspace, 'value.txt'), 'baseline\n');
  await writeFile(join(workspace, 'other.txt'), 'original\n');
  git('add', 'value.txt', 'other.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  );
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const held = gate();
  let entered = false,
    firstRequestLedger: TaskRecord | undefined;
  let reviewerReadNext = false;
  const ledgerPath = join(
    home,
    'collaboration',
    createHash('sha256').update(workspace).digest('hex').slice(0, 24),
    'collaboration.sqlite',
  );
  const handler = async (request: ModelRequest): Promise<ModelResponse> => {
    const user =
        request.messages.find((message) => message.role === 'user')?.content ??
        '',
      done = request.messages.some((message) => message.role === 'tool');
    if (user.startsWith('Task '))
      return {
        message: done
          ? assistant('worker completed actual write')
          : assistant('', [
              {
                id: 'worker-write',
                name: 'write_file',
                args: { file_path: 'value.txt', content: 'changed\n' },
              },
            ]),
        usage: emptyUsage(),
      };
    assert.ok(user.startsWith('Independently review'));
    if (!done) {
      const db = new DatabaseSync(ledgerPath, { readOnly: true });
      try {
        firstRequestLedger = JSON.parse(
          String(
            db.prepare('SELECT record FROM tasks WHERE id=?').get('candidate')!
              .record,
          ),
        );
      } finally {
        db.close();
      }
      entered = true;
      await held.wait(request.signal);
      return {
        message: assistant('', [
          {
            id: 'review-read',
            name: 'read_file',
            args: { file_path: 'value.txt' },
          },
        ]),
        usage: emptyUsage(),
      };
    }
    reviewerReadNext = request.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'review-read' &&
        message.content.includes('changed'),
    );
    return {
      message: assistant(
        JSON.stringify({
          checks: [
            {
              criterion: 'candidate contains changed bytes',
              status: 'passed',
              evidence: 'read actual changed bytes',
              sources: [{ path: 'value.txt', line: 1 }],
            },
          ],
        }),
      ),
      usage: emptyUsage(),
    };
  };
  const model = new ScriptedModel(Array(12).fill(handler));
  const updates: RuntimeUpdate[] = [];
  const options = {
    home,
    workspace,
    userHome: home,
    model,
    emit(update: RuntimeUpdate) {
      updates.push(update);
    },
  };
  let controller = new RuntimeController(options);
  t.after(async () => {
    held.release();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const parent = controller.snapshot().activeSessionId;
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = parent,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const service = (
    service: string,
    method: string,
    params: Record<string, unknown> = {},
    sessionId = parent,
  ) => call('workspace-service', { service, method, params }, sessionId);
  assert.equal(
    (
      await service('tasks', 'enqueue', {
        operationId: 'candidate',
        tasks: [
          {
            id: 'candidate',
            prompt: 'Update candidate bytes',
            access: 'write',
            acceptanceCriteria: ['candidate contains changed bytes'],
          },
        ],
      })
    ).ok,
    true,
  );
  await until(() =>
    controller.snapshot().interactions.some((row) => row.status === 'pending'),
  );
  const approval = controller
    .snapshot()
    .interactions.find((row) => row.status === 'pending')!;
  assert.equal(
    (
      await call(
        'answer',
        { id: approval.id, revision: approval.revision, answer: 'approve' },
        approval.sessionId,
      )
    ).ok,
    true,
  );
  await until(() => entered);
  const durable = firstRequestLedger!;
  assert.equal(durable.runtimeState, 'succeeded');
  assert.equal(durable.state, 'running');
  assert.equal(durable.reviewers?.length, 1);
  const reviewer = durable.reviewers![0]!;
  assert.notEqual(reviewer.sessionId, durable.runtimeSessionId);
  assert.equal(reviewer.state, 'running');
  assert.equal(reviewer.workspace, await realpath(durable.worktree!));
  assert.equal(reviewer.baseline, durable.spec.baseline);
  assert.equal(reviewer.head, git('rev-parse', 'HEAD'));
  assert.match(reviewer.patchSha256, /^[0-9a-f]{64}$/);
  const agents = controller
    .snapshot()
    .agents.filter((agent) => agent.sessionId === parent);
  assert.equal(agents.length, 2);
  const workerAgent = agents.find(
      (agent) => agent.id === durable.runtimeSessionId,
    )!,
    reviewAgent = agents.find((agent) => agent.id === reviewer.sessionId)!;
  assert.equal(workerAgent.task!.state, 'running');
  assert.equal(agentState(workerAgent), 'completed');
  assert.equal(isAgentActive(workerAgent), false);
  assert.equal(reviewAgent.task!.role, 'reviewer');
  assert.equal(agentState(reviewAgent), 'running');
  assert.equal(isAgentActive(reviewAgent), true);
  assert.equal(reviewAgent.readOnly, true);
  assert.equal(reviewAgent.resourceSessionId, reviewer.sessionId);
  assert.equal(reviewAgent.workspaceId, workerAgent.workspaceId);
  assert.notEqual(reviewAgent.name, workerAgent.name);
  assert.match(reviewAgent.name, /^review:/);
  await delay(0);
  assert.equal(
    updates
      .at(-1)!
      .snapshot.agents.find((agent) => agent.id === reviewer.sessionId)?.task
      ?.runtimeState,
    'running',
    'reviewer identity reaches the original renderer while the model is held',
  );
  assert.equal(
    agentState(
      updates
        .at(-1)!
        .snapshot.agents.find(
          (agent) => agent.id === durable.runtimeSessionId,
        )!,
    ),
    'completed',
  );
  const childRead = await service(
    'documents',
    'read',
    { path: 'value.txt' },
    reviewer.sessionId,
  );
  assert.equal(childRead.ok, true, childRead.error);
  assert.equal((childRead.data as any).content, 'changed\n');
  const parentRead = await service('documents', 'read', { path: 'value.txt' });
  assert.equal((parentRead.data as any).content, 'baseline\n');
  for (const method of ['save', 'applyEdits']) {
    const denied = await service(
      'documents',
      method,
      {
        path: 'value.txt',
        content: 'illegal',
        expectedRevision: (childRead.data as any).revision,
        changes: [],
      },
      reviewer.sessionId,
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /read-only agent/);
  }
  const parentOther = await service('documents', 'read', { path: 'other.txt' });
  const parentSave = await service('documents', 'save', {
    path: 'other.txt',
    content: 'human saved\n',
    expectedRevision: (parentOther.data as any).revision,
  });
  assert.equal(parentSave.ok, true, parentSave.error);
  assert.equal(
    await readFile(join(workspace, 'other.txt'), 'utf8'),
    'human saved\n',
  );
  assert.equal(model.requests.length, 3);
  held.release();
  await until(async () => {
    const response = await service('tasks', 'list');
    return (response.data as TaskRecord[])[0]?.state === 'succeeded';
  });
  const finished = ((await service('tasks', 'list')).data as TaskRecord[])[0]!;
  assert.equal(reviewerReadNext, true);
  assert.equal(model.requests.length, 4);
  assert.equal(finished.runtimeSessionId, durable.runtimeSessionId);
  assert.equal(finished.runtimeState, 'succeeded');
  assert.equal(finished.reviewers![0]!.state, 'succeeded');
  await delay(0);
  const emittedReviewer = updates
    .at(-1)!
    .snapshot.agents.find((agent) => agent.id === reviewer.sessionId)!;
  assert.ok(
    emittedReviewer,
    'completion projects the actual reviewer to the original renderer',
  );
  assert.equal(
    emittedReviewer.task!.state,
    'succeeded',
    'completion must reach the existing renderer snapshot without a new user command',
  );
  assert.equal(agentState(emittedReviewer), 'completed');
  const artifact = finished.reviewers![0]!.artifact!;
  const bytes = await readFile(artifact.path);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    artifact.sha256,
  );
  const provenance = JSON.parse(bytes.toString()).provenance;
  assert.equal(provenance.role, 'reviewer');
  assert.equal(provenance.workerSessionId, finished.runtimeSessionId);
  assert.equal(provenance.sessionId, reviewer.sessionId);
  assert.equal(provenance.taskId, 'candidate');
  assert.equal(provenance.attempt, 1);
  assert.equal(provenance.ownerSessionId, parent);
  assert.equal(provenance.workspace, reviewer.workspace);
  assert.equal(provenance.patchSha256, reviewer.patchSha256);
  assert.equal((finished.result as any).changes.sha256, reviewer.patchSha256);
  assert.equal(
    await readFile(join(workspace, 'value.txt'), 'utf8'),
    'baseline\n',
  );
  assert.equal(
    await readFile(join(reviewer.workspace, 'value.txt'), 'utf8'),
    'changed\n',
  );
  const artifacts = (await service('tasks', 'artifacts', { id: 'candidate' }))
    .data as any[];
  assert.equal(
    artifacts.filter((item) => item.path === artifact.path).length,
    1,
  );
  assert.equal(
    artifacts.find((item) => item.id === artifact.id).baseline,
    reviewer.baseline,
  );
  await controller.close();
  const requests = model.requests.length;
  controller = new RuntimeController(options);
  const restored = controller
    .snapshot()
    .agents.filter((agent) => agent.sessionId === parent);
  assert.equal(restored.length, 2);
  assert.equal(
    restored.find((agent) => agent.id === reviewer.sessionId)!.task!.role,
    'reviewer',
  );
  assert.ok(restored.every((agent) => !isAgentActive(agent)));
  const rejected = await service(
    'documents',
    'save',
    {
      path: 'value.txt',
      content: 'illegal after restart',
      expectedRevision: (childRead.data as any).revision,
    },
    reviewer.sessionId,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error!, /read-only agent/);
  assert.equal(model.requests.length, requests);
  await controller.close();
  // A deterministic persisted in-flight boundary: reading the archive must not
  // rewrite it or silently start a second reviewer after application restart.
  const store = new TaskStore(ledgerPath);
  const unfinished = store.get('candidate')!;
  unfinished.state = 'running';
  unfinished.reviewers![0]!.state = 'running';
  store.put(unfinished);
  store.close();
  controller = new RuntimeController(options);
  const history = controller
    .snapshot()
    .agents.filter((agent) => agent.sessionId === parent);
  const oldWorker = history.find(
      (agent) => agent.id === finished.runtimeSessionId,
    )!,
    oldReviewer = history.find((agent) => agent.id === reviewer.sessionId)!;
  assert.equal(oldWorker.task!.runtimeState, 'succeeded');
  assert.equal(oldWorker.task!.recovery, undefined);
  assert.equal(agentState(oldWorker), 'completed');
  assert.equal(oldReviewer.task!.runtimeState, 'running');
  assert.equal(oldReviewer.task!.recovery, 'needs_reconciliation');
  assert.equal(agentState(oldReviewer), 'needs_review');
  assert.equal(isAgentActive(oldReviewer), false);
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const untouched = JSON.parse(
      String(
        db.prepare('SELECT record FROM tasks WHERE id=?').get('candidate')!
          .record,
      ),
    );
    assert.equal(untouched.reviewers[0].state, 'running');
    assert.equal(untouched.state, 'running');
  } finally {
    db.close();
  }
  assert.equal(model.requests.length, requests);
});
