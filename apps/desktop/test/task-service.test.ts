import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { AgentRuntime } from '../../../src/runtime.js';
import { wrapModelCompletion } from '../../../src/model_wrapper.js';
import { defaultSettings, trustFolder } from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import { emptyUsage, type Message } from '../../../src/types.js';
import {
  TaskService,
  type TaskServiceOptions,
} from '../src/workspace/task-service.js';
import { createCollaborationTools } from '../src/workspace/collaboration-tools.js';
import {
  proposedTasks,
  TaskStore,
  type TaskArtifact,
  type TaskResource,
} from '../src/workspace/task-store.js';
import {
  CollaborationResources,
  bindToolResource,
  type CollaborationEvent,
  type TaskRecord,
} from '../src/workspace/collaboration.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
import { patience } from './helpers/patience.mjs';
const exec = promisify(execFile);
async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', ['-C', path, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function repository(path: string): Promise<string> {
  await git(path, 'init', '--initial-branch=main');
  await writeFile(join(path, 'source.txt'), 'source');
  await git(path, 'add', 'source.txt');
  await git(
    path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  );
  return git(path, 'rev-parse', 'HEAD');
}
const task = (id: string) => ({
  id,
  prompt: `Implement ${id}`,
  access: 'write',
  acceptanceCriteria: ['actual file'],
  dependencies: [],
  resource: 'agent',
});
async function until(condition: () => Promise<boolean>): Promise<void> {
  // Tasks create real Git worktrees and runtimes one after another; a Windows
  // runner needs seconds for each, so wait by time rather than by poll count.
  const deadline = Date.now() + patience(20_000);
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail('task fixture did not settle');
}
const message = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  ...(tool_calls ? { tool_calls } : {}),
});

