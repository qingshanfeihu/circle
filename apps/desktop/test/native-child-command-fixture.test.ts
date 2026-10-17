import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import {
  RuntimeFixtureModel,
  type RuntimeFixtureRoute,
} from '../src/runtime-fixture.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';
import { LiveRuntime } from '../../workbench/src/model/live.ts';
import type { DesktopBridge } from '../src/contracts.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { TaskRecord } from '../src/workspace/task-store.ts';
import type {
  CommandTerminalAvailable,
  CommandTerminalCommandReply,
} from '../../workbench/src/command-terminal-target.ts';
import type { WorkspaceDocument } from '../src/workspace/documents.ts';
import type {
  TerminalSnapshot,
  TerminalReplay,
} from '../src/workspace/terminal.ts';
import { patience } from './helpers/patience.mjs';
interface Fixture {
  files: string[];
  source: string;
  paths: { source: string; pid: string; starts: string; input: string };
  parentPrompt: string;
  taskPrompt: string;
  taskId: string;
  toolCallId: string;
  routes: RuntimeFixtureRoute[];
}
const fixtureUrl = new URL(
  './helpers/native-child-command-handoff-journey.mjs',
  import.meta.url,
).href;
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
};
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + patience(8000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('native child fixture: ' + label);
    await delay(10);
  }
}

