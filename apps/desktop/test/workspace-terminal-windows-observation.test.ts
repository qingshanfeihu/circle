import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type { TerminalSnapshot } from '../src/workspace/terminal.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { defaultSettings } from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { installExitGuard } from '../../../src/exit_guard.ts';
import { createWindowsProcessObserver } from './helpers/windows-process-observation.ts';
import { patience } from './helpers/patience.mjs';

const windows = {
  skip:
    process.platform !== 'win32'
      ? 'requires real Windows kernel process identity and ConPTY'
      : false,
};
function pidProbe(pid: number) {
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (error) {
    return { alive: false, code: (error as NodeJS.ErrnoException).code };
  }
}
function describe(error: unknown): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...('code' in error ? { code: error.code } : {}),
        ...(error instanceof AggregateError
          ? { errors: error.errors.map(describe) }
          : {}),
      }
    : { message: String(error) };
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + patience(5000);
  while (!(await check())) {
    assert(
      Date.now() < end,
      'actual Windows process fixture did not become ready',
    );
    await delay(10);
  }
}
async function evidenceDirectory() {
  const directory =
    process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ??
    (await mkdtemp(join(tmpdir(), 'circle-windows-observation-')));
  await mkdir(directory, { recursive: true });
  return directory;
}

test(
  'Windows session release observes PID birth and real exit without weakening the strict disappearance oracle',
  windows,
  async (t) => {
    const observe = await createWindowsProcessObserver(),
      evidence = await evidenceDirectory();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const root = await mkdtemp(join(tmpdir(), 'circle-win-release-observe-')),
        data = await mkdtemp(join(tmpdir(), 'circle-win-release-data-'));
      const events: WorkspaceServiceEvent[] = [],
        receipt: Record<string, unknown> = {
          attempt,
          platform: process.platform,
          root,
          data,
          status: 'running',
          startedAt: Date.now(),
        };
      const service = new WorkspaceServices({
        workspaceRoot: root,
        dataDir: data,
        nodeExecutable: process.execPath,
        runtimeExecutable: process.execPath,
        adapterPath: 'unused',
        ghPath: 'unused',
        terminalEnv: {
          HOME: root,
          ZDOTDIR: root,
          HISTFILE: join(root, '.history'),
          ENV: '',
          BASH_ENV: '',
        },
        emit: (event) => {
          events.push(event);
        },
      });
      const receiptPath = join(
        evidence,
        `windows-session-release-${randomUUID()}.json`,
      );
      const progress = async (step: string) =>
        appendFile(
          receiptPath + '.jsonl',
          JSON.stringify({ step, at: Date.now(), receipt }) + '\n',
        );
      await progress('workspace-created');
      let a: TerminalSnapshot | undefined,
        b: TerminalSnapshot | undefined,
        failure: unknown;
      try {
        a = (await service.call('session-a', 'terminal', 'create', {
          args: ['/d', '/q'],
        })) as TerminalSnapshot;
        b = (await service.call('session-b', 'terminal', 'create', {
          args: ['/d', '/q'],
        })) as TerminalSnapshot;
        receipt.before = { a: observe(a.pid!), b: observe(b.pid!) };
        assert.equal(await service.hasActiveSession('session-a'), true);
        assert.equal(
          await service.hasActiveSessionResources('session-b'),
          true,
        );
        await progress('owned-shells-ready-before-release');
        receipt.releaseStartedAt = Date.now();
        await service.releaseSession('session-a');
        receipt.releaseReturnedAt = Date.now();
        assert.equal(await service.hasActiveSession('session-a'), false);
        // Exactly the existing immediate assertion; no wait/retry before it.
        assert.throws(() => process.kill(a!.pid!, 0));
        assert.doesNotThrow(() => process.kill(b!.pid!, 0));
        receipt.afterA = { a: observe(a.pid!), b: observe(b.pid!) };
        const marker = `B_STILL_OWNED_${attempt}`;
        await service.call('session-b', 'terminal', 'write', {
          id: b.id,
          data: `echo ${marker}>"${join(root, 'b-owned.txt')}"\r`,
        });
        await until(
          async () =>
            await readFile(join(root, 'b-owned.txt'), 'utf8')
              .then((text) => text.trim() === marker)
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return false;
                throw error;
              }),
        );
        receipt.bActualFile = await readFile(join(root, 'b-owned.txt'), 'utf8');
        await service.releaseSession('session-b');
        assert.throws(() => process.kill(b!.pid!, 0));
        receipt.afterB = { a: observe(a.pid!), b: observe(b.pid!) };
      } catch (error) {
        failure = error;
        receipt.failure = describe(error);
        receipt.failedAt = Date.now();
        for (const [name, snapshot] of [
          ['a', a],
          ['b', b],
        ] as const)
          if (snapshot) {
            try {
              receipt[`${name}AfterFailure`] = {
                pid: pidProbe(snapshot.pid!),
                identity: observe(snapshot.pid!),
                terminals: await service.terminals.list(snapshot.owner),
              };
            } catch (observationError) {
              receipt[`${name}ObservationError`] = describe(observationError);
            }
          }
      } finally {
        try {
          await service.dispose();
          await rm(root, { recursive: true, force: true });
          await rm(data, { recursive: true, force: true });
        } catch (error) {
          receipt.cleanupError = describe(error);
          failure = failure
            ? new AggregateError(
                [failure, error],
                'actual release and cleanup failed',
              )
            : error;
        }
        receipt.events = events;
        receipt.status = failure ? 'failed' : 'passed';
        receipt.finishedAt = Date.now();
        receipt.resources = process.getActiveResourcesInfo();
        await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
        t.diagnostic(
          JSON.stringify({
            kind: 'actual Windows session release identity and immediate PID assertion',
            path: receiptPath,
            attempt,
            status: receipt.status,
          }),
        );
      }
      if (failure) throw failure;
    }
  },
);