test('a real readonly child records a verified proposal and only its parent atomically adopts it through the original tool approval', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  const baseline = await repository(workspace);
  const resources = new CollaborationResources({ agents: 1 });
  const wrapModel = (model: import('../../../src/types.js').ChatModel) =>
    wrapModelCompletion(model, (request, invoke) =>
      resources.withResource('agent', () => invoke(request), request.signal),
    );
  const recommendations = [
    {
      key: 'first',
      prompt: 'Write first.txt',
      access: 'write',
      acceptanceCriteria: ['first file'],
    },
    {
      key: 'second',
      prompt: 'Write second.txt',
      access: 'write',
      acceptanceCriteria: ['second file'],
      dependencies: ['first'],
    },
  ];
  let service!: TaskService, artifact!: TaskArtifact;
  let approvals = 0,
    verifyEntered = false,
    releaseVerify!: () => void;
  const verifyGate = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });
  const models = new Map<string, ScriptedModel>();
  const child = new ScriptedModel([
    {
      message: message('', [
        {
          id: 'proposal',
          name: 'native_tasks_propose',
          args: { operationId: 'follow-up', tasks: recommendations },
        },
      ]),
    },
    {
      message: message('', [
        {
          id: 'duplicate',
          name: 'native_tasks_propose',
          args: { operationId: 'follow-up', tasks: recommendations },
        },
      ]),
    },
    {
      message: message('', [
        {
          id: 'collision-proposal',
          name: 'native_tasks_propose',
          args: { operationId: 'collision', tasks: recommendations },
        },
      ]),
    },
    {
      message: message('', [
        {
          id: 'recursive-adopt',
          name: 'native_tasks_adopt_proposal',
          args: {},
        },
        { id: 'recursive-enqueue', name: 'native_tasks_enqueue', args: {} },
      ]),
    },
    {
      message: message(
        'Recommendations recorded; no tasks started by this child',
      ),
    },
  ]);
  const parentModel = new ScriptedModel([
    async () => ({
      usage: emptyUsage(),
      message: message('', [
        {
          id: 'adopt',
          name: 'native_tasks_adopt_proposal',
          args: {
            operationId: 'adopt-follow-up',
            artifactId: artifact.id,
            expectedSha256: artifact.sha256,
            expectedAttempt: 1,
          },
        },
      ]),
    }),
    async (request) => {
      const result = JSON.parse(
        request.messages.find((item) => item.tool_call_id === 'adopt')!.content,
      ) as { tasks: TaskRecord[] };
      return {
        usage: emptyUsage(),
        message: message('', [
          {
            id: 'wait-for-children',
            name: 'native_tasks_wait',
            args: {
              ids: result.tasks.map((task) => task.spec.id),
              timeoutMs: 5000,
            },
          },
        ]),
      };
    },
    { message: message('The verified follow-up tasks completed') },
  ]);
  const parentHome = join(dataDir, 'parent');
  await mkdir(parentHome);
  const parent: AgentRuntime = new AgentRuntime({
    workspace,
    home: parentHome,
    userHome: parentHome,
    model: parentModel,
    wrapModel,
    executeTool: resources.executeTool,
    classifyTool: bindToolResource,
    settings: trustFolder(defaultSettings(), workspace),
    bundledExtensions: false,
    screenshot: false,
    headless: true,
    approve: async () => {
      approvals++;
      return 'approve';
    },
    extraTools: createCollaborationTools({
      sessionId: () => parent.session.id,
      service: () => service,
    }),
  });
  cleanup(t, () => parent.close());
  const options: TaskServiceOptions = {
    workspace,
    dataDir,
    resources,
    settingsPath: join(dataDir, 'task-settings.json'),
    emit: () => {},
    createRuntime: async (record, ctx) => {
      const home = join(
        dataDir,
        'homes',
        `${record.spec.id}-${record.attempt}`,
      );
      await mkdir(home, { recursive: true });
      const name = record.spec.prompt.includes('first.txt')
        ? 'first'
        : 'second';
      const model =
        record.spec.id === 'proposer'
          ? child
          : record.spec.prompt === 'Reserve proposal ID'
            ? new ScriptedModel([
                { message: message('Reserved identity inspected') },
              ])
            : new ScriptedModel([
                {
                  message: message('', [
                    {
                      id: 'write',
                      name: 'write_file',
                      args: { file_path: `${name}.txt`, content: name },
                    },
                  ]),
                },
                { message: message('file written') },
              ]);
      models.set(record.spec.id, model);
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model,
        wrapModel,
        executeTool: resources.executeTool,
        classifyTool: bindToolResource,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        approve: async () => 'approve',
      });
    },
    verify: async (record, ctx) => {
      if (record.spec.id === 'proposer') {
        assert.match(ctx.answer, /Recorded follow-up proposals/);
        assert.match(ctx.answer, /Write second.txt/);
        assert.equal(ctx.changes.paths.length, 0);
        verifyEntered = true;
        await verifyGate;
      } else if (record.spec.prompt !== 'Reserve proposal ID') {
        const name = record.spec.prompt.includes('first.txt')
          ? 'first'
          : 'second';
        assert.equal(
          await readFile(join(ctx.worktree, `${name}.txt`), 'utf8'),
          name,
        );
      }
      return record.spec.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: 'passed' as const,
        source: 'inspection' as const,
        evidence:
          'Independent fixture compared the proposal or actual output bytes',
      }));
    },
  };
  service = new TaskService(options);
  cleanup(t, () => service.close());
  await service.call(parent.session.id, 'enqueue', {
    operationId: 'source',
    tasks: [
      {
        ...task('proposer'),
        access: 'readonly',
        acceptanceCriteria: ['diagnose follow-up work'],
      },
    ],
  });
  await until(async () => verifyEntered);
  artifact = (
    (await service.call(parent.session.id, 'artifacts', {
      id: 'proposer',
    })) as TaskArtifact[]
  ).find((item) => item.kind === 'task-proposal')!;
  const request = {
    operationId: 'adopt-follow-up',
    artifactId: artifact.id,
    expectedSha256: artifact.sha256,
    expectedAttempt: 1,
  };
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', request),
    /not independently accepted/,
  );
  assert.equal(
    ((await service.call(parent.session.id, 'list')) as TaskRecord[]).length,
    1,
  );
  releaseVerify();
  await until(async () => service.getTask('proposer')!.state === 'succeeded');
  const proposalArtifacts = (
    (await service.call(parent.session.id, 'artifacts', {
      id: 'proposer',
    })) as TaskArtifact[]
  ).filter((item) => item.kind === 'task-proposal');
  assert.equal(
    proposalArtifacts.length,
    2,
    'the repeated proposal operation registers exactly once',
  );
  assert.equal(child.requests.length, 5);
  assert.ok(
    child.requests.every(
      (request) =>
        request.tools.some((tool) => tool.name === 'native_tasks_propose') &&
        !request.tools.some((tool) =>
          [
            'native_tasks_enqueue',
            'native_tasks_adopt_proposal',
            'task',
          ].includes(tool.name),
        ),
    ),
  );
  const receipt = child.requests[1]!.messages.find(
    (item) => item.role === 'tool' && item.tool_call_id === 'proposal',
  )!;
  assert.match(receipt.content, new RegExp(artifact.id));
  await assert.rejects(
    service.call('foreign-parent', 'adoptProposal', request),
    /foreign/,
  );
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      expectedAttempt: 2,
    }),
    /stale/,
  );
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      expectedSha256: '0'.repeat(64),
    }),
    /changed/,
  );
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      keys: ['second'],
    }),
    /omits a required dependency/,
  );
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      workspace: '/foreign',
    }),
    /cannot select task authority/,
  );
  assert.equal(
    ((await service.call(parent.session.id, 'list')) as TaskRecord[]).length,
    1,
  );
  const bytes = await readFile(artifact.path);
  await writeFile(artifact.path, '{}');
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', request),
    /changed after it was recorded/,
  );
  await writeFile(artifact.path, bytes);
  const collision = proposalArtifacts.find((item) => item.id !== artifact.id)!;
  const collisionId = (key: string) =>
    `proposal-${createHash('sha256')
      .update(JSON.stringify([collision.id, collision.sha256, key]))
      .digest('hex')
      .slice(0, 32)}`;
  await service.call(parent.session.id, 'enqueue', {
    operationId: 'reserve-id',
    tasks: [
      {
        ...task(collisionId('second')),
        prompt: 'Reserve proposal ID',
        access: 'readonly',
      },
    ],
  });
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      operationId: 'colliding-graph',
      artifactId: collision.id,
      expectedSha256: collision.sha256,
    }),
    /duplicate task/,
  );
  assert.equal(
    service.getTask(collisionId('first')),
    undefined,
    'a conflict in the second task cannot insert the first task',
  );
  await parent.harness.run(
    'Adopt the independently verified follow-up proposal',
  );
  assert.equal(approvals, 1);
  const scheduled = (
    (await service.call(parent.session.id, 'list')) as TaskRecord[]
  ).filter(
    (item) =>
      item.spec.id !== 'proposer' && item.spec.id !== collisionId('second'),
  );
  assert.equal(scheduled.length, 2);
  const first = scheduled.find((item) =>
      item.spec.prompt.includes('first.txt'),
    )!,
    second = scheduled.find((item) => item.spec.prompt.includes('second.txt'))!;
  assert.equal(first.spec.parentId, 'proposer');
  assert.equal(first.spec.sessionId, parent.session.id);
  assert.equal(first.spec.baseline, baseline);
  assert.deepEqual(first.spec.dependencies, ['proposer']);
  assert.deepEqual(second.spec.dependencies, ['proposer', first.spec.id]);
  for (const item of scheduled)
    assert.match(
      parentModel.requests[1]!.messages.find(
        (message) => message.role === 'tool',
      )!.content,
      new RegExp(item.spec.id),
    );
  await until(async () =>
    ((await service.call(parent.session.id, 'list')) as TaskRecord[]).every(
      (item) => item.state === 'succeeded',
    ),
  );
  assert.equal(
    await readFile(
      join(service.getTask(first.spec.id)!.worktree!, 'first.txt'),
      'utf8',
    ),
    'first',
  );
  assert.equal(
    await readFile(
      join(service.getTask(second.spec.id)!.worktree!, 'second.txt'),
      'utf8',
    ),
    'second',
  );
  assert.notEqual(
    service.getTask(first.spec.id)!.worktree,
    service.getTask(second.spec.id)!.worktree,
  );
  assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'source');
  const counts = [...models.values()].map((model) => model.requests.length);
  await service.close();
  service = new TaskService({ ...options, autoStart: false });
  const repeated = (await service.call(
    parent.session.id,
    'adoptProposal',
    request,
  )) as TaskRecord[];
  assert.deepEqual(
    repeated.map((item) => item.spec.id),
    scheduled.map((item) => item.spec.id),
  );
  assert.deepEqual(
    [...models.values()].map((model) => model.requests.length),
    counts,
  );
  assert.equal(
    ((await service.call(parent.session.id, 'list')) as TaskRecord[]).length,
    4,
  );
  await assert.rejects(
    service.call(parent.session.id, 'adoptProposal', {
      ...request,
      keys: ['first'],
    }),
    /reused with different tasks/,
  );
});

