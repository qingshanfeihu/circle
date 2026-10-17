import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { terminalInputChunks } from '../../workbench/src/model/terminal-stream.ts';
import {
  TerminalManager,
  type TerminalEvent,
  type TerminalManagerOptions,
  type TerminalSnapshot,
} from '../src/workspace/terminal.ts';

const owner = 'human:test-workspace';
const unix = process.platform !== 'win32';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) =>
  `${quote(process.execPath)} -e ${quote(script)}\r`;

async function wait(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 8000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(`timed out: ${description}`);
    await delay(15);
  }
}

async function setup(
  t: TestContext,
  overrides: Partial<TerminalManagerOptions> = {},
  callback?: (event: TerminalEvent) => void | Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-pty-'));
  const workspace = join(root, 'workspace');
  const logRoot = join(root, 'logs');
  const home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const events: TerminalEvent[] = [];
  const options: TerminalManagerOptions = {
    workspaceRoot: workspace,
    logRoot,
    shellAllowlist: ['/bin/sh'],
    env: {
      HOME: home,
      PS1: 'CIRCLE_TEST> ',
      HISTFILE: '/dev/null',
      ENV: '/dev/null',
    },
    stopGraceMs: 150,
    ...overrides,
  };
  const manager = new TerminalManager(options, async (event) => {
    events.push(event);
    await callback?.(event);
  });
  t.after(async () => {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { manager, root, workspace, logRoot, events, options };
}

async function shell(
  manager: TerminalManager,
  log: TerminalEvent[],
): Promise<TerminalSnapshot> {
  const terminal = await manager.create({ owner, sessionId: 'session-a' });
  await manager.write(
    owner,
    terminal.id,
    "stty -echo; printf '__ECHO_OFF__\\n'\r",
  );
  await wait(
    () => log.some((event) => event.data?.includes('__ECHO_OFF__\r\n')),
    'disable command echo',
    // A shell starts slowly while the whole desktop suite runs on CI.
    20000,
  );
  return terminal;
}

test(
  'real PTY accepts interactive input and reports both terminal streams',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.write(
      owner,
      terminal.id,
      node(
        "console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY); process.stdin.once('data',d=>{console.log('READ:'+d.toString().trim());process.exit(0)})",
      ),
    );
    await wait(
      () => events.some((event) => event.data?.includes('TTY:true:true')),
      'real isTTY',
    );
    await manager.write(owner, terminal.id, 'hello terminal\r');
    await wait(
      () => events.some((event) => event.data?.includes('READ:hello terminal')),
      'actual stdin delivery',
    );
    await manager.write(owner, terminal.id, "printf 'SHELL_STILL_ALIVE\\n'\r");
    await wait(
      () => events.some((event) => event.data?.includes('SHELL_STILL_ALIVE')),
      'shell remains available',
    );
    assert.equal((await manager.list(owner))[0]!.status, 'running');
  },
);

test(
  'resize reaches the real PTY and Ctrl+C interrupts foreground command without ending shell',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.resize(owner, terminal.id, 119, 37);
    await manager.write(owner, terminal.id, 'stty size\r');
    await wait(
      () => events.some((event) => /37 119/.test(event.data ?? '')),
      'PTY resize',
    );
    await manager.write(
      owner,
      terminal.id,
      node("console.log('COMMAND_WAITING');setInterval(()=>{},1000)"),
    );
    await wait(
      () => events.some((event) => event.data?.includes('COMMAND_WAITING')),
      'foreground running',
    );
    const request = await manager.signal(owner, terminal.id, 'SIGINT');
    assert.equal(request.status, 'running');
    await manager.write(owner, terminal.id, "printf 'AFTER_INTERRUPT\\n'\r");
    await wait(
      () => events.some((event) => event.data?.includes('AFTER_INTERRUPT')),
      'shell returned after interrupt',
    );
    assert.equal(
      events.some((event) => event.kind === 'exit'),
      false,
    );
  },
);

