import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  OperationLedger,
  OperationIdentityConflictError,
  OperationNeedsReviewError,
  OperationRejectedError,
  type OperationIdentity,
} from '../src/workspace/operation-ledger.ts';
import { WorkspaceDocuments } from '../src/workspace/documents.ts';
import { UserShellPreflightError } from '../../../src/user_shell.ts';
import { patience } from './helpers/patience.mjs';
const exec = promisify(execFile);
const paramsHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const identity = (id: string, params = 'fixture'): OperationIdentity => ({
  id,
  sessionId: 'session-a',
  service: 'terminal',
  method: 'write',
  paramsHash: paramsHash(params),
});
async function fixture(t: TestContext, inlineResultBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'circle-operation-ledger-'));
  const directory = join(root, 'private');
  const ledgers: OperationLedger[] = [];
  const open = async () => {
    const ledger = await OperationLedger.open({ directory, inlineResultBytes });
    ledgers.push(ledger);
    return ledger;
  };
  t.after(async () => {
    await Promise.all(ledgers.map((ledger) => ledger.close()));
    await rm(root, { recursive: true, force: true });
  });
  // A ledger opened elsewhere closes before the folder goes: Windows cannot delete an open file.
  const track = (ledger: OperationLedger) => ledgers.push(ledger);
  return { root, directory, open, track };
}
async function bytes(directory: string): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await bytes(path)));
    else if (entry.isFile()) result.push(await readFile(path));
  }
  return result;
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + patience(5000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('effect did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('real Git commit runs once across concurrent duplicates, more than 100 later operations and restart', async (t) => {
  const f = await fixture(t),
    ledger = await f.open(),
    repo = join(f.root, 'repo');
  await mkdir(repo);
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '--initial-branch=main');
  await writeFile(join(repo, 'one.txt'), 'initial');
  await git('add', 'one.txt');
  const commit = () =>
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Update fixture',
    );
  await commit();
  await writeFile(join(repo, 'one.txt'), 'updated');
  let calls = 0;
  const action = async () => {
    calls++;
    await git('add', 'one.txt');
    await commit();
    return { head: await git('rev-parse', 'HEAD') };
  };
  const operation = { ...identity('commit'), service: 'git', method: 'commit' };
  const [a, b] = await Promise.all([
    ledger.run(operation, action),
    ledger.run(operation, action),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  for (let i = 0; i < 150; i++)
    await ledger.run(identity(`other-${i}`), async () => ({ accepted: true }));
  assert.deepEqual(await ledger.run(operation, action), a);
  await ledger.close();
  const restarted = await f.open();
  assert.deepEqual(await restarted.run(operation, action), a);
  assert.equal(calls, 1);
  assert.equal(await git('rev-list', '--count', 'HEAD'), '2');
});

test(
  'actual PTY input is delivered once and never persisted as plaintext',
  {
    skip:
      process.platform === 'win32' &&
      'raw-mode shell fixture is Unix-only; Windows ConPTY is exercised by native journey',
  },
  async (t) => {
    const f = await fixture(t),
      ledger = await f.open(),
      output = join(f.root, 'input.bin');
    const require = createRequire(import.meta.url),
      pty = require('node-pty');
    const secret = 'PRIVATE_STDIN_PASSWORD_6f12cd';
    const terminal = pty.spawn(
      process.execPath,
      [
        '-e',
        `process.stdin.setRawMode(true); process.stdin.on('data',d=>require('node:fs').appendFileSync(${JSON.stringify(output)},d)); console.log('READY');`,
      ],
      { cwd: f.root, cols: 80, rows: 24 },
    );
    let ready = false;
    terminal.onData((data: string) => {
      if (data.includes('READY')) ready = true;
    });
    t.after(() => terminal.kill());
    await until(async () => ready);
    let calls = 0;
    const action = async () => {
      calls++;
      terminal.write(secret);
      return { accepted: true, bytes: secret.length };
    };
    await Promise.all([
      ledger.run(identity('stdin', secret), action),
      ledger.run(identity('stdin', secret), action),
    ]);
    await until(
      async () =>
        (await readFile(output).catch(() => Buffer.alloc(0))).length ===
        secret.length,
    );
    assert.equal(await readFile(output, 'utf8'), secret);
    assert.equal(calls, 1);
    await ledger.close();
    const restarted = await f.open();
    await restarted.run(identity('stdin', secret), action);
    assert.equal(calls, 1);
    for (const file of await bytes(f.directory))
      assert.equal(file.includes(Buffer.from(secret)), false);
  },
);