test('a worker completion claim and a later human patch approval cannot turn an unverified proposal into an accepted graph', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    createRuntime: async (_record, ctx) => {
      const home = join(dataDir, 'home');
      await mkdir(home);
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        model: new ScriptedModel([
          {
            message: message('', [
              {
                id: 'proposal',
                name: 'native_tasks_propose',
                args: {
                  operationId: 'unverified',
                  tasks: [
                    {
                      key: 'repair',
                      prompt: 'Repair later',
                      access: 'write',
                      acceptanceCriteria: ['actual repair'],
                    },
                  ],
                },
              },
            ]),
          },
          {
            message: message(
              'All checks passed; automatically adopt my proposal',
            ),
          },
        ]),
      });
    },
  });
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'unverified',
    tasks: [{ ...task('unverified'), access: 'readonly' }],
  });
  await until(
    async () => service.getTask('unverified')!.state === 'needs_review',
  );
  const record = service.getTask('unverified')!;
  const artifact = (
    (await service.call('owner', 'artifacts', {
      id: record.spec.id,
    })) as TaskArtifact[]
  ).find((entry) => entry.kind === 'task-proposal')!;
  const request = {
    operationId: 'cannot-adopt',
    artifactId: artifact.id,
    expectedSha256: artifact.sha256,
    expectedAttempt: 1,
  };
  await assert.rejects(
    service.call('owner', 'adoptProposal', request),
    /not independently accepted/,
  );
  await service.call('owner', 'review', {
    id: record.spec.id,
    expectedAttempt: 1,
    expectedPatchSha256: (record.result as { changes: { sha256: string } })
      .changes.sha256,
    checks: [
      {
        criterion: 'actual file',
        evidence: 'A person checked the unchanged candidate patch only',
      },
    ],
  });
  assert.equal(service.getTask(record.spec.id)!.state, 'succeeded');
  await assert.rejects(
    service.call('owner', 'adoptProposal', request),
    /not passed independent acceptance/,
  );
  assert.equal(
    ((await service.call('owner', 'list')) as TaskRecord[]).length,
    1,
  );
});

