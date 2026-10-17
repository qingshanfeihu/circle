import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runtimeTestArguments,
  runtimeTestGroups,
  runRuntimeTestGroups,
  orderRuntimeTestFiles,
  WINDOWS_NATIVE_TEST_PRIORITY,
} from '../scripts/runtime-test-options.mjs';
const exec = promisify(execFile);
const tsx = fileURLToPath(
  new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);

test('runtime test runner retains every file, uses two real file workers and emits immediate TAP failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-runtime-workers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = join(directory, 'events.jsonl');
  const files = await Promise.all(
    [0, 1, 2].map(async (id) => {
      const file = join(directory, `worker-${id}.test.mjs`);
      await writeFile(
        file,
        `import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';
    const record=event=>appendFileSync(${JSON.stringify(events)},JSON.stringify({event,id:${id}})+'\\n');
    test('real worker ${id}',async()=>{record('start');try{await setTimeout(500);${id === 2 ? "assert.equal('observed','expected');" : ''}}finally{record('end')}});`,
      );
      return file;
    }),
  );
  const args = runtimeTestArguments(tsx, files, { ci: true });
  assert.deepEqual(args.slice(-3), files);
  assert.ok(args.includes('--test-concurrency=2'));
  assert.ok(args.includes('--test-timeout=240000'));
  let output = '';
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    exec(process.execPath, args, { timeout: 15_000, env }),
    (error: unknown) => {
      const failed = error as { code: number; stdout: string };
      assert.equal(failed.code, 1);
      output = failed.stdout;
      return true;
    },
  );
  assert.match(output, /not ok .*real worker 2/);
  assert.match(output, /expected: 'expected'/);
  assert.match(output, /actual: 'observed'/);
  const live = new Set<number>();
  const completed = new Set<number>();
  let peak = 0;
  for (const line of (await readFile(events, 'utf8')).trim().split('\n')) {
    const entry = JSON.parse(line) as { id: number; event: string };
    if (entry.event === 'start') live.add(entry.id);
    else {
      live.delete(entry.id);
      completed.add(entry.id);
    }
    peak = Math.max(peak, live.size);
  }
  assert.equal(peak, 2);
  assert.deepEqual([...completed].sort(), [0, 1, 2]);
  assert.equal(live.size, 0);
  assert.equal(
    runtimeTestArguments(tsx, files).includes('--test-reporter=tap'),
    false,
  );
  assert.equal(
    runtimeTestArguments(tsx, files).some((arg) =>
      arg.startsWith('--test-timeout'),
    ),
    false,
  );
});

test('Windows native priority retains each discovered file exactly once and leaves the remaining inventory sorted', () => {
  const remaining = [
    'z-last.test.ts',
    'aaa-first.test.ts',
    'workspace-event-stream.test.ts',
  ];
  const inventory = [...remaining, ...WINDOWS_NATIVE_TEST_PRIORITY].reverse();
  const actual = orderRuntimeTestFiles(inventory, 'win32');
  assert.deepEqual(actual, [
    ...WINDOWS_NATIVE_TEST_PRIORITY,
    ...remaining.sort(),
  ]);
  assert.equal(actual.length, inventory.length);
  assert.equal(new Set(actual).size, inventory.length);
  assert.deepEqual([...actual].sort(), [...inventory].sort());
  assert.deepEqual(
    orderRuntimeTestFiles([...inventory].reverse(), 'win32'),
    actual,
  );
  assert.deepEqual(
    orderRuntimeTestFiles(inventory, 'linux'),
    [...inventory].sort(),
  );
  assert.deepEqual(orderRuntimeTestFiles(['only.test.ts'], 'win32'), [
    'only.test.ts',
  ]);
  assert.throws(
    () => orderRuntimeTestFiles(['same.test.ts', 'same.test.ts'], 'win32'),
    /duplicate/,
  );
});

