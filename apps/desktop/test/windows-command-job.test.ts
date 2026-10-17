import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WindowsCommandJob,
  loadWindowsJobApi,
  type WindowsJobApi,
} from '../src/workspace/windows-command-job.ts';
import { patience } from './helpers/patience.mjs';

function fake(overrides: Partial<WindowsJobApi> = {}) {
  const calls: string[] = [];
  let assigned = false;
  const api: WindowsJobApi = {
    create: () => {
      calls.push('create');
      return 1n;
    },
    configure: () => {
      calls.push('configure');
    },
    open: () => 2n,
    processId: () => 42,
    creationTime: () => BigInt(Date.now()) * 10000n + 116444736000000000n,
    image: () => process.execPath,
    exited: () => false,
    exitCode: () => 1,
    assign: () => {
      calls.push('assign');
      assigned = true;
    },
    contains: () => assigned,
    members: () => [42],
    terminate: () => {
      calls.push('terminate');
    },
    close: (handle) => {
      calls.push('close:' + handle);
    },
    ...overrides,
  };
  return { api, calls };
}
const options = () => ({
  pid: 42,
  authenticatedPid: 42,
  executable: process.execPath,
  launchedAfter: Date.now() - 1000,
  now: Date.now() + 1000,
});
test('Windows Job requires authenticated live image/creation identity before assignment and never signals a PID', () => {
  const f = fake(),
    job = new WindowsCommandJob(f.api);
  assert.throws(
    () => job.assignWrapper({ ...options(), authenticatedPid: 43 }),
    /identity/,
  );
  assert.equal(f.calls.includes('assign'), false);
  job.assignWrapper(options());
  assert.equal(job.onlyWrapper(), true);
  job.terminate();
  job.dispose();
  job.dispose();
  assert.deepEqual(f.calls, [
    'create',
    'configure',
    'assign',
    'terminate',
    'close:1',
    'close:2',
  ]);
});
for (const [label, override] of [
  ['old creation', { creationTime: () => 1n }],
  ['exited', { exited: () => true }],
  ['wrong handle PID', { processId: () => 43 }],
] as const)
  test(`Windows Job rejects ${label} without assigning or terminating an unproved process`, () => {
    const f = fake(override),
      job = new WindowsCommandJob(f.api);
    assert.throws(() => job.assignWrapper(options()), /identity/);
    assert.equal(f.calls.includes('assign'), false);
    assert.equal(f.calls.includes('terminate'), false);
    job.dispose();
  });
test('Windows Job permission errors propagate and count-one never substitutes member identity', () => {
  const f = fake({ members: () => [99] }),
    job = new WindowsCommandJob(f.api);
  job.assignWrapper(options());
  assert.equal(job.onlyWrapper(), false);
  job.dispose();
  const denied = fake({
      assign: () => {
        throw Error('access denied');
      },
    }),
    other = new WindowsCommandJob(denied.api);
  assert.throws(() => other.assignWrapper(options()), /access denied/);
  other.dispose();
});
test(
  'real Windows Job controls an assigned quiescent Node and inherited detached child through retained handles',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const api = await loadWindowsJobApi(),
      launchedAfter = Date.now(),
      child = spawn(
        process.execPath,
        [
          '-e',
          `process.send({pid:process.pid});process.on('message',m=>{if(m==='start'){require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();process.send({started:true});}});setInterval(()=>{},1000);`,
        ],
        {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        },
      );
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    let job: WindowsCommandJob | undefined;
    t.after(async () => {
      job?.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    });
    const hello = await new Promise<{ pid: number }>((resolve) =>
      child.once('message', (m) => resolve(m as { pid: number })),
    );
    job = new WindowsCommandJob(api);
    job.assignWrapper({
      pid: child.pid!,
      authenticatedPid: hello.pid,
      executable: process.execPath,
      launchedAfter,
    });
    child.send('start');
    await new Promise<void>((resolve) =>
      child.once('message', () => resolve()),
    );
    const deadline = Date.now() + patience(5000);
    while (job.members().length < 2 && Date.now() < deadline) await delay(10);
    assert.equal(
      job.members().length,
      2,
      'actual detached CreateProcess child remains in Job',
    );
    job.terminate();
    await closed;
    while (job.members().length && Date.now() < deadline) await delay(10);
    assert.deepEqual(job.members(), []);
  },
);

test('Windows actual root exit code comes only from a retained Job-member handle after its native wait is signalled', () => {
  let exited = false;
  const f = fake({
    open: (pid) => (pid === 43 ? 3n : 2n),
    processId: (handle) => (handle === 3n ? 43 : 42),
    exited: () => exited,
    exitCode: () => 0xc000013a,
  });
  const job = new WindowsCommandJob(f.api);
  job.assignWrapper(options());
  job.captureRoot(43);
  assert.throws(() => job.actualRootExitCode(), /unconfirmed/);
  exited = true;
  assert.equal(job.actualRootExitCode(), 0xc000013a);
  job.dispose();
  assert.equal(
    f.calls.filter((call) => call === 'close:2' || call === 'close:3').length,
    2,
    'both retained process handles are closed',
  );
  const unbound = new WindowsCommandJob(fake().api);
  assert.throws(() => unbound.actualRootExitCode(), /unconfirmed/);
  unbound.dispose();
});
