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
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller';
import { ScriptedModel } from '../../../src/testing';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
  saveSettingsChange,
} from '../../../src/settings';
import type { RuntimeCommandName } from '../src/runtime-protocol';
import { patience } from './helpers/patience.mjs';

async function wait(check: () => boolean) {
  const until = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > until) throw Error('archive scope fixture timed out');
    await delay(10);
  }
}
test('a corrupt task archive blocks its unknown readonly child while both ordinary parents retain document and language access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-archive-scope-')),
    home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  const a = await realpath(join(root, 'a')),
    b = await realpath(join(root, 'b'));
  for (const workspace of [a, b]) {
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', [
      '-C',
      workspace,
      'config',
      '--local',
      'core.autocrlf',
      'false',
    ]);
    await writeFile(join(workspace, 'main.ts'), 'export const value = 1;\n');
    execFileSync('git', ['-C', workspace, 'add', 'main.ts']);
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
  }
  saveSettings(trustFolder(trustFolder(defaultSettings(), a), b), home);
  const model = new ScriptedModel(
    Array.from({ length: 10 }, () => ({
      message: {
        id: randomUUID(),
        role: 'assistant' as const,
        content: '{"checks":[]}',
      },
    })),
  );
  const options = { home, workspace: a, userHome: home, model, emit() {} };
  let controller = new RuntimeController(options);
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const service = (
    service: string,
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => call('workspace-service', { service, method, params }, sessionId);
  const parentA = controller.snapshot().activeSessionId;
  const enqueued = await service(
    'tasks',
    'enqueue',
    {
      operationId: 'readonly-a',
      tasks: [
        {
          id: 'readonly-a',
          prompt: 'Inspect baseline source',
          access: 'readonly',
          acceptanceCriteria: ['read source'],
        },
      ],
    },
    parentA,
  );
  assert.equal(enqueued.ok, true, enqueued.error);
  await wait(() =>
    controller
      .snapshot()
      .agents.some(
        (agent) =>
          agent.sessionId === parentA && agent.task?.state === 'needs_review',
      ),
  );
  const child = controller
    .snapshot()
    .agents.find((agent) => agent.sessionId === parentA)!;
  assert.equal(child.readOnly, true);
  const taskList = await service('tasks', 'list', {}, parentA),
    task = (taskList.data as any[])[0];
  const childWorkspace = await realpath(task.worktree);
  assert.notEqual(
    childWorkspace,
    a,
    'current readonly executor uses a detached owned worktree',
  );
  assert.equal(
    execFileSync(
      'git',
      ['-C', childWorkspace, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' },
    ).trim(),
    'HEAD',
  );
  const childRead = await service(
    'documents',
    'read',
    { path: 'main.ts' },
    child.id,
  );
  assert.equal(childRead.ok, true, childRead.error);
  const opened = await call('open-workspace', { path: b });
  assert.equal(opened.ok, true, opened.error);
  const parentB = (opened.data as { sessionId: string }).sessionId;
  await controller.close();
  // Make trust explicit so rejection of this real readonly child must be the
  // archive authority failure, not the pre-existing untrusted-folder gate.
  saveSettingsChange(home, (saved) =>
    Object.assign(saved, trustFolder(saved, childWorkspace)),
  );
  const dataDir = join(
    home,
    'collaboration',
    createHash('sha256').update(a).digest('hex').slice(0, 24),
  );
  await writeFile(
    join(dataDir, 'collaboration.sqlite'),
    'corrupt archive fixture',
  );
  controller = new RuntimeController({ ...options, workspace: b });
  assert.match(
    controller.snapshot().runtime?.error ?? '',
    /could not read agent task history/,
  );
  const requests = model.requests.length;
  for (const [id, workspace, value] of [
    [parentA, a, 2],
    [parentB, b, 3],
  ] as const) {
    const read = await service('documents', 'read', { path: 'main.ts' }, id);
    assert.equal(read.ok, true, read.error);
    const save = await service(
      'documents',
      'save',
      {
        path: 'main.ts',
        content: `export const value = ${value};\n`,
        expectedRevision: (read.data as any).revision,
      },
      id,
    );
    assert.equal(save.ok, true, save.error);
    assert.equal(
      await readFile(join(workspace, 'main.ts'), 'utf8'),
      `export const value = ${value};\n`,
    );
    const language = await service(
      'language',
      'request',
      {
        method: 'rename',
        path: 'main.ts',
        line: 1,
        column: 14,
        newName: 'renamed',
      },
      id,
    );
    assert.equal(language.ok, true, language.error);
    assert.ok(Array.isArray(language.data));
  }
  for (const method of ['save', 'applyEdits']) {
    const denied = await service(
      'documents',
      method,
      {
        path: 'main.ts',
        content: 'illegal',
        expectedRevision: (childRead.data as any).revision,
        changes: [],
      },
      child.id,
    );
    assert.equal(denied.ok, false);
    assert.match(
      denied.error!,
      /agent source permission could not be verified/,
    );
  }
  assert.equal(
    await readFile(join(childWorkspace, 'main.ts'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.match(
    controller.snapshot().runtime?.error ?? '',
    /could not read agent task history/,
  );
  assert.equal(
    model.requests.length,
    requests,
    'no archive recovery replays a model request',
  );
});