test('Windows priority child completes before remaining children start and all files run once despite failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-runtime-stages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = join(directory, 'events.jsonl');
  const names = [
    'aaa-first.test.mjs',
    'workspace-terminal-windows.test.ts',
    'zzz-last.test.mjs',
  ];
  const files = await Promise.all(
    names.map(async (name, index) => {
      const file = join(directory, name);
      await writeFile(
        file,
        `import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';test('stage-${index}',async()=>{const record=event=>appendFileSync(${JSON.stringify(events)},JSON.stringify({event,id:${index}})+'\\n');record('start');try{await setTimeout(80);${index === 1 ? 'assert.fail("intentional priority failure");' : ''}}finally{record('end')}});`,
      );
      return file;
    }),
  );
  const groups = runtimeTestGroups(files, 'win32');
  assert.deepEqual(
    groups.map((group) => group.name),
    ['windows-native', 'remaining'],
  );
  assert.deepEqual(
    groups.flatMap((group) => group.files).sort(),
    [...files].sort(),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const receiptDirectory = join(directory, 'receipts');
  const result = runRuntimeTestGroups({
    executable: process.execPath,
    tsxPath: tsx,
    groups,
    env,
    ci: true,
    receiptDirectory,
    stdio: 'pipe',
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.receipts.map((receipt) => receipt.status),
    ['failed', 'passed'],
  );
  const entries = (await readFile(events, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: number; event: string });
  assert.deepEqual(entries.slice(0, 2), [
    { event: 'start', id: 1 },
    { event: 'end', id: 1 },
  ]);
  // On CI only the failing test runs a second time; it fails again.
  for (const id of [0, 1, 2]) {
    assert.equal(
      entries.filter((entry) => entry.id === id && entry.event === 'start')
        .length,
      id === 1 ? 2 : 1,
    );
    assert.equal(
      entries.filter((entry) => entry.id === id && entry.event === 'end')
        .length,
      id === 1 ? 2 : 1,
    );
  }
  assert.equal(result.receipts[0]!.attempts.length, 2);
  assert.equal(result.receipts[0]!.flaky, undefined);
  assert.equal(result.receipts[1]!.attempts.length, 1);
  assert.equal(
    JSON.parse(
      await readFile(
        join(receiptDirectory, 'stage-1-windows-native.json'),
        'utf8',
      ),
    ).status,
    'failed',
  );
  assert.equal(
    JSON.parse(
      await readFile(join(receiptDirectory, 'stage-2-remaining.json'), 'utf8'),
    ).status,
    'passed',
  );
});

test('stage receipts flush a writable descriptor before rename under Windows-style fsync permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-runtime-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'receipt.test.mjs');
  await writeFile(
    file,
    "import test from 'node:test';test('real child',()=>{});",
  );
  const modes = new Map<number, fs.OpenMode>();
  const actualOpen = fs.openSync;
  const actualSync = fs.fsyncSync;
  let flushed = 0;
  const open = t.mock.method(
    fs,
    'openSync',
    (...args: Parameters<typeof fs.openSync>) => {
      const fd = actualOpen(...args);
      modes.set(fd, args[1]);
      return fd;
    },
  );
  const flush = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (modes.get(fd) === 'r')
      throw Object.assign(new Error('Windows read-only flush denied'), {
        code: 'EPERM',
      });
    assert.ok(modes.get(fd), 'flush descriptor came from explicit open');
    flushed++;
    actualSync(fd);
  });
  syncBuiltinESMExports();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = runRuntimeTestGroups({
      executable: process.execPath,
      tsxPath: tsx,
      groups: [{ name: 'all', files: [file] }],
      env,
      ci: true,
      receiptDirectory: directory,
      stdio: 'pipe',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(
      flushed,
      2,
      'started and completed receipts both reach storage',
    );
    assert.equal(
      JSON.parse(await readFile(join(directory, 'stage-1-all.json'), 'utf8'))
        .status,
      'passed',
    );
  } finally {
    open.mock.restore();
    flush.mock.restore();
    syncBuiltinESMExports();
  }
});

test('on CI a test that fails once runs again alone, and the stage passes as flaky', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-runtime-rerun-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = join(directory, 'runs.jsonl');
  const file = join(directory, 'rerun.test.mjs');
  await writeFile(
    file,
    `import test from 'node:test';import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const log=name=>appendFileSync(${JSON.stringify(runs)},name+'\\n');
test('steady',()=>log('steady'));
test('flaky',()=>{log('flaky');const mark=${JSON.stringify(join(directory, 'failed-once'))};if(!existsSync(mark)){writeFileSync(mark,'');throw Error('first attempt fails');}});`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ci = runRuntimeTestGroups({
    executable: process.execPath,
    tsxPath: tsx,
    groups: [{ name: 'all', files: [file] }],
    env,
    ci: true,
    receiptDirectory: join(directory, 'ci'),
    stdio: 'pipe',
  });
  assert.equal(ci.exitCode, 0);
  assert.equal(ci.receipts[0]!.flaky, true);
  assert.deepEqual(
    ci.receipts[0]!.attempts.map((attempt) => attempt.exitCode),
    [1, 0],
  );
  assert.deepEqual((await readFile(runs, 'utf8')).trim().split('\n'), [
    'steady',
    'flaky',
    'flaky',
  ]);
  // Outside CI nothing runs twice.
  await rm(join(directory, 'failed-once'));
  await rm(runs);
  const local = runRuntimeTestGroups({
    executable: process.execPath,
    tsxPath: tsx,
    groups: [{ name: 'all', files: [file] }],
    env,
    receiptDirectory: join(directory, 'local'),
    stdio: 'pipe',
  });
  assert.equal(local.exitCode, 1);
  assert.equal(local.receipts[0]!.attempts.length, 1);
  assert.deepEqual((await readFile(runs, 'utf8')).trim().split('\n'), [
    'steady',
    'flaky',
  ]);
});