test(
  'Windows signal cleanup observes the real job descendant and preserves any scratch-folder EBUSY failure',
  windows,
  async (t) => {
    const observe = await createWindowsProcessObserver(),
      evidence = await evidenceDirectory(),
      root = await mkdtemp(join(tmpdir(), 'circle-win-signal-observe-'));
    const path = join(evidence, `windows-signal-cleanup-${randomUUID()}.json`),
      receipt: Record<string, unknown> = {
        root,
        status: 'running',
        startedAt: Date.now(),
      };
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model: new ScriptedModel(),
      headless: true,
    });
    let pid: number | undefined,
      failure: unknown,
      off = () => {};
    const progress = async (step: string) =>
      appendFile(
        path + '.jsonl',
        JSON.stringify({ step, at: Date.now(), receipt }) + '\n',
      );
    await progress('runtime-created');
    try {
      const file = join(root, 'owned-job.cjs'),
        pidFile = join(root, 'actual-pid');
      await writeFile(
        file,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},10000);`,
      );
      const job = await runtime.jobs.startShell(
        `"${process.execPath}" "${file}"`,
        { sessionId: runtime.session.id },
      );
      await until(
        async () =>
          await readFile(pidFile, 'utf8')
            .then((text) => {
              pid = Number(text);
              return Number.isSafeInteger(pid) && pid! > 0;
            })
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            }),
      );
      receipt.jobId = job.id;
      receipt.before = observe(pid!);
      await progress('actual-descendant-ready');
      let didExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        didExit = resolve;
      });
      off = installExitGuard(runtime, (code) => {
        receipt.exitCallbackAt = Date.now();
        try {
          receipt.exitCallback = {
            code,
            pid: pidProbe(pid!),
            identity: observe(pid!),
            job: runtime.jobs.get(job.id),
          };
        } catch (error) {
          receipt.exitCallbackObservationError = describe(error);
        } finally {
          didExit(code);
        }
      });
      await progress('before-real-signal');
      receipt.signalAt = Date.now();
      process.emit('SIGTERM');
      assert.equal(await exited, 143);
      assert.equal(runtime.jobs.get(job.id)!.status, 'stopped');
      assert.throws(() => process.kill(pid!, 0));
      const history = new CheckpointStore(root);
      try {
        assert.equal(
          history
            .messages(runtime.session.id)
            .some((message) => message.internal === 'job_notice'),
          false,
        );
      } finally {
        history.close();
      }
    } catch (error) {
      failure = error;
      receipt.failure = describe(error);
      if (pid)
        try {
          receipt.afterFailure = { pid: pidProbe(pid), identity: observe(pid) };
        } catch (observationError) {
          receipt.observationError = describe(observationError);
        }
    } finally {
      off();
      await progress('before-final-cleanup');
      try {
        await runtime.close();
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (error) {
        receipt.cleanupError = describe(error);
        failure = failure
          ? new AggregateError(
              [failure, error],
              'actual signal and cleanup failed',
            )
          : error;
      }
      receipt.status = failure ? 'failed' : 'passed';
      receipt.finishedAt = Date.now();
      receipt.resources = process.getActiveResourcesInfo();
      await writeFile(path, JSON.stringify(receipt, null, 2));
      t.diagnostic(
        JSON.stringify({
          kind: 'actual Windows exit-guard descendant and folder release',
          path,
          status: receipt.status,
        }),
      );
    }
    if (failure) throw failure;
  },
);