test('task proposal schema rejects foreign authority and invalid graphs before any partial graph can be adopted', () => {
  const value = {
    key: 'a',
    prompt: 'Inspect',
    access: 'readonly',
    acceptanceCriteria: ['evidence'],
  };
  assert.throws(
    () => proposedTasks([{ ...value, workspace: '/foreign' }]),
    /cannot select task authority/,
  );
  assert.throws(
    () => proposedTasks([{ ...value, dependencies: ['foreign-task'] }]),
    /unknown proposed task dependency/,
  );
  assert.throws(
    () => proposedTasks([{ ...value, dependencies: ['a'] }]),
    /dependency cycle/,
  );
  assert.throws(
    () => proposedTasks([value, value]),
    /duplicate proposed task key/,
  );
  assert.throws(
    () => proposedTasks([{ ...value, allowedResources: ['all'] }]),
    /cannot select task authority/,
  );
});

test('legacy unknown resource metadata cannot execute and an explicit retry uses current host grants; ungranted verifier resources have no effects', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  let calls = 0;
  const options: TaskServiceOptions = {
    workspace,
    dataDir,
    allowedResources: ['agent'],
    autoStart: false,
    emit: () => {},
    createRuntime: async (task, ctx) => {
      const home = join(dataDir, `${task.spec.id}-${task.attempt}`);
      await mkdir(home);
      return new AgentRuntime({
        home,
        workspace: ctx.worktree,
        userHome: home,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        model: new ScriptedModel([
          async () => {
            calls++;
            return { message: message('inspected'), usage: emptyUsage() };
          },
        ]),
      });
    },
    verify: async (task, ctx) => {
      if (task.spec.id === 'forbidden')
        await ctx.withResource('browser', async () => {
          await writeFile(join(workspace, 'forbidden.txt'), 'wrong');
        });
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: 'Independent fixture inspected baseline',
        },
      ];
    },
  };
  let service = new TaskService(options);
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'legacy',
    tasks: [{ ...task('legacy'), access: 'readonly' }],
  });
  await service.close();
  const store = new TaskStore(join(dataDir, 'collaboration.sqlite'));
  const legacy = store.get('legacy')!;
  legacy.spec.allowedResources = ['granted'] as unknown as TaskResource[];
  store.put(legacy);
  store.close();
  service = new TaskService(options);
  assert.equal(service.getTask('legacy')!.state, 'queued');
  await service.call('owner', 'start');
  await until(async () => service.getTask('legacy')!.state === 'needs_review');
  assert.equal(calls, 0);
  assert.equal(service.getTask('legacy')!.worktree, undefined);
  assert.match(
    service.getTask('legacy')!.reason!,
    /invalid task resource grants/,
  );
  await service.call('owner', 'retry', {
    id: 'legacy',
    operationId: 'current-host-grant',
  });
  await until(async () => service.getTask('legacy')!.state === 'succeeded');
  assert.equal(calls, 1);
  assert.deepEqual(service.getTask('legacy')!.spec.allowedResources, ['agent']);
  await service.call('owner', 'enqueue', {
    operationId: 'forbidden',
    tasks: [{ ...task('forbidden'), access: 'readonly' }],
  });
  await until(
    async () => service.getTask('forbidden')!.state === 'needs_review',
  );
  assert.match(service.getTask('forbidden')!.reason!, /browser is not granted/);
  await assert.rejects(readFile(join(workspace, 'forbidden.txt')), /ENOENT/);
});

