import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TerminalManager,
  type TerminalEvent,
} from '../src/workspace/terminal.ts';
import { patience } from './helpers/patience.mjs';

// No shell syntax or Unix signals: this exact fixture runs under Windows ConPTY.
test(
  'native PTY Node child preserves argv, stdin, resize, Ctrl+C, restart and owned port cleanup',
  { timeout: patience(90_000) },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'circle-portable-pty-'));
    const events: TerminalEvent[] = [];
    const manager = new TerminalManager(
      { workspaceRoot: root, logRoot: join(root, 'logs'), stopGraceMs: 200 },
      (event) => {
        events.push(event);
      },
    );
    const owner = 'portable-pty';
    const output = (id: string) =>
      events
        .filter((e) => e.terminalId === id)
        .map((e) => e.data ?? '')
        .join('');
    const wait = async (predicate: () => boolean | Promise<boolean>) => {
      // Shells start slowly on loaded Intel macOS runners.
      const deadline = Date.now() + 30000;
      while (!(await predicate())) {
        if (Date.now() > deadline)
          throw Error('PTY condition timed out: ' + JSON.stringify(events));
        await delay(20);
      }
    };
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    try {
      const terminal = await manager.create({
        owner,
        sessionId: 'portable',
        command: {
          file: process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
          args: [
            fileURLToPath(
              new URL('./fixtures/native-pty-child.cjs', import.meta.url),
            ),
            String(port),
            '',
            'space argument',
            'quote"literal',
          ],
        },
        cols: 90,
        rows: 30,
        readiness: { pattern: 'CHILD_READY:', port, timeoutMs: 8000 },
      });
      await wait(() => output(terminal.id).includes('CHILD_READY:'));
      assert.match(output(terminal.id), /"tty":\[true,true\]/);
      assert.match(
        output(terminal.id),
        /"argv":\["","space argument","quote\\"literal"\]/,
      );
      await manager.resize(owner, terminal.id, 111, 37);
      // The new size can reach the child after input sent just after the
      // resize (seen on Intel macOS). Ask again until the child reports it.
      let replies = 0;
      await wait(async () => {
        if (
          output(terminal.id).includes('CHILD_REPLY:actual-input:SIZE:111:37')
        )
          return true;
        const seen = output(terminal.id).split('CHILD_REPLY:').length - 1;
        if (seen === replies) {
          replies++;
          await manager.write(owner, terminal.id, 'actual-input\r');
        }
        return false;
      });
      assert.equal(
        await (await fetch(`http://127.0.0.1:${port}`)).text(),
        'owned-child',
      );
      await manager.signal(owner, terminal.id, 'SIGINT');
      await wait(
        async () =>
          (await manager.list(owner)).find((entry) => entry.id === terminal.id)
            ?.exitedAt !== undefined,
      );
      await assert.rejects(fetch(`http://127.0.0.1:${port}`));
      const restarted = await manager.restart(owner, terminal.id);
      assert.equal(restarted.restartOf, terminal.id);
      await wait(() => output(restarted.id).includes('CHILD_READY:'));
      assert.equal(
        await (await fetch(`http://127.0.0.1:${port}`)).text(),
        'owned-child',
      );
      await manager.close(owner, restarted.id);
      await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a Windows owned worker transport fault remains a durable failure and stops the real program',
  {
    skip: process.platform !== 'win32' && 'requires real Windows ConPTY',
    timeout: patience(15000),
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-pty-fault-'));
    const native = createRequire(import.meta.url)(
      'node-pty',
    ) as typeof import('node-pty');
    const spawn = native.spawn;
    let captured: IPty | undefined;
    t.mock.method(
      native,
      'spawn',
      (...args: Parameters<typeof spawn>) => (captured = spawn(...args)),
    );
    const events: TerminalEvent[] = [];
    const manager = new TerminalManager(
      { workspaceRoot: root, logRoot: join(root, 'logs') },
      (event) => {
        events.push(event);
      },
    );
    try {
      const owner = 'worker-fault';
      const terminal = await manager.create({
        owner,
        sessionId: owner,
        command: {
          file: process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
          args: [
            '-e',
            "console.log('FULL_ORIGINAL_PROGRAM_OUTPUT');setInterval(()=>{},1000)",
          ],
        },
      });
      const deadline = Date.now() + patience(8000);
      while (
        !events.some((event) =>
          event.data?.includes('FULL_ORIGINAL_PROGRAM_OUTPUT'),
        )
      ) {
        assert.ok(
          Date.now() < deadline,
          'real program must start before fault injection',
        );
        await delay(20);
      }
      assert.ok(captured);
      // Fault injection targets the real owned transport and verifies the real
      // program, files and observer events. It does not claim to reproduce the
      // platform-dependent late-write race seen in the unmodified Windows CI.
      const worker = (
        captured as unknown as {
          _agent: {
            _conoutSocketWorker: {
              _worker: { emit: (name: string, error: Error) => void };
            };
          };
        }
      )._agent._conoutSocketWorker._worker;
      const fault = Object.assign(
        new Error('deterministic owned transport failure'),
        { code: 'EPIPE' },
      );
      worker.emit('error', fault);
      const stopped = await manager.close(owner, terminal.id);
      assert.equal(stopped.status, 'failed');
      assert.match(
        stopped.error ?? '',
        /EPIPE.*deterministic owned transport failure/,
      );
      assert.throws(() => process.kill(terminal.pid!, 0));
      const replay = await manager.replay(owner, terminal.id);
      assert.ok(
        replay.events.some(
          (event) =>
            event.kind === 'error' && event.data?.includes(fault.message),
        ),
      );
      const metadata = JSON.parse(
        await readFile(
          join(root, 'logs', terminal.id, 'metadata.json'),
          'utf8',
        ),
      );
      assert.equal(metadata.error, stopped.error);
      const raw = await readFile(terminal.logPath, 'utf8');
      assert.ok(raw.includes('FULL_ORIGINAL_PROGRAM_OUTPUT'));
      const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(
          join(evidence, 'worker-transport-fault-win32.json'),
          JSON.stringify(
            {
              snapshot: stopped,
              events: replay.events,
              raw,
              programPidGone: true,
            },
            null,
            2,
          ) + '\n',
        );
      }
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