test(
  'large multilingual paste crosses bounded input messages without losing bytes',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const payload = '😃中'.repeat(50000);
    const expected = createHash('sha256').update(payload).digest('hex');
    const script = `let b=Buffer.alloc(0);process.stdin.setRawMode(true);console.log('INPUT_READY');process.stdin.on('data',d=>{b=Buffer.concat([b,d]);if(b.length>=${Buffer.byteLength(payload)}){console.log('INPUT_SHA:'+require('node:crypto').createHash('sha256').update(b).digest('hex'));process.stdin.setRawMode(false);process.exit(0)}})`;
    await manager.write(owner, terminal.id, node(script));
    await wait(
      () => events.some((event) => event.data?.includes('INPUT_READY')),
      'raw input reader',
    );
    for (const part of terminalInputChunks(payload))
      await manager.write(owner, terminal.id, part);
    await wait(
      () =>
        events.some((event) => event.data?.includes(`INPUT_SHA:${expected}`)),
      'large input actual checksum',
    );
  },
);

test(
  'real exit code and stop requests are distinct and ordered',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.write(owner, terminal.id, 'exit 7\r');
    await wait(
      async () => (await manager.list(owner))[0]?.status === 'exited',
      'shell exit',
    );
    const stopped = await manager.close(owner, terminal.id);
    assert.equal(stopped.exitCode, 7);
    assert.equal(stopped.signal, undefined);
    assert.equal(stopped.requestedSignal, undefined);
    const replay = await manager.replay(owner, terminal.id);
    assert.equal(replay.events.at(-1)?.kind, 'exit');
    assert.equal(replay.events.at(-1)?.snapshot?.exitCode, 7);
    assert.ok(events.every((event, index) => event.sequence === index + 1));
    await assert.rejects(
      manager.write(owner, terminal.id, 'anything'),
      /not running/,
    );
  },
);

test(
  'owner, directory and shell boundaries are enforced before any process is started',
  { skip: !unix },
  async (t) => {
    const { manager, workspace, root } = await setup(t);
    const terminal = await manager.create({ owner, sessionId: 'session-a' });
    assert.deepEqual(await manager.list('other-owner'), []);
    await assert.rejects(
      manager.write('other-owner', terminal.id, 'echo leak\r'),
      /not found/,
    );
    await assert.rejects(
      manager.resize('other-owner', terminal.id, 80, 24),
      /not found/,
    );
    await assert.rejects(
      manager.replay('other-owner', terminal.id),
      /not found/,
    );
    await assert.rejects(
      manager.close('other-owner', terminal.id),
      /not found/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', cwd: root }),
      /outside/,
    );
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(workspace, 'escape'));
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', cwd: join(workspace, 'escape') }),
      /outside/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', shell: '/usr/bin/env' }),
      /not allowed/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', args: ['-c', 'echo bypass'] }),
      /startup flags/,
    );
    await assert.rejects(
      manager.resize(owner, terminal.id, 0, 24),
      /dimensions/,
    );
    await assert.rejects(
      manager.write(owner, terminal.id, 'a'.repeat(300000)),
      /too large/,
    );
  },
);

