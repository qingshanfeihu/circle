import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { TerminalManager } from '../src/workspace/terminal.ts';
import { createTerminalCommandLauncher } from '../src/workspace/command-terminal.ts';
import { renderTerminalOutput } from './helpers/terminal-vt.mjs';
import { patience } from './helpers/patience.mjs';

const win = { skip: process.platform !== 'win32', timeout: 20000 };
async function until(fn: () => Promise<boolean>, label: string) {
  const end = Date.now() + patience(7000);
  while (!(await fn())) {
    if (Date.now() > end)
      throw Error('Windows native fixture timed out: ' + label);
    await delay(20);
  }
}
async function fixture(t: TestContext, supervisorOverride?: string) {
  const root = await mkdtemp(join(tmpdir(), 'circle-win-job-')),
    workspace = join(root, 'workspace'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const output = join(root, 'original.log');
  const outputEvidence: Record<string, unknown> = {};
  await writeFile(output, '');
  const terminals = new TerminalManager(
    {
      workspaceRoot: workspace,
      logRoot: join(root, 'terminals'),
      shellAllowlist: [process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'],
      env: { HOME: home, USERPROFILE: home },
    },
    () => {},
  );
  let active:
    | Awaited<ReturnType<ReturnType<typeof createTerminalCommandLauncher>>>
    | undefined;
  const launcher = createTerminalCommandLauncher({
    terminals,
    runtimeExecutable: process.execPath,
    supervisorPath:
      supervisorOverride ??
      fileURLToPath(
        new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
      ),
    executionEpoch: 'windows-real-job-test',
    windowsJobObject: true,
    stopExecution: async () => {
      if (!active) {
        // A pre-command launcher rejection is returned only after actual PTY/IO
        // closure. No Registry handle exists to stop; assert the real closure.
        const entries = await terminals.list('owner');
        assert.ok(
          entries.every((entry) => entry.status === 'exited'),
          'unallocated command has no live original PTY',
        );
        return;
      }
      await active.stop('fixture cleanup');
    },
  });
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      await active?.stop('fixture cleanup');
    } catch (error) {
      errors.push(error);
    }
    try {
      await terminals.dispose();
    } catch (error) {
      errors.push(error);
    }
    const evidence = join(
      process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ??
        fileURLToPath(
          new URL('../artifacts/runtime-progress', import.meta.url),
        ),
      'windows-command-' + randomUUID(),
    );
    await mkdir(evidence, { recursive: true });
    let raw = '';
    try {
      raw = await readFile(output, 'utf8');
    } catch {}
    await writeFile(join(evidence, 'original.log'), raw);
    await writeFile(
      join(evidence, 'receipt.json'),
      JSON.stringify(
        {
          test: t.name,
          root,
          terminals: await terminals.list('owner'),
          cleanupErrors: errors.map((error) => String(error)),
          outputEvidence,
        },
        null,
        2,
      ),
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        'Windows command fixture cleanup failed; evidence ' + evidence,
      );
    await rm(root, { recursive: true, force: true });
  });
  const run = async (
    body: string,
    extraEnv: NodeJS.ProcessEnv = {},
    userShellId?: string,
  ) => {
    await writeFile(join(workspace, 'program.cjs'), body);
    active = await launcher({
      executionId: 'windows-original',
      origin: {
        executionSessionId: 'owner',
        ...(userShellId ? { userShellId } : { toolCallId: 'call' }),
      },
      notificationOwner: { sessionId: 'owner' },
      command: 'node program.cjs',
      cwd: workspace,
      env: {
        ...process.env,
        ...extraEnv,
        HOME: home,
        USERPROFILE: home,
        PATH: dirname(process.execPath) + delimiter + process.env.PATH,
      },
      outputPath: output,
      signal: new AbortController().signal,
    });
    return active;
  };
  return { root, workspace, terminals, output, outputEvidence, run };
}
function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const c = createConnection({ port, host: '127.0.0.1' });
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

