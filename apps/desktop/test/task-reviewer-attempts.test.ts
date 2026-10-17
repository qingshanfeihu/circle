import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../src/workspace/task-service.js';
import { TaskStore } from '../src/workspace/task-store.js';
import type { TaskExecutionContext } from '../src/workspace/collaboration.js';
import { AgentRuntime } from '../../../src/runtime.js';
import { ScriptedModel } from '../../../src/testing.js';
import { defaultSettings, trustFolder } from '../../../src/settings.js';
import { cleanup, scratch } from '../../../tests/helpers.js';

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function until(check: () => boolean) {
  // Worktrees and Git are slow on Windows and Intel macOS runners.
  const deadline = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('reviewer fixture did not settle');
    await delay(5);
  }
}
function repository(path: string) {
  git(path, 'init', '-q');
  writeFileSync(join(path, 'source.txt'), 'actual baseline\n');
  git(path, 'add', 'source.txt');
  git(
    path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  );
}

test('deferred reviewer callbacks update their captured attempt and immutable scoped copies, never retry latest', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  repository(workspace);
  const contexts: TaskExecutionContext[] = [];
  const reviewerInputs: Parameters<
    NonNullable<TaskExecutionContext['reviewer']>
  >[0][] = [];
  let modelStarts = 0;
  const models: ScriptedModel[] = [];
  const service = new TaskService({
    workspace,
    dataDir,
    emit() {},
    autoStart: false,
    async createRuntime(record, ctx) {
      contexts.push(ctx);
      const artifactPath = join(
        ctx.artifactDirectory,
        `review-${record.attempt}.txt`,
      );
      // The task artifact directory exists before invoking this runtime factory.
      writeFileSync(artifactPath, 'actual reviewer evidence\n');
      const artifact = await ctx.artifact(artifactPath, 'verification');
      const input = {
        sessionId: `review-${record.attempt}`,
        workspace: ctx.worktree,
        baseline: record.spec.baseline!,
        head: git(ctx.worktree, 'rev-parse', 'HEAD'),
        patchSha256: sha(git(ctx.worktree, 'diff', '--binary', 'HEAD')),
        state: 'running' as const,
        artifact: {
          id: artifact.id,
          path: artifact.path,
          sha256: artifact.sha256,
        },
      };
      reviewerInputs.push(input);
      ctx.reviewer!(input);
      modelStarts++;
      const home = join(dataDir, `home-${record.attempt}`);
      const model = new ScriptedModel([
        {
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: 'actual scripted runtime response',
          },
        },
      ]);
      models.push(model);
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        approve: async () => 'approve',
      });
    },
    verify: async () => [],
  });
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'enqueue',
    tasks: [
      {
        id: 'work',
        prompt: 'inspect source',
        access: 'readonly',
        acceptanceCriteria: ['independent review'],
      },
    ],
  });
  await service.call('owner', 'start');
  await until(() => service.getTask('work')?.state === 'needs_review');
  await service.call('owner', 'retry', { id: 'work', operationId: 'retry' });
  await until(
    () =>
      contexts.length === 2 &&
      service.getTask('work')?.state === 'needs_review',
  );
  assert.throws(
    () =>
      contexts[0]!.reviewer!({ ...reviewerInputs[0]!, workspace: scratch(t) }),
    /invalid reviewer provenance/,
  );
  assert.throws(
    () =>
      contexts[0]!.reviewer!({
        ...reviewerInputs[0]!,
        artifact: {
          ...reviewerInputs[0]!.artifact!,
          id: 'unregistered-reference',
        },
      }),
    /artifact|provenance/,
  );
  contexts[0]!.reviewer!({
    ...reviewerInputs[0]!,
    state: 'failed',
    reason: 'late first attempt review',
  });
  contexts[0]!.runtimeState!('waiting');
  const attempts = service.taskAttempts('owner');
  assert.equal(modelStarts, 2);
  assert.deepEqual(
    models.map((model) => model.requests.length),
    [1, 1],
  );
  assert.ok(
    models[0]!.requests[0]!.messages.some((message) => message.role === 'user'),
  );
  assert.deepEqual(
    attempts.map((r) => r.attempt),
    [1, 2],
  );
  assert.equal(attempts[0]!.reviewers![0]!.state, 'failed');
  assert.equal(attempts[0]!.runtimeState, 'waiting');
  assert.equal(attempts[1]!.reviewers![0]!.sessionId, 'review-2');
  assert.equal(attempts[1]!.reviewers![0]!.state, 'running');
  assert.notEqual(attempts[1]!.runtimeState, 'waiting');
  assert.equal(service.getTask('work')!.attempt, 2);
  assert.deepEqual(service.taskAttempts('foreign-owner'), []);
  const reviewer = attempts[0]!.reviewers![0]!;
  assert.throws(() => {
    reviewer.workspace = workspace;
  }, TypeError);
  assert.throws(() => {
    reviewer.artifact!.sha256 = 'tampered';
  }, TypeError);
  assert.throws(() => {
    attempts[0]!.reviewers!.push(reviewer);
  }, TypeError);
  assert.equal(
    service.taskAttempts('owner')[0]!.reviewers![0]!.artifact!.sha256,
    sha('actual reviewer evidence\n'),
  );
});

test('legacy no-reviewer records reopen, while persisted in-flight reviewers are interrupted without replay', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  repository(workspace);
  let starts = 0;
  const options = {
    workspace,
    dataDir,
    autoStart: false,
    emit() {},
    createRuntime() {
      starts++;
      throw Error('replay is forbidden');
    },
  };
  let service = new TaskService(options);
  await service.call('owner', 'enqueue', {
    operationId: 'seed',
    tasks: [
      {
        id: 'legacy',
        prompt: 'legacy queued task',
        access: 'readonly',
        acceptanceCriteria: ['review'],
      },
    ],
  });
  const legacy = service.getTask('legacy')!;
  await service.close();
  const store = new TaskStore(join(dataDir, 'collaboration.sqlite'));
  const interrupted = {
    ...legacy,
    spec: { ...legacy.spec, id: 'inflight' },
    state: 'waiting' as const,
    runtimeState: 'running' as const,
    worktree: workspace,
    reviewers: [
      {
        sessionId: 'review-inflight',
        workspace,
        baseline: legacy.spec.baseline!,
        head: git(workspace, 'rev-parse', 'HEAD'),
        patchSha256: sha(''),
        state: 'waiting' as const,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  store.put(interrupted);
  store.close();
  service = new TaskService(options);
  cleanup(t, () => service.close());
  assert.equal(service.getTask('legacy')!.reviewers, undefined);
  const record = service.getTask('inflight')!;
  assert.equal(record.state, 'interrupted');
  assert.equal(record.runtimeState, 'interrupted');
  assert.equal(record.reviewers![0]!.state, 'interrupted');
  assert.match(record.reviewers![0]!.reason!, /previous process ended/);
  assert.equal(record.reviewers![0]!.head, interrupted.reviewers[0]!.head);
  // Cancel the legacy queued record before starting: restart must not replay in-flight work.
  await service.call('owner', 'cancel', { id: 'legacy' });
  await service.call('owner', 'start');
  await delay(30);
  assert.equal(starts, 0);
});