test(
  'complete logs replay beyond the bounded ring and survive application restart',
  { skip: !unix },
  async (t) => {
    const { manager, events, options } = await setup(t, { ringBytes: 32768 });
    const terminal = await shell(manager, events);
    const expected = Array.from(
      { length: 2000 },
      (_, index) =>
        `ROW_${String(index).padStart(4, '0')}_${'x'.repeat(160)}😃`,
    ).join('\r\n');
    await manager.write(
      owner,
      terminal.id,
      node(
        "for(let i=0;i<2000;i++)console.log('ROW_'+String(i).padStart(4,'0')+'_'+'x'.repeat(160)+'😃');console.log('LOG_COMPLETE')",
      ),
    );
    await wait(
      () => events.some((event) => event.data?.includes('LOG_COMPLETE')),
      'large output',
    );
    await manager.close(owner, terminal.id);
    const raw = await readFile(terminal.logPath, 'utf8');
    let evidence: string | undefined;
    if (
      !raw.includes(expected) &&
      process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR
    ) {
      const directory = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR;
      await mkdir(directory, { recursive: true });
      evidence = join(directory, `full-log-${process.platform}-${terminal.id}`);
      const offset = raw.indexOf('ROW_0000_');
      let firstMismatch = 0;
      while (
        firstMismatch < expected.length &&
        raw[offset + firstMismatch] === expected[firstMismatch]
      )
        firstMismatch++;
      await Promise.all([
        writeFile(evidence + '.raw.log', raw),
        writeFile(evidence + '.expected.log', expected),
        writeFile(evidence + '.events.json', JSON.stringify(events, null, 2)),
        writeFile(
          evidence + '.json',
          JSON.stringify(
            {
              terminal,
              stopped: (await manager.list(owner)).find(
                (item) => item.id === terminal.id,
              ),
              expectedBytes: Buffer.byteLength(expected),
              actualBytes: Buffer.byteLength(raw),
              expectedSha256: createHash('sha256')
                .update(expected)
                .digest('hex'),
              actualSha256: createHash('sha256').update(raw).digest('hex'),
              actualRows: raw.match(/ROW_\d{4}_/g),
              firstRowOffset: offset,
              firstMismatch,
              expectedContext: expected.slice(
                Math.max(0, firstMismatch - 80),
                firstMismatch + 80,
              ),
              actualContext: raw.slice(
                Math.max(0, offset + firstMismatch - 80),
                offset + firstMismatch + 80,
              ),
            },
            null,
            2,
          ),
        ),
      ]);
    }
    assert.ok(
      raw.includes(expected),
      evidence
        ? `complete raw output mismatch; original evidence: ${evidence}`
        : 'complete raw output must include all 2000 expected rows',
    );
    let cursor = 0;
    let text = '';
    const sequences: number[] = [];
    for (;;) {
      const replay = await manager.replay(owner, terminal.id, cursor, 7);
      for (const event of replay.events) {
        text += event.kind === 'data' ? (event.data ?? '') : '';
        sequences.push(event.sequence);
      }
      cursor = replay.nextSequence;
      if (!replay.hasMore) break;
    }
    assert.ok(text.includes(expected));
    assert.equal(new Set(sequences).size, sequences.length);
    assert.ok(sequences.every((value, index) => value === index + 1));
    await manager.dispose();
    const restored = new TerminalManager(options, () => undefined);
    t.after(() => restored.dispose());
    const saved = (await restored.list(owner))[0]!;
    assert.equal(saved.status, 'exited');
    assert.equal(saved.id, terminal.id);
    const first = await restored.replay(owner, terminal.id, 0, 5);
    assert.equal(first.events[0]?.kind, 'created');
    assert.equal(first.hasMore, true);
    assert.deepEqual(await restored.list('other-owner'), []);
  },
);