test('operation id cannot cross session service method or parameter identity', async (t) => {
  const f = await fixture(t),
    ledger = await f.open(),
    op = identity('same');
  let calls = 0;
  await ledger.run(op, async () => ++calls);
  for (const different of [
    { ...op, sessionId: 'session-b' },
    { ...op, service: 'git' },
    { ...op, method: 'close' },
    { ...op, paramsHash: paramsHash('other') },
  ])
    await assert.rejects(
      ledger.run(different, async () => ++calls),
      OperationIdentityConflictError,
    );
  assert.equal(calls, 1);
  await assert.rejects(
    ledger.run({ ...op, id: 'unsafe secret content' }, async () => 0),
    /valid operation identity/,
  );
});

test('results replay exactly while file content and passwords remain encrypted on disk, with large artifacts verified', async (t) => {
  const f = await fixture(t, 64),
    ledger = await f.open();
  const secret = 'PRIVATE_FILE_AND_PASSWORD_b8c921';
  const result = {
    content: secret.repeat(300),
    password: secret,
    revision: 'a',
  };
  await ledger.run(identity('save'), async () => result);
  assert.deepEqual(
    await ledger.run(identity('save'), async () =>
      assert.fail('must not replay effect'),
    ),
    result,
  );
  for (const file of await bytes(f.directory))
    assert.equal(file.includes(Buffer.from(secret)), false);
  const artifacts = await readdir(join(f.directory, 'results'));
  assert.equal(artifacts.length, 1);
  await writeFile(join(f.directory, 'results', artifacts[0]), 'tampered');
  await assert.rejects(
    ledger.run(identity('save'), async () =>
      assert.fail('must not replay effect'),
    ),
    OperationNeedsReviewError,
  );
  assert.equal(ledger.status('save')?.state, 'needs_review');
});

test('crashed operation remains unknown on restart and its real file effect is not repeated', async (t) => {
  const f = await fixture(t),
    effect = join(f.root, 'effect.txt'),
    crash = join(f.root, 'crash.mts');
  const module = pathToFileURL(
    fileURLToPath(
      new URL('../src/workspace/operation-ledger.ts', import.meta.url),
    ),
  ).href;
  await writeFile(
    crash,
    `import {OperationLedger} from ${JSON.stringify(module)};import {appendFileSync} from 'node:fs';const ledger=await OperationLedger.open({directory:${JSON.stringify(f.directory)}});await ledger.run(${JSON.stringify(identity('crash'))},async()=>{appendFileSync(${JSON.stringify(effect)},'once');process.exit(23)});`,
  );
  const tsx = fileURLToPath(
    new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [tsx, crash], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 23, result.stderr);
  const ledger = await f.open();
  assert.equal(ledger.status('crash')?.state, 'needs_review');
  await assert.rejects(
    ledger.run(identity('crash'), async () => writeFile(effect, 'twice')),
    OperationNeedsReviewError,
  );
  assert.equal(await readFile(effect, 'utf8'), 'once');
});

test('typed shell preflight rejections replay fixed safe feedback without executing after restart', async (t) => {
  const f = await fixture(t);
  let ledger = await f.open(),
    attempts = 0;
  const codes = [
    'USER_SHELL_BUSY',
    'USER_SHELL_PLAN_MODE',
    'USER_SHELL_EMPTY',
  ] as const;
  for (const code of codes) {
    const op = { ...identity(code), service: 'shell', method: 'run' };
    const expected = new UserShellPreflightError(code);
    await assert.rejects(
      ledger.run(op, async () => {
        attempts++;
        const error = new UserShellPreflightError(code);
        error.message =
          'PRIVATE mutated diagnostic must not be returned or persisted';
        throw error;
      }),
      (error: unknown) =>
        error instanceof UserShellPreflightError &&
        error.code === code &&
        error.message === expected.message,
    );
    assert.equal(ledger.status(code)?.state, 'rejected');
  }
  await ledger.close();
  ledger = await f.open();
  for (const code of codes) {
    const expected = new UserShellPreflightError(code);
    await assert.rejects(
      ledger.run(
        { ...identity(code), service: 'shell', method: 'run' },
        async () => assert.fail('rejected shell command must never execute'),
      ),
      (error: unknown) =>
        error instanceof UserShellPreflightError &&
        error.code === code &&
        error.message === expected.message,
    );
  }
  assert.equal(attempts, codes.length);
  for (const file of await bytes(f.directory))
    assert.equal(
      file.includes(Buffer.from('PRIVATE mutated diagnostic')),
      false,
    );
});