test(
  'Windows original ConPTY input and resistant inherited service stop use real root exit and Job-empty facts',
  win,
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.workspace, 'service.cjs'),
      "const fs=require('fs');require('net').createServer(()=>{}).listen(0,'127.0.0.1',function(){fs.writeFileSync('port',String(this.address().port));});",
    );
    const handle = await f.run(
      "const fs=require('fs');fs.appendFileSync('starts','once\\n');require('child_process').spawn(process.execPath,['service.cjs'],{detached:true,stdio:'inherit'});require('readline').createInterface({input:process.stdin}).on('line',line=>fs.writeFileSync('input',line));console.log('READY');process.stdout.write('尾'.repeat(24000));setInterval(()=>{},1000);",
    );
    assert.equal(handle.kind, 'pty-group');
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    await until(async () => {
      try {
        return Number(await readFile(join(f.workspace, 'port'), 'utf8')) > 0;
      } catch {
        return false;
      }
    }, 'real inherited port');
    const port = Number(await readFile(join(f.workspace, 'port'), 'utf8'));
    assert.equal(await portOpen(port), true);
    await f.terminals.write(
      'owner',
      handle.terminal!.id,
      'same original input\r',
    );
    await until(async () => {
      try {
        return (
          (await readFile(join(f.workspace, 'input'), 'utf8')) ===
          'same original input'
        );
      } catch {
        return false;
      }
    }, 'original stdin');
    await handle.stop('manual stop');
    const exit = await handle.rootExit;
    assert.ok(Number.isInteger(exit.exitCode));
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    assert.equal(await portOpen(port), false);
    assert.equal(await readFile(join(f.workspace, 'starts'), 'utf8'), 'once\n');
    assert.equal(handle.descendantCoverage.snapshot().state, 'unknown');
    const snapshot = (await f.terminals.list('owner'))[0]!;
    assert.ok(snapshot.managedCommand!.completion.rootExit);
    assert.ok(snapshot.managedCommand!.completion.controlledGroupEmpty);
    assert.ok(snapshot.managedCommand!.completion.transportAndLogClosed);
    const rawBytes = await readFile(f.output);
    const raw = rawBytes.toString('utf8');
    const rendered = await renderTerminalOutput(raw, {
      cols: snapshot.cols,
      rows: snapshot.rows,
    });
    // ConPTY can repaint the last double-width cell of a prior screen row.
    // Check the actual terminal cells, not raw printable bytes with duplicates.
    const text = rendered.lines.map((line) => line.text).join('');
    const payload = text.slice(text.indexOf('尾'), text.lastIndexOf('尾') + 1);
    const expected = '尾'.repeat(24000);
    const sha = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    Object.assign(f.outputEvidence, {
      rawBytes: rawBytes.length,
      rawSha256: sha(raw),
      rawTailCharacters: [...raw].filter((char) => char === '尾').length,
      renderedPayloadCharacters: payload.length,
      renderedPayloadBytes: Buffer.byteLength(payload),
      renderedPayloadSha256: sha(payload),
      expectedPayloadSha256: sha(expected),
    });
    assert.equal(payload.length, 24000);
    assert.equal(Buffer.byteLength(payload), 72000);
    assert.equal(sha(payload), sha(expected));
    assert.equal(payload, expected);
    assert.deepEqual(rawBytes, await readFile(snapshot.logPath));
  },
);

test(
  'Windows natural completion waits for actual root ACK, wrapper exit, Job empty and original log closure',
  win,
  async (t) => {
    const f = await fixture(t),
      handle = await f.run(
        "require('fs').writeFileSync('ran','once');console.log('natural-output');",
        {},
        'human-original',
      );
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    assert.equal((await handle.rootExit).exitCode, 0);
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    assert.equal(await readFile(join(f.workspace, 'ran'), 'utf8'), 'once');
    assert.match(await readFile(f.output, 'utf8'), /natural-output/);
    const snapshot = (await f.terminals.list('owner'))[0]!;
    assert.equal(snapshot.managedCommand!.userShellId, 'human-original');
    assert.equal(snapshot.managedCommand!.toolCallId, undefined);
    assert.equal(snapshot.managedCommand!.completion.rootExit!.exitCode, 0);
    assert.equal(
      'remainingProcesses' in snapshot.managedCommand!.completion.rootExit!,
      false,
    );
  },
);

test(
  'Windows supervisor cannot preload command Node options before Job assignment',
  win,
  async (t) => {
    const f = await fixture(t),
      preload = join(f.workspace, 'preload.cjs');
    await writeFile(
      preload,
      "require('fs').appendFileSync('preloaded-pids',String(process.pid)+' ');",
    );
    const handle = await f.run("console.log('preloaded command done');", {
      NODE_OPTIONS: '--require=' + JSON.stringify(preload),
    });
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    const actualExit = await handle.rootExit;
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    assert.equal(actualExit.exitCode, 0, await readFile(f.output, 'utf8'));
    const pids = (await readFile(join(f.workspace, 'preloaded-pids'), 'utf8'))
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.ok(
      pids.length > 0 &&
        pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
      'actual command preserves its own Node options after assignment',
    );
    const wrapper = (await f.terminals.list('owner'))[0]!.pid;
    assert.ok(Number.isSafeInteger(wrapper));
    assert.equal(
      pids.includes(wrapper!),
      false,
      'quiescent supervisor did not execute the command preload',
    );
  },
);

test(
  'Windows invalid supervisor authentication never starts a command and the quiescent original PTY closes',
  win,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'circle-win-denied-')),
      path = join(directory, 'supervisor.mjs');
    const source = await readFile(
      new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
      'utf8',
    );
    const altered = source.replace(
      "JSON.stringify({ kind: 'hello', token, pid: process.pid })",
      "JSON.stringify({ kind: 'invalid-auth', token, pid: process.pid })",
    );
    assert.notEqual(
      altered,
      source,
      'negative fixture changes only actual authentication',
    );
    await writeFile(path, altered);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = await fixture(t, path);
    await assert.rejects(
      f.run("require('fs').writeFileSync('must-not-start','bad');"),
      /Windows actual command exit was not observed/,
    );
    await assert.rejects(readFile(join(f.workspace, 'must-not-start')), {
      code: 'ENOENT',
    });
    const entries = await f.terminals.list('owner');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'exited');
    assert.equal(entries[0]!.managedCommand!.completion.rootExit, undefined);
  },
);