test(
  'slow or failed views preserve full output and do not kill the shell',
  { skip: !unix },
  async (t) => {
    let delayed = 0;
    const { manager, events } = await setup(
      t,
      { eventHighWaterBytes: 32768, ringBytes: 32768 },
      async (event) => {
        if (event.kind === 'data') {
          delayed++;
          await delay(3);
          if (delayed === 2) throw Error('renderer reloaded');
        }
      },
    );
    const terminal = await shell(manager, events);
    await manager.write(
      owner,
      terminal.id,
      node("process.stdout.write('START'+('😃'.repeat(100000))+'END\\n')"),
    );
    await wait(
      async () => (await readFile(terminal.logPath, 'utf8')).includes('END'),
      'output under backpressure',
    );
    await manager.close(owner, terminal.id);
    const text = await readFile(terminal.logPath, 'utf8');
    assert.ok(text.includes('START' + '😃'.repeat(100000) + 'END'));
    assert.equal(text.includes('\uFFFD'), false);
    assert.ok(delayed > 2);
  },
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

test(
  'service readiness, stopping and restart are proven by the real port lifecycle',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const port = await freePort();
    const command = node(
      `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('SERVICE_READY'))`,
    );
    await manager.write(owner, terminal.id, command);
    await wait(
      () => events.some((event) => event.data?.includes('SERVICE_READY')),
      'real service ready',
    );
    assert.equal(await portAvailable(port), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
    await manager.close(owner, terminal.id);
    await wait(() => portAvailable(port), 'service port released');
    const restarted = await manager.restart(owner, terminal.id);
    assert.equal(restarted.restartOf, terminal.id);
    assert.notEqual(restarted.id, terminal.id);
    assert.equal(
      await portAvailable(port),
      true,
      'restart must not silently replay the previous command',
    );
    await manager.write(owner, restarted.id, command);
    await wait(
      async () => !(await portAvailable(port)),
      'service ready after explicit restart input',
    );
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
    await manager.close(owner, restarted.id);
    await wait(() => portAvailable(port), 'restarted service released');
  },
);

test(
  'restoring an unconfirmed old process never reexecutes commands or signals an old PID',
  { skip: !unix },
  async (t) => {
    const { manager, options, logRoot } = await setup(t);
    const terminal = await manager.create({ owner, sessionId: 'session-a' });
    await manager.close(owner, terminal.id);
    const path = join(logRoot, terminal.id, 'metadata.json');
    const metadata = JSON.parse(
      await readFile(path, 'utf8'),
    ) as TerminalSnapshot;
    metadata.status = 'running';
    metadata.pid = process.pid;
    const lastSequence = metadata.lastSequence;
    metadata.lastSequence = 0;
    await writeFile(path, JSON.stringify(metadata));
    await appendFile(
      join(logRoot, terminal.id, 'events.jsonl'),
      '{"sequence":999999',
    );
    const restored = new TerminalManager(options, () => undefined);
    t.after(() => restored.dispose());
    const saved = (await restored.list(owner))[0]!;
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.pid, undefined);
    assert.equal(saved.lastSequence, lastSequence);
    assert.match(saved.error!, /not confirmed/);
    await restored.close(owner, terminal.id);
  },
);

test(
  'closing owns only its PTY descendants, including background jobs that ignore graceful stop',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const port = await freePort();
    const unrelated = createServer();
    await new Promise<void>((resolve) =>
      unrelated.listen(0, '127.0.0.1', resolve),
    );
    const unrelatedPort = (unrelated.address() as { port: number }).port;
    t.after(
      () => new Promise<void>((resolve) => unrelated.close(() => resolve())),
    );
    const script = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:net').createServer().listen(${port},'127.0.0.1',()=>console.log('BACKGROUND_READY'))`;
    await manager.write(
      owner,
      terminal.id,
      `${quote(process.execPath)} -e ${quote(script)} &\r`,
    );
    await wait(
      async () => !(await portAvailable(port)),
      'background port ready',
    );
    const stopped = await manager.close(owner, terminal.id);
    assert.equal(stopped.status, 'exited');
    assert.equal(await portAvailable(port), true);
    assert.equal(await portAvailable(unrelatedPort), false);
  },
);

