import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  realpath,
  mkdir,
  symlink,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorkspaceService } from '../src/workspace/git.ts';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type { WorkspaceDocument } from '../src/workspace/documents.ts';
import type {
  TerminalSnapshot,
  TerminalReplay,
} from '../src/workspace/terminal.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
import { patience } from './helpers/patience.mjs';
const interactiveShell =
  process.platform === 'win32' ? { args: ['/d', '/q'] } : { shell: '/bin/sh' };

test('workspace routing preserves revisions, isolates terminal owners and persists before delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-services-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-services-data-'));
  const events: WorkspaceServiceEvent[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: path.join(root, 'missing-adapter'),
    ghPath: path.join(root, 'missing-gh'),
    credentialFiles: ['private.custom'],
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: (event) => events.push(event),
  });
  try {
    await writeFile(path.join(root, 'private.custom'), 'not for tools');
    await assert.rejects(
      service.call('session-a', 'documents', 'read', {
        path: 'private.custom',
      }),
      /file is not available in this workspace/,
    );
    await writeFile(path.join(root, 'later.secret'), 'not for tools');
    service.setCredentialFiles(['private.custom', 'later.secret']);
    await assert.rejects(
      service.call('session-a', 'documents', 'read', { path: 'later.secret' }),
      /file is not available in this workspace/,
    );
    await assert.rejects(
      service.call('session-a', 'documents', 'read', { path: 123 }),
      /string/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', { cols: '80' }),
      /integer/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', {
        command: { file: 123 },
      }),
      /string/,
    );
    await assert.rejects(
      service.call('session-a', 'terminal', 'create', {
        command: { file: 'node' },
        readiness: { port: '80' },
      }),
      /integer/,
    );
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    assert.deepEqual(
      await service.call('session-a', 'documents', 'resolveSource', {
        path: path.join(root, 'a.ts'),
      }),
      { path: 'a.ts' },
    );
    assert.deepEqual(
      await service.call('session-a', 'documents', 'resolveSource', {
        path: 'a.ts',
      }),
      { path: 'a.ts' },
    );
    await writeFile(path.join(data, 'outside.ts'), 'outside');
    await assert.rejects(
      service.call('session-a', 'documents', 'resolveSource', {
        path: path.join(data, 'outside.ts'),
      }),
      /outside/,
    );
    await symlink(path.join(data, 'outside.ts'), path.join(root, 'escape.ts'));
    await assert.rejects(
      service.call('session-a', 'documents', 'resolveSource', {
        path: 'escape.ts',
      }),
      /outside/,
    );
    if (process.platform === 'darwin') {
      const canonical = await realpath(path.join(root, 'a.ts'));
      const alias = canonical.startsWith('/private/var/')
        ? canonical.replace('/private/var/', '/var/')
        : canonical;
      assert.deepEqual(
        await service.call('session-a', 'documents', 'resolveSource', {
          path: alias,
        }),
        { path: 'a.ts' },
      );
    }
    const doc = (await service.call('session-a', 'documents', 'read', {
      path: 'a.ts',
    })) as WorkspaceDocument;
    await service.call('session-a', 'documents', 'save', {
      path: 'a.ts',
      content: 'export const a = 2;\n',
      expectedRevision: doc.revision,
    });
    assert.equal(
      await readFile(path.join(root, 'a.ts'), 'utf8'),
      'export const a = 2;\n',
    );
    assert.ok(
      events.some((e) => e.service === 'documents' && e.data.kind === 'save'),
    );
    const folder = (await readdir(path.join(data, 'workspaces')))[0];
    const journal = await readFile(
      path.join(data, 'workspaces', folder, 'events.jsonl'),
      'utf8',
    );
    assert.ok(journal.includes('"kind":"save"'));
    const firstPage = await service.replay();
    assert.equal(firstPage.events[0].workspaceId.length, 24);
    const event = {
      workspaceId: firstPage.events[0].workspaceId,
      sessionId: 'session-a',
      service: 'tasks' as const,
      resourceId: 'task-1',
      epoch: 'task-runtime',
      seq: 99,
      at: new Date().toISOString(),
      data: { kind: 'progress' },
    };
    await assert.rejects(
      service.publishSource({ ...event, workspaceId: 'foreign-workspace' }),
      /does not belong/,
    );
    await service.publishSource(event);
    const nextPage = await service.replay(firstPage.cursor);
    assert.ok(
      nextPage.events.some(
        (item) => item.sourceSeq === 99 && item.data.kind === 'progress',
      ),
    );

    await assert.rejects(
      service.call('session-a', 'documents', 'save', {
        path: 'a.ts',
        content: 'lost',
        expectedRevision: doc.revision,
      }),
      /changed/i,
    );
    const terminal = (await service.call('session-a', 'terminal', 'create', {
      ...interactiveShell,
      owner: 'session-b',
      sessionId: 'session-b',
    })) as TerminalSnapshot;
    assert.equal(terminal.owner, 'session-a');
    await assert.rejects(
      service.call('session-b', 'terminal', 'write', {
        id: terminal.id,
        data: 'echo forbidden\r',
      }),
      /owner|not found|belong|unknown/i,
    );
    await service.call('session-a', 'terminal', 'write', {
      id: terminal.id,
      data: 'echo CIRCLE_NATIVE_ROUTING_OK\r',
    });
    let replay: TerminalReplay | undefined;
    for (let i = 0; i < 100; i++) {
      replay = (await service.call('session-a', 'terminal', 'replay', {
        id: terminal.id,
      })) as TerminalReplay;
      if (
        replay.events.some((e) => e.data?.includes('CIRCLE_NATIVE_ROUTING_OK'))
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      replay?.events.some((e) => e.data?.includes('CIRCLE_NATIVE_ROUTING_OK')),
    );
    await service.call('session-a', 'terminal', 'close', { id: terminal.id });
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('releasing one session waits for its PTY exit and preserves another session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-session-release-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-session-release-data-'),
  );
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
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
  });
  try {
    const a = (await service.call('session-a', 'terminal', 'create', {
      ...interactiveShell,
    })) as TerminalSnapshot;
    const b = (await service.call('session-b', 'terminal', 'create', {
      ...interactiveShell,
    })) as TerminalSnapshot;
    assert.equal(await service.hasActiveSession('session-a'), true);
    assert.equal(await service.hasActiveSessionResources('session-b'), true);
    await service.releaseSession('session-a');
    assert.equal(await service.hasActiveSession('session-a'), false);
    assert.throws(() => process.kill(a.pid!, 0));
    assert.doesNotThrow(() => process.kill(b.pid!, 0));
    assert.equal(await service.hasActiveSession('session-b'), true);
    await service.call('session-b', 'terminal', 'write', {
      id: b.id,
      data: 'echo B_STILL_OWNED\r',
    });
    await service.releaseSession('session-b');
    assert.throws(() => process.kill(b.pid!, 0));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('blocked durable writer bounds 100000 incoming events and exposes one failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-stream-bound-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-stream-bound-data-'));
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const failures: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    workspaceId: 'bounded',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    maxPendingEventBytes: 32768,
    eventStreamOptions: { beforeWrite: () => gate },
    emit: () => {},
    onPersistenceError: (error) => failures.push(error),
  });
  try {
    const terminal = (await service.call('session-a', 'terminal', 'create', {
      ...interactiveShell,
    })) as TerminalSnapshot;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100000; i++)
      promises.push(
        service
          .publishSource({
            workspaceId: 'bounded',
            sessionId: 'session-a',
            service: 'tasks',
            resourceId: 'task-a',
            epoch: 'test',
            seq: i + 1,
            at: new Date().toISOString(),
            data: { text: 'x'.repeat(256) },
          })
          .catch(() => undefined),
      );
    assert.ok(service.eventHealth.pendingBytes <= 32768);
    assert.equal(failures.length, 1);
    assert.match(service.eventHealth.error!, /byte limit/);
    unblock();
    await Promise.all(promises);
    assert.equal(service.eventHealth.pendingBytes, 0);
    await service.releaseSession('session-a');
    assert.throws(() => process.kill(terminal.pid!, 0));
  } finally {
    unblock();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test('initial event journal open failure still allows complete service disposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-journal-open-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-journal-open-data-'));
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex');
  const blockedJournal = path.join(data, 'workspaces', hash, 'events.jsonl');
  await mkdir(blockedJournal, { recursive: true });
  assert.equal((await stat(blockedJournal)).isDirectory(), true);
  const errors: Error[] = [];
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
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
    onPersistenceError: (error) => errors.push(error),
  });
  try {
    const rejection = await service
      .call('session-a', 'documents', 'refresh')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const actualFolders = await readdir(path.join(data, 'workspaces'));
    assert.ok(
      rejection,
      JSON.stringify({
        message: 'directory journal must reject opening',
        root,
        expectedHash: hash,
        actualFolders,
        blockedJournal,
        stillDirectory: (await stat(blockedJournal)).isDirectory(),
        eventHealth: service.eventHealth,
      }),
    );
    assert.match(String(rejection), /EISDIR|directory/i);
    assert.equal(errors.length, 1);
    await assert.doesNotReject(service.dispose());
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('document saves invalidate semantic projects without discarding another unsaved overlay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-language-save-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-language-save-data-'));
  await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'b.ts'), 'export const untouched = true;\n');
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    emit: () => {},
  });
  try {
    await service.call('s', 'language', 'open', {
      path: 'b.ts',
      content: 'export const untouched: string = 123;\n',
    });
    const before = (await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'b.ts',
    })) as unknown[];
    assert.ok(before.length > 0);
    const doc = (await service.call('s', 'documents', 'read', {
      path: 'a.ts',
    })) as WorkspaceDocument;
    await service.call('s', 'documents', 'save', {
      path: 'a.ts',
      content: 'export const value = 2;\n',
      expectedRevision: doc.revision,
    });
    const after = (await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'b.ts',
    })) as unknown[];
    assert.ok(after.length > 0);
    assert.equal(
      await readFile(path.join(root, 'b.ts'), 'utf8'),
      'export const untouched = true;\n',
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('concurrent disposal shares completion and late sources are not reported as disk failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-service-close-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-service-close-data-'));
  const failures: Error[] = [];
  const service = new WorkspaceServices({
    workspaceRoot: root,
    workspaceId: 'owned-close',
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
    onPersistenceError: (error) => failures.push(error),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = service.terminals.dispose.bind(service.terminals);
  service.terminals.dispose = async () => {
    await gate;
    await original();
  };
  try {
    const terminal = (await service.call('s', 'terminal', 'create', {
      ...interactiveShell,
    })) as TerminalSnapshot;
    await service.replay();
    let done = false;
    const first = service.dispose().then(() => {
      done = true;
    });
    let secondDone = false;
    const second = service.dispose().then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    assert.equal(secondDone, false);
    release();
    await Promise.all([first, second]);
    assert.equal(done, true);
    assert.equal(secondDone, true);
    assert.throws(() => process.kill(terminal.pid!, 0));
    const journal = await readFile(
      path.join(
        data,
        'workspaces',
        createHash('sha256').update(path.resolve(root)).digest('hex'),
        'events.jsonl',
      ),
      'utf8',
    );
    assert.ok(
      journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .some(
          (event) =>
            event.service === 'terminal' &&
            event.resourceId === terminal.id &&
            event.data.kind === 'exit',
        ),
    );
    await assert.rejects(
      service.publishSource({
        workspaceId: 'owned-close',
        sessionId: 's',
        service: 'tasks',
        resourceId: 'late',
        epoch: 'late',
        seq: 1,
        at: new Date().toISOString(),
        data: { kind: 'late' },
      }),
      { code: 'WORKSPACE_SERVICES_CLOSED' },
    );
    assert.equal(failures.length, 0);
    assert.equal(service.eventHealth.error, undefined);
    const reopened = new WorkspaceServices({
      workspaceRoot: root,
      workspaceId: 'owned-close',
      dataDir: data,
      nodeExecutable: process.execPath,
      runtimeExecutable: process.execPath,
      adapterPath: 'unused',
      ghPath: 'unused',
      emit: () => {},
    });
    await reopened.replay();
    await reopened.dispose();
  } finally {
    release();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test('Git canonicalizes granted repository aliases without granting its parent to a child workspace', async () => {
  const container = await mkdtemp(
    path.join(tmpdir(), 'circle-git-root-grant-'),
  );
  const root = path.join(container, 'repo');
  const alias = path.join(container, 'repo-alias');
  const child = path.join(root, 'child');
  await mkdir(child, { recursive: true });
  const git = new GitWorkspaceService(root);
  await git.git(['init']);
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base = {
    dataDir: path.join(container, 'data'),
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    emit: () => {},
  };
  const granted = new WorkspaceServices({ ...base, workspaceRoot: root });
  const aliased = new WorkspaceServices({ ...base, workspaceRoot: alias });
  const nested = new WorkspaceServices({ ...base, workspaceRoot: child });
  try {
    const ordinary = (await granted.call('s', 'git', 'status')) as {
      root: string;
    };
    assert.equal(await realpath(ordinary.root), await realpath(root));
    const viaAlias = (await aliased.call('s', 'git', 'status')) as {
      root: string;
    };
    assert.equal(await realpath(viaAlias.root), await realpath(root));
    await assert.rejects(
      nested.call('s', 'git', 'status'),
      /open the repository root to grant Git workspace access/,
    );
  } finally {
    await Promise.all([granted.dispose(), aliased.dispose(), nested.dispose()]);
    await rm(container, { recursive: true, force: true });
  }
});

test('diagnostic bodies remain replayable after clearing and restart, with byte-bounded Unicode chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-diagnostic-history-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-diagnostic-history-data-'),
  );
  await writeFile(path.join(root, 'a.ts'), 'const value: string = 1;');
  await writeFile(path.join(root, 'main.py'), 'disk');
  const oldLog = process.env.LSP_TEST_LOG;
  const protocolLog = path.join(data, 'language-protocol.json');
  process.env.LSP_TEST_LOG = protocolLog;
  const options = {
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    emit: () => {},
    languageServers: {
      '.py': {
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../../tests/fixtures/lsp-server.ts', import.meta.url),
          ),
          '--diagnostic-history',
        ],
      },
    },
  };
  let service = new WorkspaceServices(options);
  const allEvents = async () => {
    const events = [];
    let page = await service.replay(undefined, 3);
    while (true) {
      events.push(...page.events);
      if (!page.hasMore) return events;
      page = await service.replay(page.cursor, 3);
    }
  };
  try {
    await service.call('s', 'language', 'open', {
      path: 'a.ts',
      content: 'const value: string = 1;',
    });
    const ts = await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'a.ts',
    });
    assert.ok((ts as unknown[]).length);
    await service.call('s', 'language', 'change', {
      path: 'a.ts',
      content: 'const value: string = "ok";',
    });
    assert.deepEqual(
      await service.call('s', 'language', 'diagnostics', { path: 'a.ts' }),
      [],
    );
    await service.call('s', 'language', 'open', {
      path: 'main.py',
      content: 'PRIVATE_UNSAVED_SOURCE',
      version: 12,
    });
    const lsp = await service.call('s', 'language', 'request', {
      method: 'diagnostics',
      path: 'main.py',
    });
    await service.call('s', 'language', 'change', {
      path: 'main.py',
      content: 'clean',
      version: 13,
    });
    assert.deepEqual(
      await service.call('s', 'language', 'request', {
        method: 'diagnostics',
        path: 'main.py',
      }),
      [],
    );
    await service.call('s', 'language', 'change', {
      path: 'main.py',
      content: 'hold',
      version: 14,
    });
    // Attach the rejection expectation before any awaited publication: the
    // held server can correctly reject before change's journal write finishes.
    const late = assert.rejects(
      service.call('s', 'language', 'request', {
        method: 'diagnostics',
        path: 'main.py',
      }),
      /stale language response/,
    );
    const deadline = Date.now() + 1000;
    while (true) {
      const requests = JSON.parse(await readFile(protocolLog, 'utf8')) as any[];
      if (
        requests.filter((row) => row.method === 'textDocument/diagnostic')
          .length === 3
      )
        break;
      assert.ok(Date.now() < deadline, 'real server receives held diagnostic');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await service.call('s', 'language', 'change', {
      path: 'main.py',
      content: 'clean',
      version: 15,
    });
    await late;
    await service.dispose();
    service = new WorkspaceServices(options);
    const events = (await allEvents()).filter(
      (event) =>
        event.service === 'language' && event.data.kind === 'diagnostics',
    );
    const batches = new Map<string, typeof events>();
    for (const event of events) {
      assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
      const id = event.data.batchId as string;
      batches.set(id, [...(batches.get(id) ?? []), event]);
    }
    assert.equal(batches.size, 4);
    const restored = [...batches.values()].map((rows) => {
      rows.sort((a, b) => Number(a.data.index) - Number(b.data.index));
      assert.equal(rows.length, rows[0].data.count);
      return {
        metadata: rows[0].data,
        value: JSON.parse(rows.map((row) => row.data.body).join('')),
      };
    });
    assert.deepEqual(restored[0].value, ts);
    assert.equal(restored[0].metadata.provider, 'typescript');
    assert.equal(restored[0].metadata.documentVersion, 1);
    assert.deepEqual(restored[1].value, []);
    assert.deepEqual(restored[2].value, lsp);
    assert.equal(restored[2].metadata.provider, 'lsp');
    assert.equal(restored[2].metadata.documentVersion, 12);
    assert.deepEqual(restored[3].value, []);
    assert.ok(
      events.length > 20,
      'large multibyte original is chunked, never truncated',
    );
    assert.ok(!JSON.stringify(events).includes('PRIVATE_UNSAVED_SOURCE'));
    assert.equal(await readFile(path.join(root, 'main.py'), 'utf8'), 'disk');
  } finally {
    if (oldLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = oldLog;
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test(
  'DAP raw output larger than one MiB survives journal paging and close without cumulative events',
  { timeout: patience(15000) },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-output-'));
    const data = await mkdtemp(
      path.join(tmpdir(), 'circle-debug-output-data-'),
    );
    const adapter = path.join(root, 'adapter.cjs');
    const events: WorkspaceServiceEvent[] = [];
    await writeFile(path.join(root, 'fixture.cjs'), '');
    await writeFile(
      adapter,
      `const net=require('net');net.createServer(s=>{let buffer=Buffer.alloc(0),seq=0,launch;const frame=m=>{const b=JSON.stringify({seq:++seq,...m});return 'Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b};const reply=m=>frame({type:'response',request_seq:m.seq,command:m.command,success:true,body:{}});s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const len=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+len)return;const m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);if(m.command==='initialize')s.write(reply(m)+frame({type:'event',event:'initialized',body:{}}));else if(m.command==='launch')launch=m;else if(m.command==='configurationDone'){s.write(reply(m));s.write(reply(launch));s.write(frame({type:"event",event:"output",body:{category:"stdout",output:"中文😀\\n".repeat(150000)}}));}else s.write(reply(m));}})}).listen(0,'127.0.0.1',function(){console.log('Debug server listening at 127.0.0.1:'+this.address().port)});`,
    );
    const service = new WorkspaceServices({
      workspaceRoot: root,
      dataDir: data,
      nodeExecutable: process.execPath,
      runtimeExecutable: process.execPath,
      adapterPath: adapter,
      ghPath: 'missing',
      emit: (event) => events.push(event),
    });
    const expected = '中文😀\n'.repeat(150000);
    try {
      await service.call('A', 'debug', 'launch', { program: 'fixture.cjs' });
      const deadline = Date.now() + patience(5000);
      while (
        !events.some(
          (event) =>
            event.service === 'debug' && (event.data as any).kind === 'output',
        ) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      // Wait for this complete incoming DAP message's durability chain.
      let page: any = await service.call('A', 'debug', 'output', {});
      const chunks: string[] = [];
      const throughSeq = page.throughSeq;
      for (;;) {
        chunks.push(...page.events.map((event: any) => event.data.text));
        if (!page.hasMore) break;
        page = await service.call('A', 'debug', 'output', {
          after: page.cursor,
          throughSeq,
        });
      }
      assert.equal(chunks.join(''), expected);
      const snapshot: any = await service.call('A', 'debug', 'snapshot', {});
      assert.ok(Buffer.byteLength(snapshot.output) <= 64 * 1024);
      assert.ok(!snapshot.output.includes('�'));
      assert.ok(
        events.every(
          (event) => Buffer.byteLength(JSON.stringify(event)) < 128 * 1024,
        ),
      );
      const foreign: any = await service.call('B', 'debug', 'output', {});
      assert.equal(foreign.events.length, 0);
      assert.equal(service.eventHealth.error, undefined);
      await service.dispose();
      const journalFiles = await readdir(path.join(data, 'workspaces'));
      const raw = await readFile(
        path.join(data, 'workspaces', journalFiles[0], 'events.jsonl'),
        'utf8',
      );
      const stored = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter(
          (event) => event.sessionId === 'A' && event.data.kind === 'output',
        )
        .map((event) => event.data.text)
        .join('');
      assert.equal(stored, expected);
      const reopened = new WorkspaceServices({
        workspaceRoot: root,
        dataDir: data,
        nodeExecutable: process.execPath,
        runtimeExecutable: process.execPath,
        adapterPath: adapter,
        ghPath: 'missing',
        emit: () => {},
      });
      try {
        let after = { offset: 0, seq: 0 };
        const recovered: string[] = [];
        for (;;) {
          const page: any = await reopened.call('A', 'debug', 'output', {
            after,
          });
          recovered.push(...page.events.map((event: any) => event.data.text));
          if (!page.hasMore) break;
          after = page.cursor;
        }
        assert.equal(recovered.join(''), expected);
        assert.equal(
          ((await reopened.call('A', 'debug', 'snapshot', {})) as any)
            .adapterPid,
          undefined,
          'history reading never launches an adapter',
        );
      } finally {
        await reopened.dispose();
      }
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  },
);