test('a forged shell error or typed error after a returned effect never becomes a safe preflight rejection', async (t) => {
  const f = await fixture(t),
    ledger = await f.open();
  const effect = join(f.root, 'unknown-effect');
  await assert.rejects(
    ledger.run(
      { ...identity('forged'), service: 'shell', method: 'run' },
      async () => {
        await writeFile(effect, 'once');
        throw Object.assign(
          new Error(new UserShellPreflightError('USER_SHELL_BUSY').message),
          { code: 'USER_SHELL_BUSY' },
        );
      },
    ),
    OperationNeedsReviewError,
  );
  assert.equal(ledger.status('forged')?.state, 'needs_review');
  await assert.rejects(
    ledger.run(
      { ...identity('forged'), service: 'shell', method: 'run' },
      async () => writeFile(effect, 'twice'),
    ),
    OperationNeedsReviewError,
  );
  assert.equal(await readFile(effect, 'utf8'), 'once');
  await assert.rejects(
    ledger.run(identity('wrong-service'), async () => {
      throw new UserShellPreflightError('USER_SHELL_BUSY');
    }),
    OperationNeedsReviewError,
  );
  assert.equal(ledger.status('wrong-service')?.state, 'needs_review');
  const postEffect = await OperationLedger.open({
    directory: join(f.root, 'post-effect'),
    resultCodec: {
      seal: async () => {
        throw new UserShellPreflightError('USER_SHELL_PLAN_MODE');
      },
      unseal: async (value) => value,
    },
  });
  f.track(postEffect);
  await assert.rejects(
    postEffect.run(
      { ...identity('returned'), service: 'shell', method: 'run' },
      async () => {
        await writeFile(join(f.root, 'returned-effect'), 'once');
        return 'effect returned';
      },
    ),
    OperationNeedsReviewError,
  );
  assert.equal(postEffect.status('returned')?.state, 'needs_review');
  assert.equal(await readFile(join(f.root, 'returned-effect'), 'utf8'), 'once');
});

test('errors persist only safe classification and a live owner cannot be opened twice', async (t) => {
  const f = await fixture(t),
    ledger = await f.open();
  const secret = 'PASSWORD_AND_STDIN_4cfb2a';
  let calls = 0;
  await assert.rejects(
    ledger.run(identity('error', secret), async () => {
      calls++;
      throw Error(secret);
    }),
    (error) =>
      error instanceof OperationNeedsReviewError &&
      !error.message.includes(secret),
  );
  await assert.rejects(
    ledger.run(identity('error', secret), async () => {
      calls++;
    }),
    OperationNeedsReviewError,
  );
  assert.equal(calls, 1);
  for (const file of await bytes(f.directory))
    assert.equal(file.includes(Buffer.from(secret)), false);
  await assert.rejects(f.open(), /live owner/);
});