test(
  'parallel owners remain independent and create limits include in-flight creation',
  { skip: !unix },
  async (t) => {
    const { manager } = await setup(t, { maxActive: 2 });
    const results = await Promise.allSettled([
      manager.create({ owner, sessionId: 'session-a' }),
      manager.create({ owner: 'session-b', sessionId: 'session-b' }),
      manager.create({ owner: 'session-c', sessionId: 'session-c' }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      2,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    const a = (await manager.list(owner))[0]!;
    const b = (await manager.list('session-b'))[0]!;
    await manager.close(owner, a.id);
    assert.equal((await manager.list('session-b'))[0]!.status, 'running');
    await manager.write('session-b', b.id, 'exit\r');
    await wait(
      async () => (await manager.list('session-b'))[0]?.status === 'exited',
      'independent shell exits',
    );
  },
);

test(
  'managed service readiness checks real HTTP and restart retains service identity and exact argv',
  { skip: !unix },
  async (t) => {
    const { manager, workspace, events } = await setup(t);
    const port = await freePort();
    const marker = 'spaces "quotes" $HOME $(not-a-command)';
    const script = join(workspace, 'service.cjs');
    await writeFile(
      script,
      `const [port,value]=process.argv.slice(2);require('node:http').createServer((q,s)=>s.end(value)).listen(Number(port),'127.0.0.1',()=>{process.stdout.write('SERVICE_');setTimeout(()=>console.log('READY'),20)})`,
    );
    const original = await manager.create({
      owner,
      sessionId: 'service-session',
      label: 'web preview',
      command: { file: process.execPath, args: [script, String(port), marker] },
      readiness: { pattern: 'SERVICE_READY', port, timeoutMs: 3000 },
    });
    await wait(
      async () =>
        (await manager.list(owner)).find((item) => item.id === original.id)
          ?.serviceState === 'ready',
      'managed service ready',
    );
    const ready = (await manager.list(owner)).find(
      (item) => item.id === original.id,
    )!;
    assert.equal(ready.readiness?.matchedPattern, true);
    assert.equal(ready.readiness?.portOpen, true);
    assert.ok(ready.readiness?.readyAt);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      marker,
    );
    const restarted = await manager.restart(owner, original.id);
    assert.equal(restarted.serviceId, original.serviceId);
    assert.notEqual(restarted.epoch, original.epoch);
    assert.notEqual(restarted.id, original.id);
    assert.deepEqual(restarted.command, original.command);
    await wait(
      async () =>
        (await manager.list(owner)).find((item) => item.id === restarted.id)
          ?.serviceState === 'ready',
      'service automatically ready after restart',
    );
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      marker,
    );
    const old = (await manager.list(owner)).find(
      (item) => item.id === original.id,
    )!;
    assert.equal(old.serviceState, 'stopped');
    assert.ok(old.exitReason);
    const stopped = await manager.close(owner, restarted.id);
    assert.equal(stopped.serviceState, 'stopped');
    assert.equal(await portAvailable(port), true);
    assert.equal(events.filter((event) => event.kind === 'ready').length, 2);
  },
);

test(
  'readiness timeout is explicit while the owned service remains available to stop',
  { skip: !unix },
  async (t) => {
    const { manager } = await setup(t);
    const port = await freePort();
    const service = await manager.create({
      owner,
      sessionId: 'service-session',
      command: {
        file: process.execPath,
        args: ['-e', "console.log('READY');setInterval(()=>{},1000)"],
      },
      // Long enough for Node to start and print READY on a slow runner; the
      // port never opens.
      readiness: { pattern: 'READY', port, timeoutMs: 2000 },
    });
    await wait(
      async () => (await manager.list(owner))[0]?.readiness?.state === 'failed',
      'readiness timeout',
    );
    const failed = (await manager.list(owner))[0]!;
    assert.equal(failed.status, 'running');
    assert.equal(failed.serviceState, 'failed');
    assert.equal(failed.readiness?.matchedPattern, true);
    assert.equal(failed.readiness?.portOpen, false);
    assert.match(failed.readiness!.error!, /2000ms/);
    await manager.close(owner, service.id);
  },
);

test(
  'port conflicts, command shape and early process failures have real distinct outcomes',
  { skip: !unix },
  async (t) => {
    const { manager } = await setup(t);
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = (server.address() as { port: number }).port;
    await assert.rejects(
      manager.create({
        owner,
        sessionId: 'a',
        command: { file: process.execPath },
        readiness: { port },
      }),
      /already in use/,
    );
    assert.equal((await manager.list(owner)).length, 0);
    assert.equal(await portAvailable(port), false);
    await assert.rejects(
      manager.create({
        owner,
        sessionId: 'a',
        command: { file: process.execPath },
        shell: '/bin/sh',
      }),
      /either/,
    );
    await assert.rejects(
      manager.create({
        owner,
        sessionId: 'a',
        command: { file: process.execPath },
        readiness: { pattern: '' },
      }),
      /pattern/,
    );
    const failed = await manager.create({
      owner,
      sessionId: 'a',
      command: { file: process.execPath, args: ['-e', 'process.exit(3)'] },
      readiness: { pattern: 'NEVER' },
    });
    await wait(
      async () => (await manager.list(owner))[0]?.status === 'exited',
      'early process exit',
    );
    const actual = await manager.close(owner, failed.id);
    assert.equal(actual.serviceState, 'failed');
    assert.equal(actual.exitReason, 'exit 3');
    assert.match(actual.readiness!.error!, /before readiness/);
  },
);

test(
  'an explicit interrupt cancels a pending readiness check instead of reporting service failure',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const service = await manager.create({
      owner,
      sessionId: 'service-session',
      command: {
        file: process.execPath,
        args: ['-e', "console.log('SERVICE_LIVE');setInterval(()=>{},1000)"],
      },
      readiness: { pattern: 'NEVER', timeoutMs: 3000 },
    });
    await wait(
      () => events.some((event) => event.data?.includes('SERVICE_LIVE')),
      'service actually started',
    );
    await manager.signal(owner, service.id, 'SIGINT');
    await wait(
      async () => (await manager.list(owner))[0]?.status === 'exited',
      'service actually interrupted',
    );
    const stopped = await manager.close(owner, service.id);
    assert.equal(stopped.serviceState, 'stopped');
    assert.equal(stopped.readiness?.state, 'cancelled');
    assert.equal(stopped.readiness?.error, undefined);
  },
);

