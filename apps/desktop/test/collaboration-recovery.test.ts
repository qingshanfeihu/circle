import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CollaborationScheduler,
  type TaskSpec,
} from '../src/workspace/collaboration.js';
import { TaskStore } from '../src/workspace/task-store.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
import { patience } from './helpers/patience.mjs';
const exec = promisify(execFile);
async function repository(path: string) {
  const git = (...args: string[]) => exec('git', ['-C', path, ...args]);
  await git('init', '--initial-branch=main');
  await writeFile(join(path, 'source.txt'), 'baseline\n');
  await git('add', 'source.txt');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  );
}
function task(
  id: string,
  workspace: string,
  dependencies: string[] = [],
): TaskSpec {
  return {
    id,
    workspace,
    prompt: `Execute ${id}`,
    access: 'write',
    acceptanceCriteria: ['actual effect is independently verified'],
    dependencies,
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + patience(5000);
  while (!check()) {
    if (Date.now() > deadline) throw Error('recovery fixture did not settle');
    await delay(5);
  }
}

test('an unresolved durable operation cannot become an accepted task or release dependents after a completion claim and restart', async (t) => {
  const workspace = scratch(t),
    data = scratch(t);
  await repository(workspace);
  let effects = 0,
    dependentRuns = 0;
  let scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (record, context) => {
      if (record.spec.id === 'dependent') {
        dependentRuns++;
        return { passed: true };
      }
      await context
        .runOperation('publish-once', { target: 'published.txt' }, async () => {
          effects++;
          await writeFile(
            join(context.worktree, 'published.txt'),
            'actual side effect happened\n',
          );
          throw Error('receipt lost after the actual write');
        })
        .catch(() => {});
      return { passed: true, result: { claim: 'everything passed' } };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue(
    [task('publisher', workspace), task('dependent', workspace, ['publisher'])],
    { operationId: 'publication' },
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(effects, 1);
  assert.equal(
    await readFile(
      join(scheduler.get('publisher')!.worktree!, 'published.txt'),
      'utf8',
    ),
    'actual side effect happened\n',
  );
  assert.equal(scheduler.get('publisher')!.state, 'needs_review');
  assert.equal(scheduler.get('dependent')!.state, 'blocked');
  assert.equal(dependentRuns, 0);
  const cursor = scheduler.eventsAfter().at(-1)!.cursor;
  await scheduler.close();
  const store = new TaskStore(join(data, 'collaboration.sqlite'));
  assert.equal(
    store.operations().find((entry) => entry.kind === 'task')?.state,
    'needs_review',
  );
  store.close();
  let resumedCalls = 0;
  scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async () => {
      resumedCalls++;
      return { passed: true };
    },
  });
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(resumedCalls, 0);
  assert.equal(effects, 1);
  assert.equal(scheduler.get('publisher')!.state, 'needs_review');
  assert.equal(scheduler.get('dependent')!.state, 'blocked');
  assert.deepEqual(scheduler.eventsAfter(cursor), []);
});

test('a synchronous terminal-event retry retains ownership of the new attempt until its cancellation and cleanup finish', async (t) => {
  const workspace = scratch(t),
    data = scratch(t);
  await repository(workspace);
  const release = gate();
  let secondSignal: AbortSignal | undefined,
    cleaned = false,
    retries = 0;
  const attempts: number[] = [];
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    limits: { agents: 2 },
    executor: async (record, context) => {
      attempts.push(record.attempt);
      if (record.attempt === 1)
        return { passed: false, reason: 'fixture requires another attempt' };
      secondSignal = context.signal;
      context.onCleanup(() => {
        cleaned = true;
      });
      const abort = () => release.resolve();
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        await release.promise;
      } finally {
        context.signal.removeEventListener('abort', abort);
      }
      return { passed: true };
    },
  });
  cleanup(t, async () => {
    release.resolve();
    if (secondSignal) await until(() => cleaned);
    await scheduler.close();
  });
  scheduler.subscribe((event) => {
    if (event.type === 'task.failed' && event.attempt === 1) {
      retries++;
      scheduler.retry('worker', { operationId: 'retry-from-terminal-event' });
    }
  });
  await scheduler.enqueue([task('worker', workspace)], {
    operationId: 'initial',
  });
  scheduler.start();
  await until(() => Boolean(secondSignal));
  const cancelled = await scheduler.cancel('worker');
  assert.equal(
    secondSignal!.aborted,
    true,
    'the new attempt keeps its actual controller rather than being deleted by old finally',
  );
  assert.equal(
    cleaned,
    true,
    'cancel acknowledges only after actual new-attempt cleanup',
  );
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.attempt, 2);
  assert.equal(retries, 1);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(
    scheduler.attempts('worker').map((entry) => entry.state),
    ['failed', 'cancelled'],
  );
});