test('service injects authorized workspace/session/resources and rejects renderer authority', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const service = new TaskService({
    workspace,
    dataDir,
    autoStart: false,
    allowedResources: ['agent'],
    emit: () => {},
    createRuntime: () => {
      throw new Error('must not run');
    },
  });
  cleanup(t, () => service.close());
  const created = (await service.call('origin-session', 'enqueue', {
    operationId: 'enqueue',
    tasks: [task('one')],
  })) as TaskRecord[];
  assert.equal(created[0]!.spec.workspace, await realpath(workspace));
  assert.equal(created[0]!.spec.sessionId, 'origin-session');
  assert.deepEqual(created[0]!.spec.allowedResources, ['agent']);
  await assert.rejects(
    service.call('origin-session', 'enqueue', {
      operationId: 'bad',
      tasks: [{ ...task('bad'), workspace: '/ungranted' }],
    }),
    /ungranted fields/,
  );
  await assert.rejects(
    service.call('origin-session', 'list', { dataDir: '/private' }),
    /cannot select/,
  );
  await assert.rejects(
    service.call('origin-session', 'enqueue', {
      operationId: 'bad-resource',
      tasks: [{ ...task('bad'), allowedResources: ['all'] }],
    }),
    /ungranted fields/,
  );
  await assert.rejects(service.call('', 'list'), /session id/);
  const cancelled = (await service.call('origin-session', 'cancel', {
    id: 'one',
  })) as TaskRecord;
  assert.equal(cancelled.state, 'cancelled');
  const retried = (await service.call('origin-session', 'retry', {
    id: 'one',
    operationId: 'retry',
  })) as TaskRecord;
  assert.equal(retried.attempt, 2);
  const events = (await service.call('origin-session', 'events', {
    cursor: 0,
    limit: 100,
  })) as CollaborationEvent[];
  assert.ok(events.some((event) => event.type === 'task.cancelled'));
  assert.deepEqual(
    await service.call('origin-session', 'artifacts', { id: 'one' }),
    [],
  );
});