test(
  'localhost services listening only on IPv6 can become ready',
  { skip: !unix },
  async (t) => {
    const { manager } = await setup(t);
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '::1', resolve);
      });
    } catch {
      t.skip('IPv6 loopback is unavailable');
      return;
    }
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const service = await manager.create({
      owner,
      sessionId: 'ipv6-service',
      command: {
        file: process.execPath,
        args: [
          '-e',
          `require('node:http').createServer((q,s)=>s.end('ipv6')).listen(${port},'::1',()=>console.log('IPV6_READY'))`,
        ],
      },
      readiness: { port, pattern: 'IPV6_READY', timeoutMs: 3000 },
    });
    await wait(
      async () => (await manager.list(owner))[0]?.serviceState === 'ready',
      'IPv6-only service ready',
    );
    assert.equal(await (await fetch(`http://[::1]:${port}`)).text(), 'ipv6');
    await manager.close(owner, service.id);
  },
);

test(
  'a slow service can recover to ready after a reported timeout without being restarted',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const port = await freePort();
    const service = await manager.create({
      owner,
      sessionId: 'late-service',
      command: {
        file: process.execPath,
        args: [
          '-e',
          `setTimeout(()=>require('node:http').createServer((q,s)=>s.end('late ready')).listen(${port},'127.0.0.1',()=>console.log('LATE_READY')),400)`,
        ],
      },
      readiness: { port, pattern: 'LATE_READY', timeoutMs: 100 },
    });
    await wait(
      async () => (await manager.list(owner))[0]?.readiness?.state === 'failed',
      'visible readiness timeout',
    );
    await wait(
      async () => (await manager.list(owner))[0]?.readiness?.state === 'ready',
      'late actual readiness',
    );
    const actual = (await manager.list(owner))[0]!;
    assert.equal(actual.pid, service.pid);
    assert.equal(actual.id, service.id);
    assert.equal(actual.readiness?.error, undefined);
    assert.equal(actual.serviceState, 'ready');
    assert.equal(events.filter((event) => event.kind === 'created').length, 1);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      'late ready',
    );
    await manager.close(owner, service.id);
    assert.equal(await portAvailable(port), true);
  },
);

