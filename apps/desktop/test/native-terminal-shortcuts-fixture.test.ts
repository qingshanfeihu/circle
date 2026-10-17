import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalManager } from '../src/workspace/terminal.ts';
import { execFileSync } from 'node:child_process';
import { patience } from './helpers/patience.mjs';

const helperURL = new URL(
  './helpers/native-terminal-shortcuts-journey.mjs',
  import.meta.url,
).href;
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + patience(8000);
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('shortcut fixture: ' + label);
    await delay(10);
  }
}

test(
  'native shortcut fixture keeps exact stdin and handles the real TTY interrupt before the same shell continues',
  { timeout: patience(15000) },
  async (t) => {
    const helper = await import(helperURL);
    const root = await mkdtemp(join(tmpdir(), 'circle-shortcut-fixture-'));
    const home = join(root, 'home');
    await mkdir(home);
    const fixture = await helper.createNativeTerminalShortcutsFixture(root);
    execFileSync(process.execPath, [
      '--check',
      join(root, fixture.paths.program),
    ]);
    const manager = new TerminalManager(
      {
        workspaceRoot: root,
        logRoot: join(root, 'logs'),
        env: {
          HOME: home,
          USERPROFILE: home,
          ZDOTDIR: home,
          HISTFILE: join(home, 'history'),
        },
      },
      () => {},
    );
    t.after(async () => {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const owner = 'shortcut-owner';
    const shell = await manager.create({
      owner,
      sessionId: owner,
      shell:
        process.platform === 'win32'
          ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
          : '/bin/sh',
    });
    const { journeyNodeCommand } = await import(
      new URL('./helpers/native-journey-platform.mjs', import.meta.url).href
    );
    await manager.write(
      owner,
      shell.id,
      journeyNodeCommand(process.execPath, join(root, fixture.paths.program)),
    );
    let ready: { id: string; pid: number; port: number } | undefined;
    await until(
      async () =>
        Boolean(
          (ready = await helper.readTerminalShortcutReady(root, fixture)),
        ),
      'ready child',
    );
    assert.ok(ready);
    const actual = ready;
    assert.notEqual(actual.pid, shell.pid);
    assert.deepEqual(
      await (await fetch(`http://127.0.0.1:${actual.port}`)).json(),
      { id: fixture.id, pid: actual.pid },
    );
    // This is a backend fixture control, not a claim of native Cmd+V coverage.
    await manager.write(owner, shell.id, fixture.payload + '\r');
    await until(
      async () =>
        (await readFile(join(root, fixture.paths.line), 'utf8').catch(
          () => '',
        )) === fixture.payload,
      'one exact application line',
    );
    const raw = await readFile(join(root, fixture.paths.raw));
    helper.assertTerminalShortcutInput(raw, fixture.payload);
    for (const corrupt of [
      Buffer.concat([raw, raw]),
      raw.subarray(1),
      Buffer.from('wrong\n'),
    ])
      assert.throws(() =>
        helper.assertTerminalShortcutInput(corrupt, fixture.payload),
      );
    await manager.write(owner, shell.id, '\x03');
    await until(
      async () => helper.terminalShortcutPidGone(actual.pid),
      'actual Control+C child exit',
    );
    assert.equal(await helper.terminalShortcutPortFree(actual.port), true);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, fixture.paths.interrupted), 'utf8')),
      { id: fixture.id, pid: actual.pid, signal: 'SIGINT' },
    );
    assert.deepEqual(await readFile(join(root, fixture.paths.raw)), raw);
    assert.equal(
      await readFile(join(root, fixture.paths.starts), 'utf8'),
      'once\n',
    );
    const same = (await manager.list(owner)).find(
      (item) => item.id === shell.id,
    )!;
    assert.equal(same.pid, shell.pid);
    assert.equal(same.epoch, shell.epoch);
    assert.equal(same.status, 'running');
    await manager.write(
      owner,
      shell.id,
      journeyNodeCommand(process.execPath, join(root, fixture.paths.prompt)),
    );
    await until(async () => {
      try {
        return (
          JSON.parse(
            await readFile(join(root, fixture.paths.promptDone), 'utf8'),
          ).marker === fixture.promptMarker
        );
      } catch {
        return false;
      }
    }, 'same shell runs the next command');
    await manager.close(owner, shell.id);
    assert.equal(helper.terminalShortcutPidGone(shell.pid), true);
    assert.equal(helper.terminalShortcutPidGone(actual.pid), true);
    assert.equal(await helper.terminalShortcutPortFree(actual.port), true);
    t.diagnostic(
      JSON.stringify({
        shell: { id: shell.id, epoch: shell.epoch, pid: shell.pid },
        childPid: actual.pid,
        actualPort: actual.port,
        rawHex: raw.toString('hex'),
        controlByte: '03',
        sameShellContinued: true,
      }),
    );
  },
);