test(
  'the native journey fixture uses a real delegated worker PTY, a distinct readonly reviewer and archived command history without replay',
  {
    skip:
      process.platform === 'win32'
        ? 'native POSIX managed PTY is unavailable on Windows; do not claim a simulated pass'
        : false,
  },
  async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'circle-native-child-fixture-'));
    const home = join(temp, 'home'),
      workspace = join(temp, 'workspace'),
      realData = join(temp, 'real-data'),
      data = join(temp, 'data-alias');
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(realData)]);
    await symlink(realData, data, 'dir');
    const helper = await import(fixtureUrl);
    const fixture = (await helper.createNativeChildCommandHandoffFixture(
      workspace,
      process.execPath,
    )) as Fixture;
    const expectedInput = helper.childCommandInput as string;
    assert.equal(expectedInput.at(-1), '\r');
    execFileSync(process.execPath, [
      '--check',
      join(workspace, fixture.paths.source),
    ]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args]);
    git('init', '-q');
    git('config', '--local', 'core.autocrlf', 'false');
    git('add', ...fixture.files);
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Create child command fixture',
    );
    saveSettings(trustFolder(defaultSettings(), workspace), home);
    const requestsPath = join(temp, 'actual-model-requests.jsonl');
    const model = new RuntimeFixtureModel({
      routes: fixture.routes,
      requestsPath,
    });
    let listener: ((update: RuntimeUpdate) => void) | undefined;
    let update!: RuntimeUpdate;
    const options = {
      home,
      workspace,
      userHome: home,
      dataFolder: data,
      model,
      workspaceTools: {
        nodeExecutable: process.execPath,
        runtimeExecutable: process.execPath,
        commandSupervisorPath: fileURLToPath(
          new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
        ),
        adapterPath: 'unused',
        ghPath: 'unused',
      },
      emit(value: RuntimeUpdate) {
        update = value;
        listener?.(structuredClone(value));
      },
    };
    let controller = new RuntimeController(options);
    controller.publish();
    const storage = new Map<string, string>();
    const host = {
      runtimeState: async () => structuredClone(update),
      runtimeCommand: (command: unknown) => controller.dispatch(command),
      onRuntime(callback: (update: RuntimeUpdate) => void) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as DesktopBridge;
    const live = new LiveRuntime(host, structuredClone(update), {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
    });
    const parentId = update.snapshot.activeSessionId;
    const call = async <T = unknown>(
      service: string,
      method: string,
      params: Record<string, unknown> = {},
      sessionId = parentId,
    ): Promise<T> => {
      const reply = await controller.dispatch({
        id: randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service, method, params },
      });
      assert.equal(reply.ok, true, reply.error);
      return reply.data as T;
    };
    const approve = async (ownerId: string, callId: string) => {
      await until(
        () =>
          controller
            .snapshot()
            .interactions.some(
              (row) =>
                row.sessionId === ownerId &&
                row.callId === callId &&
                row.status === 'pending',
            ),
        'actual owner approval ' + callId,
      );
      const row = controller
        .snapshot()
        .interactions.find(
          (row) =>
            row.sessionId === ownerId &&
            row.callId === callId &&
            row.status === 'pending',
        )!;
      const reply = await controller.dispatch({
        id: randomUUID(),
        name: 'answer',
        sessionId: ownerId,
        payload: { id: row.id, revision: row.revision, answer: 'approve' },
      });
      assert.equal(reply.ok, true, reply.error);
    };
    const read = (file: string, root = workspace) =>
      readFile(join(root, file), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
    let child: TaskRecord | undefined;
    let pid: number | undefined;
    let lastResolution: unknown;
    try {
      const started = await controller.dispatch({
        id: randomUUID(),
        name: 'prompt',
        sessionId: parentId,
        payload: { text: fixture.parentPrompt },
      });
      assert.equal(started.ok, true, started.error);
      await approve(parentId, 'native-child-parent-enqueue');
      await until(async () => {
        child = (await call<TaskRecord[]>('tasks', 'list')).find(
          (task) => task.spec.id === fixture.taskId,
        );
        return !!child?.runtimeSessionId && !!child.worktree;
      }, 'real delegated child identity');
      assert.equal(child!.spec.sessionId, parentId);
      assert.equal(child!.spec.access, 'write');
      assert.notEqual(child!.worktree, workspace);
      assert.notEqual(
        child!.worktree,
        await realpath(child!.worktree!),
        'the task ledger retains a real data-directory alias while stored sessions use its canonical path',
      );
      await approve(child!.runtimeSessionId!, fixture.toolCallId);
      await until(async () => {
        pid = Number(await read(fixture.paths.pid, child!.worktree!));
        return Number.isSafeInteger(pid) && pid > 0;
      }, 'owned child process actually starts');
      live.updateSessionView(parentId, {
        draft: 'NATIVE_CHILD_PARENT_UNSENT_DRAFT',
      });
      const draft = live
        .getSnapshot()
        .sessions.find((row) => row.id === parentId)!.draft;
      const resolution = await call<CommandTerminalAvailable>(
        'terminal',
        'resolveCommand',
        {
          sourceSessionId: child!.runtimeSessionId,
          toolCallId: fixture.toolCallId,
        },
      );
      assert.equal(resolution.available, true);
      assert.equal(
        resolution.target.executionSessionId,
        child!.runtimeSessionId,
      );
      const listing = await call<
        CommandTerminalCommandReply<TerminalSnapshot[]>
      >('terminal', 'command', { target: resolution.target, action: 'list' });
      assert.equal(listing.available, true);
      if (!listing.available) throw Error('missing original command');
      assert.equal(listing.value[0]!.managedCommand!.commandPid, pid);
      assert.equal(listing.value[0]!.id, resolution.target.terminal.id);
      const write = await call<CommandTerminalCommandReply>(
        'terminal',
        'command',
        {
          target: resolution.target,
          action: 'write',
          params: { data: expectedInput },
        },
      );
      assert.equal(write.available, true);
      await until(
        async () =>
          (await read(fixture.paths.input, child!.worktree!)) === expectedInput,
        'exact stdin reaches original child',
      );
      assert.equal(await read(fixture.paths.input), '');
      assert.equal(await read(fixture.paths.pid), '');
      assert.equal(
        await read(fixture.paths.starts, child!.worktree!),
        'once\n',
      );
      const stopped = await call<CommandTerminalCommandReply<TerminalSnapshot>>(
        'terminal',
        'command',
        { target: resolution.target, action: 'close' },
      );
      assert.equal(stopped.available, true);
      if (!stopped.available) throw Error('missing closed command');
      assert(gone(pid!));
      assert(stopped.value.managedCommand!.completion.rootExit);
      assert(stopped.value.managedCommand!.completion.controlledGroupEmpty);
      assert(stopped.value.managedCommand!.completion.transportAndLogClosed);
      await until(async () => {
        child = (await call<TaskRecord[]>('tasks', 'list')).find(
          (task) => task.spec.id === fixture.taskId,
        );
        return (
          child?.state === 'needs_review' && !!child.reviewers?.[0]?.sessionId
        );
      }, 'real independent reviewer reaches human review boundary');
      const reviewer = child!.reviewers![0]!;
      assert.notEqual(reviewer.sessionId, child!.runtimeSessionId);
      const snapshot = controller.snapshot();
      const workerAgent = snapshot.agents.find(
        (a) => a.id === child!.runtimeSessionId,
      )!;
      const reviewerAgent = snapshot.agents.find(
        (a) => a.id === reviewer.sessionId,
      )!;
      assert.equal(workerAgent.readOnly, false);
      assert.equal(reviewerAgent.readOnly, true);
      assert.equal(reviewerAgent.task!.role, 'reviewer');
      const parentTool = snapshot.sessions
        .find((row) => row.id === parentId)!
        .messages.find(
          (row) => row.tool?.name === 'native_tasks_enqueue',
        )!.tool!;
      assert(parentTool.agentIds!.includes(workerAgent.id));
      assert(parentTool.agentIds!.includes(reviewerAgent.id));
      const source = await call<WorkspaceDocument>(
        'documents',
        'read',
        { path: fixture.paths.source },
        reviewer.sessionId,
      );
      assert.equal(source.content, fixture.source);
      const denied = await controller.dispatch({
        id: randomUUID(),
        name: 'workspace-service',
        sessionId: reviewer.sessionId,
        payload: {
          service: 'documents',
          method: 'save',
          params: {
            path: fixture.paths.source,
            content: 'MUST_NOT_WRITE',
            expectedRevision: source.revision,
          },
        },
      });
      assert.equal(denied.ok, false);
      assert.match(denied.error!, /read-only agent source/);
      assert.equal(await read(fixture.paths.source), fixture.source);
      assert.equal(
        await read(fixture.paths.source, child!.worktree!),
        fixture.source,
      );
      assert(
        model.requests.some(
          (request) =>
            request.fixture.role === 'worker' &&
            request.messages.some((message) =>
              message.commandExecutions?.some(
                (receipt) =>
                  receipt.executionId === resolution.target.executionId &&
                  receipt.executionSessionId === child!.runtimeSessionId,
              ),
            ),
        ),
      );
      const reviewRequests = model.requests.filter(
        (request) => request.fixture.role === 'reviewer',
      );
      assert.equal(reviewRequests.length, 2);
      assert(
        reviewRequests.every(
          (request) =>
            !request.tools.some(
              (tool) =>
                tool.name === 'execute' ||
                tool.name.startsWith('native_tasks_'),
            ),
        ),
      );
      assert.equal(
        live.getSnapshot().sessions.find((row) => row.id === parentId)!.draft,
        draft,
      );
      const requestCount = model.requests.length;
      await controller.close();
      controller = new RuntimeController(options);
      controller.publish();
      const restored = await call<CommandTerminalAvailable>(
        'terminal',
        'resolveCommand',
        {
          sourceSessionId: child!.runtimeSessionId,
          toolCallId: fixture.toolCallId,
        },
      );
      lastResolution = restored;
      t.diagnostic(JSON.stringify({ restored }));
      assert.equal(restored.available, true);
      assert.deepEqual(restored.target, resolution.target);
      assert.deepEqual(restored.capabilities, {
        read: true,
        input: false,
        stop: false,
        addToDraft: false,
      });
      const replay = await call<CommandTerminalCommandReply<TerminalReplay>>(
        'terminal',
        'command',
        { target: restored.target, action: 'replay' },
      );
      assert.equal(replay.available, true);
      if (!replay.available) throw Error('missing restored history');
      assert(
        replay.value.events
          .map((event) => event.data ?? '')
          .join('')
          .includes('CHILD_HANDOFF_ECHO:' + expectedInput.trimEnd()),
      );
      const oldWrite = await controller.dispatch({
        id: randomUUID(),
        name: 'workspace-service',
        sessionId: parentId,
        payload: {
          service: 'terminal',
          method: 'command',
          params: {
            target: restored.target,
            action: 'write',
            params: { data: 'MUST_NOT_RELAUNCH' },
          },
        },
      });
      assert.equal(oldWrite.ok, false);
      assert(oldWrite.error);
      assert.equal(model.requests.length, requestCount);
      assert(gone(pid!));
      assert.equal(
        await read(fixture.paths.starts, child!.worktree!),
        'once\n',
      );
      assert.equal(
        Number(await read(fixture.paths.pid, child!.worktree!)),
        pid,
      );
      assert.equal(
        await read(fixture.paths.input, child!.worktree!),
        expectedInput,
      );
      assert.equal(
        live.getSnapshot().sessions.find((row) => row.id === parentId)!.draft,
        draft,
      );
      const foreign = await controller.dispatch({
        id: randomUUID(),
        name: 'new-session',
        sessionId: parentId,
        payload: {},
      });
      assert.equal(foreign.ok, true, foreign.error);
      const foreignId = (foreign.data as { sessionId: string }).sessionId;
      assert.notEqual(foreignId, parentId);
      const foreignResolution = await call<CommandTerminalAvailable>(
        'terminal',
        'resolveCommand',
        {
          sourceSessionId: child!.runtimeSessionId,
          toolCallId: fixture.toolCallId,
        },
        foreignId,
      );
      assert.equal(
        foreignResolution.available,
        false,
        'an unrelated parent cannot acquire the owned child through the same directory alias',
      );
      await rename(child!.worktree!, child!.worktree! + '-original');
      await mkdir(child!.worktree!);
      const replaced = await controller.dispatch({
        id: randomUUID(),
        name: 'workspace-service',
        sessionId: parentId,
        payload: {
          service: 'terminal',
          method: 'resolveCommand',
          params: {
            sourceSessionId: child!.runtimeSessionId,
            toolCallId: fixture.toolCallId,
          },
        },
      });
      assert.equal(replaced.ok, false);
      assert.match(replaced.error!, /workspace root changed/);
      assert.equal(model.requests.length, requestCount);
      t.diagnostic(
        JSON.stringify({
          kind: 'backend fixture only; native UI and whole application restart remain pending',
          parentId,
          worker: workerAgent.id,
          reviewer: reviewerAgent.id,
          target: restored.target,
          pid,
          requestCount,
          exactInput: expectedInput,
          readonlyReviewerSaveRejected: true,
          archivedInputRejected: true,
          noNewProcess: true,
        }),
      );
    } catch (error) {
      const evidence =
        process.env.CIRCLE_CHILD_COMMAND_FIXTURE_EVIDENCE ??
        join(process.cwd(), 'apps/desktop/artifacts/runtime');
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(
          evidence,
          'native-child-command-fixture-failure-' + randomUUID() + '.json',
        ),
        JSON.stringify(
          {
            error: String(error),
            child,
            pid,
            lastResolution,
            rootBindings: Array.from(
              Reflect.get(controller, 'workspaceRoots').entries(),
            ),
            taskWorkspaces: Array.from(
              Reflect.get(controller, 'taskWorkspaces').entries(),
            ),
            sourceSession: Reflect.get(controller, 'store').get(
              child?.runtimeSessionId,
            ),
            parentSession: Reflect.get(controller, 'store').get(parentId),
            snapshot: controller.snapshot(),
            modelRequests: model.requests,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      live.dispose();
      await controller.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