test(
  'trusted per-launch environment preserves debugger bootloader, null removals, exact argv and stdin without entering history',
  { skip: !unix },
  async (t) => {
    const { manager, workspace, logRoot, options } = await setup(t, {
      env: {
        CIRCLE_PTY_REMOVE: 'inherited',
        CIRCLE_PTY_OVERRIDE: 'manager',
        NODE_OPTIONS: '--no-warnings',
      },
    });
    const bootloader = join(workspace, 'debug bootloader.cjs');
    await writeFile(bootloader, 'global.__circleDebugBootloader=true;\n');
    const script =
      "console.log(JSON.stringify({argv:process.argv.slice(1),boot:global.__circleDebugBootloader===true,removed:process.env.CIRCLE_PTY_REMOVE??null,override:process.env.CIRCLE_PTY_OVERRIDE,added:process.env.CIRCLE_PTY_ADDED}));process.stdin.once('data',data=>{console.log('STDIN:'+data.toString().trim());process.exit(0)});";
    const env = {
      NODE_OPTIONS: `--require ${JSON.stringify(bootloader)}`,
      CIRCLE_PTY_REMOVE: null,
      CIRCLE_PTY_OVERRIDE: 'launch',
      CIRCLE_PTY_ADDED: 'per-launch',
    };
    const terminal = await manager.create({
      owner,
      sessionId: 'session-debug',
      cwd: workspace,
      command: {
        file: process.execPath,
        args: ['-e', script, '', 'space argument', ''],
      },
      env,
    });
    await wait(
      async () =>
        (await readFile(terminal.logPath, 'utf8')).includes('"boot":true'),
      'debug bootloader output',
    );
    await manager.write(owner, terminal.id, 'typed through PTY\r');
    await wait(
      async () =>
        (await manager.list(owner)).find((s) => s.id === terminal.id)
          ?.status === 'exited',
      'debug stdin exit',
    );
    const output = await readFile(terminal.logPath, 'utf8');
    assert.ok(
      output.includes(
        JSON.stringify({
          argv: ['', 'space argument', ''],
          boot: true,
          removed: null,
          override: 'launch',
          added: 'per-launch',
        }),
      ),
      output,
    );
    assert.ok(output.includes('STDIN:typed through PTY'));
    const metadata = await readFile(
      join(logRoot, terminal.id, 'metadata.json'),
      'utf8',
    );
    assert.equal(metadata.includes(bootloader), false);
    assert.equal(metadata.includes('NODE_OPTIONS'), false);
    assert.equal(
      JSON.stringify(await manager.list(owner)).includes('NODE_OPTIONS'),
      false,
    );
    const restarted = await manager.restart(owner, terminal.id);
    await wait(
      async () =>
        (await readFile(restarted.logPath, 'utf8')).includes('"boot":true'),
      'debug restart environment preserved',
    );
    await manager.write(owner, restarted.id, 'new stdin\r');
    await wait(
      async () =>
        (await manager.list(owner)).find((s) => s.id === restarted.id)
          ?.status === 'exited',
      'restart stdin exit',
    );
    await assert.rejects(
      manager.create({
        owner,
        sessionId: 'session-debug',
        env: { 'BAD=KEY': 'value' },
      }),
      /invalid terminal environment/,
    );
    await assert.rejects(
      manager.create({
        owner,
        sessionId: 'session-debug',
        env: { BAD: 'value\0suffix' },
      }),
      /invalid terminal environment/,
    );
    await manager.dispose();
    const restored = new TerminalManager(options, () => {});
    try {
      await assert.rejects(
        restored.restart(owner, restarted.id),
        /per-launch environment is unavailable/,
      );
    } finally {
      await restored.dispose();
    }
  },
);

test(
  'a startup persistence failure after spawn stops the shell before rejecting',
  { skip: !unix },
  async (t) => {
    const { manager, logRoot } = await setup(t);
    const require = createRequire(import.meta.url);
    const fsp =
      require('node:fs/promises') as typeof import('node:fs/promises');
    const original = fsp.rename;
    fsp.rename = (async (from, to) => {
      if (
        String(to).startsWith(logRoot) &&
        String(to).endsWith('metadata.json')
      )
        throw Object.assign(Error('injected metadata failure'), {
          code: 'EIO',
        });
      return original(from, to);
    }) as typeof fsp.rename;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        manager.create({ owner, sessionId: 'session-a' }),
        /injected metadata failure/,
      );
    } finally {
      fsp.rename = original;
      syncBuiltinESMExports();
    }
    const [failed] = await manager.list(owner);
    assert.equal(failed!.status, 'failed');
    assert.ok(failed!.pid);
    assert.throws(() => process.kill(failed!.pid!, 0), { code: 'ESRCH' });
    assert.deepEqual(await manager.activeIds(owner), []);
  },
);
