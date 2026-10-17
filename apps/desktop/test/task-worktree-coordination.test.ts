import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { cleanup, scratch } from '../../../tests/helpers.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { defaultSettings, trustFolder } from '../../../src/settings.ts';
import { CollaborationScheduler } from '../src/workspace/collaboration.ts';
import { serializeGitMutation } from '../src/workspace/git.ts';
import { TaskWorktrees } from '../src/workspace/task-worktrees.ts';
import { TaskIntegrator } from '../src/workspace/task-merge.ts';
import { createTaskVerifier } from '../src/workspace/task-verification.ts';
import {
  captureTaskChanges,
  createAgentTaskExecutor,
} from '../src/workspace/task-executor.ts';
import type { TaskRecord } from '../src/workspace/task-store.ts';
import { patience } from './helpers/patience.mjs';

const exec = promisify(execFile);
const gate = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => (release = resolve)),
    release: () => release(),
  };
};
async function git(root: string, ...args: string[]) {
  return (
    await exec('git', ['-C', root, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}
async function until(check: () => Promise<boolean>, reason: string) {
  const deadline = Date.now() + patience(10000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(reason);
    await delay(10);
  }
}
async function fixture(t: TestContext, oracle?: string) {
  const root = await realpath(scratch(t, 'circle-worktree-coordination-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await git(workspace, 'init', '--initial-branch=main');
  await git(workspace, 'config', 'core.autocrlf', 'false');
  await writeFile(join(workspace, 'value.txt'), 'base\n');
  await writeFile(
    join(workspace, 'oracle.cjs'),
    oracle ??
      "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'fixed\\n'); console.log('ACTUAL_ORACLE_PASS');",
  );
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node oracle.cjs' } }),
  );
  await git(workspace, 'add', 'value.txt', 'oracle.cjs', 'package.json');
  await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  );
  const baseline = await git(workspace, 'rev-parse', 'HEAD');
  const common = await realpath(
    resolve(workspace, await git(workspace, 'rev-parse', '--git-common-dir')),
  );
  const task: TaskRecord = {
    spec: {
      id: 'worker',
      workspace,
      baseline,
      access: 'write',
      prompt: 'fix the value',
      acceptanceCriteria: ['value is fixed'],
      dependencies: [],
    },
    state: 'running',
    attempt: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts);
  await writeFile(join(workspace, 'value.txt'), 'fixed\n');
  const verify = createTaskVerifier({
    workspace,
    dataDir: join(root, 'verification'),
    runtimeExecutable: process.execPath,
    checks: [{ criterion: 'value is fixed', script: 'test' }],
  });
  const signal = new AbortController();
  const context = {
    worktree: workspace,
    artifactDirectory: artifacts,
    signal: signal.signal,
    changes: await captureTaskChanges(task, workspace, artifacts),
    answer: 'claimed fixed',
    events: [],
    withResource: <T>(_name: string, run: () => Promise<T>) => run(),
  };
  return { root, workspace, common, baseline, task, verify, context, signal };
}

test('task, verifier and integration registration share the native common-repository mutation lock without blocking another repository', async (t) => {
  const f = await fixture(t);
  // A linked root has a different spelling and administrative directory but the
  // same shared repository identity as the original source root.
  const linked = join(f.root, 'linked-source');
  await git(f.workspace, 'worktree', 'add', '--detach', linked, f.baseline);
  const registrations = join(f.common, 'worktrees');
  const before = (await readdir(registrations)).sort();
  const locked = gate(),
    unlock = gate();
  const held = serializeGitMutation(f.common, async () => {
    locked.release();
    await unlock.promise;
  });
  await locked.promise;
  const manager = new TaskWorktrees(join(f.root, 'tasks'));
  const linkedTask: TaskRecord = {
    ...f.task,
    spec: { ...f.task.spec, workspace: linked, access: 'readonly' },
  };
  const integrator = new TaskIntegrator({
    workspace: f.workspace,
    dataDir: join(f.root, 'integration'),
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const task = manager.prepare(linkedTask);
  const integration = integrator.create(f.baseline);
  const verification = f.verify(f.task, f.context);
  const pending = Promise.all([task, integration, verification]);
  pending.catch(() => {});
  cleanup(t, async () => {
    unlock.release();
    await pending.catch(() => {});
  });
  let during!: string[];
  try {
    const unrelated = await fixture(t);
    const other = await new TaskWorktrees(
      join(unrelated.root, 'tasks'),
    ).prepare({
      ...unrelated.task,
      spec: { ...unrelated.task.spec, access: 'readonly' },
    });
    assert.equal(
      await git(other.path, 'rev-parse', 'HEAD'),
      unrelated.baseline,
      'an independent repository continues while the first is locked',
    );
    // Observe actual registry effects while the native mutation remains pending;
    // this interval is an intentional contention fixture, not a product deadline.
    await delay(100);
    during = (await readdir(registrations)).sort();
  } finally {
    unlock.release();
    await held;
  }
  const [prepared, integrated, checks] = await pending;
  assert.deepEqual(
    during,
    before,
    'no task/verifier/integration may register a worktree while native Git owns the same common repository',
  );
  assert.equal(await git(prepared.path, 'rev-parse', 'HEAD'), f.baseline);
  assert.equal(await git(integrated.path, 'rev-parse', 'HEAD'), f.baseline);
  assert(
    checks.some(
      (check) =>
        check.criterion === 'value is fixed' &&
        check.status === 'passed' &&
        check.exitCode === 0,
    ),
    'the real independent oracle runs after release',
  );
  assert.equal(
    await readFile(join(f.workspace, 'value.txt'), 'utf8'),
    'fixed\n',
    'source candidate bytes remain owned by the developer',
  );

  const removalLocked = gate(),
    removalRelease = gate();
  const removalHeld = serializeGitMutation(f.common, async () => {
    removalLocked.release();
    await removalRelease.promise;
  });
  await removalLocked.promise;
  const removal = manager.removeClean({
    ...linkedTask,
    worktree: prepared.path,
  });
  removal.catch(() => {});
  let retained!: boolean;
  try {
    await delay(100);
    retained = await exists(prepared.path);
  } finally {
    removalRelease.release();
    await removalHeld;
  }
  assert.equal(await removal, true);
  assert.equal(
    retained,
    true,
    'task removal also waits for the same native mutation',
  );
  assert.equal(await exists(prepared.path), false);
});

test('verification releases the repository while its oracle runs and reacquires it before removing the owned worktree', async (t) => {
  const control = await realpath(scratch(t, 'circle-verification-gate-'));
  const ready = join(control, 'ready'),
    release = join(control, 'release'),
    finished = join(control, 'finished');
  const oracle = `const fs=require('node:fs');(async()=>{require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8'),'fixed\\n');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));fs.writeFileSync(${JSON.stringify(finished)},'done');console.log('ACTUAL_ORACLE_PASS');})();`;
  const f = await fixture(t, oracle);
  const verifying = f.verify(f.task, f.context);
  verifying.catch(() => {});
  cleanup(t, async () => {
    f.signal.abort();
    await writeFile(release, 'cleanup');
    await verifying.catch(() => {});
  });
  await until(
    () => exists(ready),
    'actual verification oracle did not reach its gate',
  );
  const directory = (await readdir(join(f.root, 'verification'))).find((name) =>
    name.startsWith('verification-'),
  )!;
  const owned = join(f.root, 'verification', directory, 'workspace');
  const locked = gate(),
    unlock = gate();
  const held = serializeGitMutation(f.common, async () => {
    locked.release();
    await unlock.promise;
  });
  await locked.promise;
  let retained!: boolean;
  try {
    await writeFile(release, 'finish');
    await until(
      () => exists(finished),
      'actual verification oracle did not finish',
    );
    await delay(100);
    retained = await exists(owned);
  } finally {
    unlock.release();
    await held;
  }
  const checks = await verifying;
  assert.equal(
    retained,
    true,
    'verification worktree removal cannot overlap a native mutation',
  );
  assert.equal(
    await exists(owned),
    false,
    'the owned temporary worktree is removed after release',
  );
  assert(
    checks.some((check) => check.status === 'passed' && check.exitCode === 0),
  );
});

test('cancelling verification while the common repository is locked does not create a worktree after release', async (t) => {
  const f = await fixture(t);
  const locked = gate(),
    unlock = gate();
  const held = serializeGitMutation(f.common, async () => {
    locked.release();
    await unlock.promise;
  });
  await locked.promise;
  const verifying = f.verify(f.task, f.context);
  const rejected = assert.rejects(verifying, /abort/i);
  cleanup(t, async () => {
    f.signal.abort();
    unlock.release();
    await rejected;
  });
  try {
    await delay(100);
    f.signal.abort();
  } finally {
    unlock.release();
    await held;
  }
  await rejected;
  const registry = join(f.common, 'worktrees');
  assert.equal(
    (await exists(registry)) && (await readdir(registry)).length > 0,
    false,
    'no verification registration is added after the cancelled wait',
  );
  const checks = await f.verify(f.task, {
    ...f.context,
    signal: new AbortController().signal,
  });
  assert(
    checks.some((check) => check.status === 'passed' && check.exitCode === 0),
    'a later explicit verification still executes its actual oracle',
  );
});

test('cancelling an actual task waiting for repository registration creates no worktree and explicit retry dispatches exactly one model request', async (t) => {
  const f = await fixture(t);
  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: 'baseline inspected',
      },
    },
  ]);
  const home = join(f.root, 'runtime-home');
  await mkdir(home);
  const scheduler = new CollaborationScheduler({
    dataDir: join(f.root, 'scheduler'),
    executor: createAgentTaskExecutor({
      createRuntime: (_task, context) =>
        new AgentRuntime({
          workspace: context.worktree,
          home,
          userHome: home,
          model,
          settings: trustFolder(defaultSettings(), context.worktree),
          bundledExtensions: false,
          screenshot: false,
          headless: true,
        }),
      verify: async (_task, context) => {
        const actual = await readFile(
          join(context.worktree, 'value.txt'),
          'utf8',
        );
        assert.equal(actual, 'base\n');
        return [
          {
            criterion: 'baseline unchanged',
            status: 'passed',
            source: 'inspection',
            evidence: `Actual detached worktree bytes: ${JSON.stringify(actual)}`,
          },
        ];
      },
    }),
  });
  const locked = gate(),
    unlock = gate();
  cleanup(t, async () => {
    unlock.release();
    await scheduler.close();
  });
  const held = serializeGitMutation(f.common, async () => {
    locked.release();
    await unlock.promise;
  });
  await locked.promise;
  const id = 'cancel-before-registration';
  await scheduler.enqueue(
    [
      {
        ...f.task.spec,
        id,
        access: 'readonly',
        acceptanceCriteria: ['baseline unchanged'],
      },
    ],
    { operationId: 'enqueue-cancelled-task' },
  );
  scheduler.start();
  await until(
    async () => scheduler.get(id)?.state === 'preparing',
    'task did not begin preparing',
  );
  await delay(100);
  const cancellation = scheduler.cancel(id);
  cancellation.catch(() => {});
  unlock.release();
  await held;
  await cancellation;
  await scheduler.waitForIdle();
  const cancelled = scheduler.get(id)!;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(
    model.requests.length,
    0,
    'cancelled preparation never dispatches a model',
  );
  const registry = join(f.common, 'worktrees');
  const registrations = (await exists(registry)) ? await readdir(registry) : [];
  assert.deepEqual(
    registrations,
    [],
    'cancelled queue does not create any repository registration after the lock is released',
  );
  assert.equal(
    cancelled.worktree,
    undefined,
    'the cancelled attempt owns no uncreated worktree',
  );
  scheduler.retry(id, { operationId: 'explicit-retry' });
  await scheduler.waitForIdle();
  assert.equal(scheduler.get(id)!.attempt, 2);
  assert.equal(scheduler.get(id)!.state, 'succeeded');
  assert.equal(
    model.requests.length,
    1,
    'only the later explicit retry invokes the actual model',
  );
  assert.equal(
    await readFile(join(f.workspace, 'value.txt'), 'utf8'),
    'fixed\n',
    'the developer source remains untouched',
  );
});