test('task concurrency settings persist, validate ranges and never silently replace invalid saved settings', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const options = {
    workspace,
    dataDir,
    autoStart: false,
    emit: () => {},
    createRuntime: () => {
      throw new Error('must not run');
    },
  };
  let service = new TaskService(options);
  cleanup(t, () => service.close());
  assert.deepEqual(await service.call('session', 'settings'), {
    agents: 8,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  await assert.rejects(
    service.call('session', 'settings', { limits: { agents: 33 } }),
    /invalid agents/,
  );
  await assert.rejects(
    service.call('session', 'settings', { limits: { ui: 2 } }),
    /invalid ui/,
  );
  await service.call('session', 'settings', {
    limits: { agents: 12, builds: 3 },
  });
  await service.close();
  assert.equal(service.hasActiveSession('session'), false);
  assert.equal(service.getTask('missing'), undefined);
  service = new TaskService(options);
  assert.deepEqual(await service.call('session', 'settings'), {
    agents: 12,
    builds: 3,
    ui: 1,
    browsers: 1,
  });
  await service.close();
  await writeFile(join(dataDir, 'task-settings.json'), '{invalid');
  assert.throws(() => new TaskService(options), /could not load task settings/);
});

test('service executes real runtime, exposes actual artifacts, refuses unverified merge and admits verified ledger candidates', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  const baseline = await repository(workspace);
  const events: CollaborationEvent[] = [];
  const service = new TaskService({
    workspace,
    dataDir,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    emit: (event) => events.push(event),
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      const model = new ScriptedModel([
        {
          message: message('', [
            {
              id: 'write',
              name: 'write_file',
              args: { file_path: record.spec.id + '.txt', content: 'actual' },
            },
          ]),
        },
        { message: message('done') },
      ]);
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
    verify: async (record, ctx) => {
      if (record.spec.id === 'claimed') return [];
      assert.equal(
        await readFile(join(ctx.worktree, record.spec.id + '.txt'), 'utf8'),
        'actual',
      );
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: `assert compared actual ${record.spec.id}.txt`,
        },
      ];
    },
  });
  cleanup(t, () => service.close());
  await service.call('origin', 'enqueue', {
    operationId: 'actual',
    tasks: [task('accepted'), task('claimed')],
  });
  await until(async () =>
    ((await service.call('origin', 'list')) as TaskRecord[]).every((record) =>
      ['succeeded', 'needs_review'].includes(record.state),
    ),
  );
  assert.equal(service.getTask('accepted')!.spec.sessionId, 'origin');
  assert.equal(service.getTask('claimed')!.state, 'needs_review');
  const artifacts = (await service.call('origin', 'artifacts', {
    id: 'accepted',
  })) as { id: string; kind: string }[];
  const patch = artifacts.find((artifact) => artifact.kind === 'task-patch')!;
  const shown = (await service.call('origin', 'readArtifact', {
    id: 'accepted',
    artifactId: patch.id,
  })) as { content: string; sha256: string; truncated: boolean };
  assert.match(shown.content, /actual/);
  assert.equal(shown.truncated, false);
  await assert.rejects(
    service.call('origin', 'readArtifact', {
      id: 'claimed',
      artifactId: patch.id,
    }),
    /does not belong/,
  );
  assert.equal(artifacts.length, 4);
  assert.ok(events.some((event) => event.type === 'artifact.created'));
  const integration = (await service.call('origin', 'createIntegration', {
    baseline,
  })) as { id: string; path: string; baseline: string };
  const rejected = (await service.call('origin', 'mergeCandidates', {
    integrationId: integration.id,
    taskIds: ['claimed'],
    expectedHead: baseline,
  })) as { status: string };
  assert.equal(rejected.status, 'needs_review');
  await assert.rejects(
    service.call('origin', 'mergeCandidates', {
      integrationId: integration.id,
      taskIds: ['accepted'],
      expectedHead: baseline,
      patchPath: '/untrusted',
    }),
    /must come from/,
  );
  const merged = (await service.call('origin', 'mergeCandidates', {
    integrationId: integration.id,
    taskIds: ['accepted'],
    expectedHead: baseline,
  })) as { status: string };
  assert.equal(merged.status, 'merged');
  assert.equal(
    await readFile(join(integration.path, 'accepted.txt'), 'utf8'),
    'actual',
  );
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), baseline);
  const repairBaseline = await git(integration.path, 'rev-parse', 'HEAD');
  await service.call('origin', 'enqueue', {
    operationId: 'repair-round',
    tasks: [{ ...task('repair'), baseline: repairBaseline }],
  });
  await until(async () => service.getTask('repair')!.state === 'succeeded');
  const repairRequest = {
    integrationId: integration.id,
    taskIds: ['repair'],
    expectedHead: repairBaseline,
  };
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', repairRequest)) as {
        status: string;
      }
    ).status,
    'needs_review',
    'a repair cannot silently use the initial integration baseline',
  );
  const unrelated = await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    await git(workspace, 'rev-parse', 'HEAD^{tree}'),
    '-m',
    'Create unrelated baseline',
  );
  for (const expectedBaseline of ['HEAD', unrelated, '0'.repeat(40)]) {
    const refused = (await service.call('origin', 'mergeCandidates', {
      ...repairRequest,
      expectedBaseline,
    })) as { status: string; reason: string };
    assert.equal(refused.status, 'needs_review');
    assert.match(refused.reason, /baseline/);
    assert.equal(
      await git(integration.path, 'rev-parse', 'HEAD'),
      repairBaseline,
    );
  }
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', {
        ...repairRequest,
        expectedBaseline: repairBaseline,
      })) as { status: string }
    ).status,
    'merged',
  );
  assert.equal(
    await readFile(join(integration.path, 'repair.txt'), 'utf8'),
    'actual',
  );
  assert.equal(
    await readFile(join(integration.path, 'accepted.txt'), 'utf8'),
    'actual',
  );
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), baseline);
  const pendingReview = service.getTask('claimed')!;
  const reviewParams = {
    id: 'claimed',
    expectedAttempt: pendingReview.attempt,
    expectedPatchSha256: (
      pendingReview.result as { changes: { sha256: string } }
    ).changes.sha256,
    checks: [
      {
        criterion: 'actual file',
        evidence: 'I inspected claimed.txt and verified the actual contents',
      },
    ],
  };
  await assert.rejects(
    service.call('origin', 'review', {
      ...reviewParams,
      expectedAttempt: pendingReview.attempt + 1,
    }),
    /stale/,
  );
  await assert.rejects(
    service.call('origin', 'review', { ...reviewParams, checks: [] }),
    /each acceptance/,
  );
  const reviewed = (await service.call(
    'origin',
    'review',
    reviewParams,
  )) as TaskRecord;
  assert.equal(reviewed.state, 'succeeded');
  assert.equal(
    (reviewed.result as { review: { reviewer: string } }).review.reviewer,
    'human',
  );
  assert.equal(
    ((await service.call('origin', 'review', reviewParams)) as TaskRecord)
      .state,
    'succeeded',
  );
  const humanArtifacts = (await service.call('origin', 'artifacts', {
    id: 'claimed',
  })) as { kind: string }[];
  assert.equal(
    humanArtifacts.filter((artifact) => artifact.kind === 'human-review')
      .length,
    1,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'task.reviewed' &&
        (event.payload as { reviewer: string }).reviewer === 'human',
    ),
  );
  const currentHead = await git(integration.path, 'rev-parse', 'HEAD');
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', {
        integrationId: integration.id,
        taskIds: ['claimed'],
        expectedHead: currentHead,
      })) as { status: string }
    ).status,
    'merged',
  );
  assert.equal(
    await readFile(join(integration.path, 'claimed.txt'), 'utf8'),
    'actual',
  );
});