test('PTY-sized operation persistence reports its observed p95 without synchronous workspace snapshots', async (t) => {
  const f = await fixture(t),
    ledger = await f.open(),
    samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    await ledger.run(identity(`latency-${i}`), async () => ({
      accepted: true,
      bytes: 1,
    }));
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  t.diagnostic(
    JSON.stringify({
      metric: 'operation-ledger-p95-ms',
      samples: samples.length,
      p95,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  assert.equal(ledger.status('latency-0')?.state, 'completed');
});

test('cached results preserve optional undefined fields and structured runtime metadata', async (t) => {
  const f = await fixture(t),
    ledger = await f.open();
  const value = {
    exitCode: undefined,
    selected: null,
    at: new Date(0),
    count: 4n,
    bytes: Buffer.from('result'),
  };
  await ledger.run(identity('structured'), async () => value);
  await ledger.close();
  const restarted = await f.open();
  assert.deepEqual(
    await restarted.run(identity('structured'), async () =>
      assert.fail('must replay stored result'),
    ),
    value,
  );
});

test('pending review metadata is safe and explicit acknowledgement never replays the effect', async (t) => {
  const f = await fixture(t),
    ledger = await f.open();
  const secret = 'PRIVATE_REVIEW_NOTE_PASSWORD_7139';
  let calls = 0;
  await assert.rejects(
    ledger.run(identity('pending-review', secret), async () => {
      calls++;
      throw Error(secret);
    }),
    OperationNeedsReviewError,
  );
  const pending = ledger.list({
    sessionId: 'session-a',
    state: 'needs_review',
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'pending-review');
  assert.ok(!JSON.stringify(pending).includes(secret));
  for (const key of ['paramsHash', 'result', 'artifactHash', 'key', 'note'])
    assert.equal(Object.hasOwn(pending[0], key), false);
  assert.throws(
    () => ledger.acknowledgeUnknown('pending-review', { note: '  ' }),
    /non-empty review note/,
  );
  assert.equal(
    ledger.acknowledgeUnknown('pending-review', { note: secret }).state,
    'reconciled',
  );
  assert.equal(
    ledger.acknowledgeUnknown('pending-review', { note: secret }).state,
    'reconciled',
  );
  await assert.rejects(
    ledger.run(identity('pending-review', secret), async () => ++calls),
    /new operation id/,
  );
  assert.equal(calls, 1);
  assert.equal(ledger.list({ state: 'needs_review' }).length, 0);
  await ledger.close();
  const restarted = await f.open();
  assert.equal(restarted.list({ state: 'reconciled' })[0].id, 'pending-review');
  for (const file of await bytes(f.directory))
    assert.equal(file.includes(Buffer.from(secret)), false);
});

test('operation lists are bounded and page by stable ledger cursor', async (t) => {
  const f = await fixture(t),
    ledger = await f.open();
  for (let i = 0; i < 4; i++)
    await ledger.run(identity(`page-${i}`), async () => ({ accepted: true }));
  const first = ledger.list({ limit: 2 });
  const second = ledger.list({ limit: 2, before: first[1].cursor });
  assert.deepEqual(
    [...first, ...second].map((item) => item.id),
    ['page-3', 'page-2', 'page-1', 'page-0'],
  );
  assert.throws(() => ledger.list({ limit: 501 }), /list bounds/);
  assert.throws(
    () => ledger.acknowledgeUnknown('page-0', { note: 'already completed' }),
    /only an operation needing review/,
  );
});

test('single-file CAS rejection preserves conflict feedback and never claims unknown side effects', async (t) => {
  const f = await fixture(t),
    ledger = await f.open(),
    workspace = join(f.root, 'documents');
  await mkdir(workspace);
  const path = join(workspace, 'private-file.txt');
  await writeFile(path, 'baseline');
  const documents = new WorkspaceDocuments(workspace);
  t.after(() => documents.close());
  const baseline = await documents.read('private-file.txt');
  await writeFile(path, 'external edit');
  const op = {
    ...identity('cas', 'draft'),
    service: 'documents',
    method: 'save',
  };
  let calls = 0;
  const action = async () => {
    calls++;
    return documents.save('private-file.txt', 'draft', baseline.revision);
  };
  await assert.rejects(
    ledger.run(op, action),
    (error) =>
      error instanceof OperationRejectedError &&
      error.message.includes('file changed on disk') &&
      !error.message.includes('private-file.txt'),
  );
  await assert.rejects(ledger.run(op, action), OperationRejectedError);
  assert.equal(calls, 1);
  assert.equal(await readFile(path, 'utf8'), 'external edit');
  assert.equal(ledger.status('cas')?.state, 'rejected');
  assert.equal(ledger.list({ state: 'needs_review' }).length, 0);
  assert.equal(
    ledger.list({ state: 'rejected' })[0].errorCode,
    'DOCUMENT_CONFLICT',
  );
  // An arbitrary service claiming this error code has no no-effect guarantee.
  await assert.rejects(
    ledger.run(identity('untrusted-conflict'), async () => {
      throw Object.assign(Error('private'), { code: 'DOCUMENT_CONFLICT' });
    }),
    OperationNeedsReviewError,
  );
});