test('authorized workspaces share global agent/UI pools and one durable settings stream', async (t) => {
  const workspaceA = scratch(t),
    workspaceB = scratch(t),
    data = scratch(t);
  await repository(workspaceA);
  await repository(workspaceB);
  const { CollaborationResources } =
    await import('../src/workspace/collaboration.js');
  const resources = new CollaborationResources({ agents: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const make = (workspace: string, name: string) =>
    new TaskService({
      workspace,
      dataDir: join(data, name),
      resources,
      settingsPath: join(data, 'shared', 'limits.json'),
      emit: () => {},
      createRuntime: async (record, ctx) => {
        const home = join(data, 'homes', record.spec.id);
        await mkdir(home, { recursive: true });
        const model = new ScriptedModel([
          async () => {
            started.push(record.spec.id);
            await gate;
            return {
              message: message('done'),
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
              },
            };
          },
        ]);
        return new AgentRuntime({
          workspace: ctx.worktree,
          home,
          userHome: home,
          model,
          settings: trustFolder(defaultSettings(), ctx.worktree),
          headless: true,
          bundledExtensions: false,
          screenshot: false,
        });
      },
    });
  const first = make(workspaceA, 'a'),
    second = make(workspaceB, 'b');
  cleanup(t, async () => {
    release();
    await Promise.all([first.close(), second.close()]);
  });
  await first.call('a-session', 'enqueue', {
    operationId: 'a',
    tasks: [{ ...task('ui-a'), resource: 'ui' }],
  });
  await until(async () => started.includes('ui-a'));
  await second.call('b-session', 'enqueue', {
    operationId: 'b',
    tasks: [{ ...task('ui-b'), resource: 'ui' }, task('independent-b')],
  });
  await until(async () => started.length === 2);
  assert.ok(started.includes('independent-b'));
  assert.ok(!started.includes('ui-b'));
  assert.notEqual(first.getTask('ui-a')!.runtimeSessionId, 'a-session');
  assert.ok(first.getTask('ui-a')!.runtimeSessionId);
  await Promise.all([
    first.call('a-session', 'settings', { limits: { agents: 3 } }),
    second.call('b-session', 'settings', { limits: { builds: 4 } }),
  ]);
  assert.deepEqual(await second.call('b-session', 'settings'), {
    agents: 3,
    builds: 4,
    ui: 1,
    browsers: 1,
  });
  release();
  await until(async () =>
    [
      ...((await first.call('a-session', 'list')) as TaskRecord[]),
      ...((await second.call('b-session', 'list')) as TaskRecord[]),
    ].every((record) => record.state === 'needs_review'),
  );
});

test('deleting an owner cancels only its task runtimes and awaits model cleanup; task views use the same ownership', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const entered = new Set<string>(),
    closed = new Set<string>();
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    onRuntimeClosed: (task) => {
      closed.add(task.spec.id);
    },
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      const model = new ScriptedModel([
        async (request) => {
          entered.add(`${record.spec.id}:${record.attempt}`);
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            );
          });
          throw new Error('not reached');
        },
      ]);
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent-a', 'enqueue', {
    operationId: 'a',
    tasks: [task('a')],
  });
  await service.call('parent-b', 'enqueue', {
    operationId: 'b',
    tasks: [task('b')],
  });
  await until(async () => entered.size === 2);
  assert.equal(service.hasActiveSession('parent-a'), true);
  const childB = service.getTask('b')!.runtimeSessionId!;
  assert.equal(service.hasActiveSession(childB), true);
  const childA = service.getTask('a')!.runtimeSessionId!;
  await service.call(childA, 'enqueue', {
    operationId: 'nested',
    tasks: [task('nested')],
  });
  await until(async () => entered.size === 3);
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 2);
  await service.cancelSession('parent-a');
  assert.equal(service.getTask('a')!.state, 'cancelled');
  assert.equal(closed.has('a'), true);
  assert.equal(service.getTask('nested')!.state, 'cancelled');
  assert.equal(service.hasActiveSession('parent-a'), false);
  assert.equal(service.getTask('b')!.state, 'running');
  assert.equal(closed.has('b'), false);
  assert.equal(service.hasActiveSession('parent-b'), true);
  await service.call('parent-a', 'retry', {
    id: 'a',
    operationId: 'new-attempt',
  });
  await until(async () => entered.has('a:2'));
  assert.notEqual(service.getTask('a')!.runtimeSessionId, childA);
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 3);
  await service.cancelSession('parent-a');
  await service.cancelSession(childB);
  assert.equal(service.getTask('b')!.state, 'cancelled');
  assert.equal(closed.has('b'), true);
  assert.equal(service.hasActiveSession('parent-b'), false);
  await service.close();
  await service.cancelSession('parent-a');
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 3);
});

test('human acceptance binds every criterion to the displayed attempt, actual head and immutable patch', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([{ message: message('claim') }]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent', 'enqueue', {
    operationId: 'reviewed',
    tasks: [
      {
        ...task('reviewed'),
        acceptanceCriteria: ['first criterion', 'second criterion'],
      },
    ],
  });
  await until(
    async () => service.getTask('reviewed')?.state === 'needs_review',
  );
  const record = service.getTask('reviewed')!,
    changes = (
      record.result as { changes: { sha256: string; patchPath: string } }
    ).changes;
  const params = {
    id: 'reviewed',
    expectedAttempt: record.attempt,
    expectedPatchSha256: changes.sha256,
    checks: [
      {
        criterion: 'first criterion',
        evidence: 'I inspected the first expected behavior',
      },
      {
        criterion: 'second criterion',
        evidence: 'I inspected the second expected behavior',
      },
    ],
  };
  await assert.rejects(
    service.call('parent', 'review', {
      ...params,
      checks: params.checks.slice(0, 1),
    }),
    /each acceptance/,
  );
  await writeFile(join(record.worktree!, 'source.txt'), 'later changes');
  await assert.rejects(
    service.call('parent', 'review', params),
    /worktree changed/,
  );
  await writeFile(join(record.worktree!, 'source.txt'), 'source');
  const originalPatch = await readFile(changes.patchPath);
  await writeFile(changes.patchPath, 'tampered');
  await assert.rejects(
    service.call('parent', 'review', params),
    /patch changed/,
  );
  await writeFile(changes.patchPath, originalPatch);
  await git(
    record.worktree!,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Change candidate head',
  );
  await assert.rejects(
    service.call('parent', 'review', params),
    /worktree changed/,
  );
  assert.equal(service.getTask('reviewed')!.state, 'needs_review');
});

test('artifact viewer verifies ledger ownership and bytes, paginates Unicode and rejects symlink escapes', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t),
    outside = scratch(t);
  await repository(workspace);
  const content = 'A😀中B';
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([{ message: message('done') }]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
    verify: async (_record, ctx) => {
      const path = join(ctx.artifactDirectory, 'proof.log');
      await writeFile(path, content);
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: 'source was inspected',
          artifactPaths: [path],
        },
      ];
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent', 'enqueue', {
    operationId: 'artifact',
    tasks: [task('artifact')],
  });
  await until(async () => service.getTask('artifact')?.state === 'succeeded');
  const artifacts = (await service.call('parent', 'artifacts', {
    id: 'artifact',
  })) as { id: string; kind: string; path: string }[];
  const proof = artifacts.find((artifact) => artifact.kind === 'verification')!;
  const read = (offset = 0) =>
    service.call('parent', 'readArtifact', {
      id: 'artifact',
      artifactId: proof.id,
      offset,
      limit: 2,
    }) as Promise<{ content: string; truncated: boolean; nextOffset?: number }>;
  const first = await read();
  assert.equal(first.content, 'A');
  assert.equal(first.truncated, true);
  const second = await read(first.nextOffset!);
  assert.equal(second.content, '😀');
  const third = await read(second.nextOffset!);
  assert.equal(third.content, '中B');
  assert.equal(third.truncated, false);
  await assert.rejects(read(2), /splits a character/);
  await assert.rejects(
    service.call('parent', 'readArtifact', {
      id: 'artifact',
      artifactId: proof.id,
      path: '/private',
    }),
    /cannot select artifact paths/,
  );
  await writeFile(proof.path, 'changed');
  await assert.rejects(read(), /changed after it was recorded/);
  await writeFile(join(outside, 'same.txt'), content);
  await unlink(proof.path);
  await symlink(join(outside, 'same.txt'), proof.path);
  await assert.rejects(read(), /outside its owned/);
});
