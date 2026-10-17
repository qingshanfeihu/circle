import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  link,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DocumentConflictError,
  DocumentPathError,
  TornReadError,
  WorkspaceDocuments,
  type WorkspaceDocument,
  type WorkspaceFilesSnapshot,
} from '../src/workspace/documents.ts';

async function fixture(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), 'circle-workspace-documents-'));
  const root = join(scratch, 'workspace');
  await mkdir(root);
  const documents = new WorkspaceDocuments(root);
  t.after(async () => {
    documents.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return { scratch, root, documents };
}

test('workspace roots use the same native spelling as asynchronous scope checks', async (t) => {
  const { root, documents } = await fixture(t);
  assert.equal(documents.root, await realpath(root));
  assert.equal(documents.root, realpathSync.native(root));
  await writeFile(join(root, 'file.txt'), 'original');
  const document = await documents.read('file.txt');
  const saved = await documents.save('file.txt', 'updated', document.revision);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), saved.content);
});

test(
  'real Windows short-path aliases preserve CAS coordination and native folder boundaries',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { scratch, root, documents } = await fixture(t);
    const execute = promisify(execFile);
    const canonical = await realpath(root);
    // Windows CI TMP already contains RUNNER~1. Preserve that actual short input.
    // Other Windows hosts can ask the OS for an alias when 8.3 is available.
    let short = root;
    if (root.toLowerCase() === canonical.toLowerCase()) {
      const powershell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      try {
        short = (
          await execute(
            powershell,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CIRCLE_DOCUMENT_ALIAS_FOLDER).ShortPath',
            ],
            {
              env: { ...process.env, CIRCLE_DOCUMENT_ALIAS_FOLDER: root },
              encoding: 'utf8',
            },
          )
        ).stdout.trim();
      } catch {
        return t.skip('the host exposes no usable Windows short-path alias');
      }
      if (!short || short.toLowerCase() === canonical.toLowerCase())
        return t.skip('8.3 aliases are disabled for this temporary folder');
    }
    assert.equal(await realpath(short), canonical);
    const aliases = [canonical, root, short].filter(
      (value, index, array) => array.indexOf(value) === index,
    );
    t.diagnostic(
      JSON.stringify({
        shortAliasDiffers: short.toLowerCase() !== canonical.toLowerCase(),
        tmpInputDiffers: root.toLowerCase() !== canonical.toLowerCase(),
        nativeResolversAgree: realpathSync.native(root) === canonical,
      }),
    );
    const services = aliases.map((alias) => new WorkspaceDocuments(alias));
    t.after(() => services.forEach((service) => service.close()));
    assert.ok(services.every((service) => service.root === canonical));
    await writeFile(join(root, 'file.txt'), 'original');
    const original = await documents.read('file.txt');
    const outcomes = await Promise.allSettled([
      documents.save('file.txt', 'first', original.revision),
      services[0]!.save('file.txt', 'second', original.revision),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.ok(
      outcomes.some(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof DocumentConflictError,
      ),
    );
    const saved = await documents.read('file.txt');
    const batch = await services.at(-1)!.applyChanges([
      { path: 'file.txt', content: 'batch', expectedRevision: saved.revision },
      { path: 'nested/new.txt', content: 'new', expectedRevision: null },
    ]);
    assert.equal(batch.status, 'applied');
    assert.equal(await readFile(join(root, 'nested/new.txt'), 'utf8'), 'new');
    await writeFile(join(scratch, 'outside.txt'), 'outside');
    await assert.rejects(
      services[0]!.read('../outside.txt'),
      DocumentPathError,
    );
    assert.equal(
      await readFile(join(scratch, 'outside.txt'), 'utf8'),
      'outside',
    );
  },
);

test('save checks disk revisions, preserves file mode and keeps a stable file id', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'main.ts'), 'export const value = 1;\n', {
    mode: 0o640,
  });
  // Windows exposes writable/read-only mode bits rather than POSIX group bits.
  // Preserve the mode the filesystem actually granted on every platform.
  const originalMode = (await stat(join(root, 'main.ts'))).mode & 0o777;
  const first = await documents.read('main.ts');
  const saved = await documents.save(
    'main.ts',
    'export const value = 2;\n',
    first.revision,
  );
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), saved.content);
  assert.equal(saved.id, first.id);
  assert.notEqual(saved.revision, first.revision);
  assert.equal(saved.size, Buffer.byteLength(saved.content));
  assert.equal((await stat(join(root, 'main.ts'))).mode & 0o777, originalMode);
  assert.deepEqual(await readdir(root), ['main.ts']);
  await assert.rejects(
    documents.save('main.ts', 'stale edit', first.revision),
    (error: unknown) => {
      assert.ok(error instanceof DocumentConflictError);
      assert.equal(error.current?.content, saved.content);
      return true;
    },
  );
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), saved.content);
});

test(
  'saving an existing document preserves its actual mode under a more restrictive process umask',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, documents } = await fixture(t);
    const file = join(root, 'mode.txt');
    await writeFile(file, 'before');
    await chmod(file, 0o640);
    const original = await documents.read('mode.txt');
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    const previous = process.umask(0o077);
    try {
      const saved = await documents.save(
        'mode.txt',
        'after',
        original.revision,
      );
      assert.equal(saved.content, 'after');
      assert.equal(await readFile(file, 'utf8'), 'after');
      assert.equal((await stat(file)).mode & 0o777, 0o640);
      assert.deepEqual(await readdir(root), ['mode.txt']);
    } finally {
      process.umask(previous);
    }
  },
);

test(
  'creating a new document still honors the process umask rather than broadening its initial mode',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, documents } = await fixture(t);
    const previous = process.umask(0o200);
    try {
      await documents.save('new.txt', 'new', null);
      assert.equal((await stat(join(root, 'new.txt'))).mode & 0o777, 0o400);
      assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new');
      assert.deepEqual(await readdir(root), ['new.txt']);
    } finally {
      process.umask(previous);
    }
  },
);

test('external changes and deletes never silently overwrite a developer edit', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'file.txt'), 'original');
  const original = await documents.read('file.txt');
  await writeFile(join(root, 'file.txt'), 'external');
  await assert.rejects(
    documents.save('file.txt', 'mine', original.revision),
    DocumentConflictError,
  );
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'external');
  await unlink(join(root, 'file.txt'));
  await assert.rejects(
    documents.save('file.txt', 'mine', original.revision),
    (error: unknown) => {
      assert.ok(error instanceof DocumentConflictError);
      assert.equal(error.current, null);
      return true;
    },
  );
  const created = await documents.save(
    'file.txt',
    'explicit new document',
    null,
  );
  assert.equal(created.id, original.id);
  await assert.rejects(
    documents.save('file.txt', 'replace without reading', null),
    DocumentConflictError,
  );
});

test('two service instances coordinate concurrent saves to the same root', async (t) => {
  const { root, documents } = await fixture(t);
  const other = new WorkspaceDocuments(root);
  t.after(() => other.close());
  await writeFile(join(root, 'file.txt'), 'original');
  const initial = await documents.read('file.txt');
  const outcomes = await Promise.allSettled([
    documents.save('file.txt', 'first writer', initial.revision),
    other.save('file.txt', 'second writer', initial.revision),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const loser = outcomes.find(
    (result) => result.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.ok(loser.reason instanceof DocumentConflictError);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'first writer');
});

test('a batch validates every revision before changing any file', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'A');
  await writeFile(join(root, 'b.ts'), 'B');
  const a = await documents.read('a.ts');
  const b = await documents.read('b.ts');
  await writeFile(join(root, 'b.ts'), 'external B');
  const result = await documents.applyEdits([
    { path: 'a.ts', content: 'new A', expectedRevision: a.revision },
    { path: 'b.ts', content: 'new B', expectedRevision: b.revision },
  ]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.failures[0]?.kind, 'conflict');
  assert.equal(result.failures[0]?.current?.content, 'external B');
  assert.deepEqual(result.applied, []);
  assert.equal(result.remaining.length, 2);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'A');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'external B');
  assert.deepEqual((await readdir(root)).sort(), ['a.ts', 'b.ts']);
});

test('a batch replaces existing files and creates explicit new files', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'A');
  const a = await documents.read('a.ts');
  const result = await documents.applyEdits([
    { path: 'a.ts', content: 'new A', expectedRevision: a.revision },
    { path: 'b.ts', content: 'new B', expectedRevision: null },
  ]);
  assert.equal(result.status, 'applied');
  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.remaining, []);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'new A');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'new B');
});

test('duplicate batch paths are rejected before writes', async (t) => {
  const { root, documents } = await fixture(t);
  const result = await documents.applyEdits([
    { path: 'a.ts', content: 'A', expectedRevision: null },
    { path: 'a.ts', content: 'B', expectedRevision: null },
  ]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.failures[0]?.kind, 'invalid');
  assert.deepEqual(await readdir(root), []);
});

test('a failure after replacement reports committed paths and preserves remaining inputs', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'A');
  await writeFile(join(root, 'b.ts'), 'B');
  const a = await documents.read('a.ts');
  const b = await documents.read('b.ts');
  // A real disk replacement can succeed just before the next read encounters
  // an I/O failure. Inject only that read failure, then inspect actual files.
  const reader = documents as unknown as {
    readTarget(
      full: string,
      path: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceDocument>;
  };
  const original = reader.readTarget.bind(documents);
  t.mock.method(
    reader,
    'readTarget',
    async (full: string, path: string, signal?: AbortSignal) => {
      if (path === 'a.ts' && (await readFile(full, 'utf8')) === 'new A')
        throw Error('simulated read failure after replacement');
      return original(full, path, signal);
    },
  );
  const result = await documents.applyEdits([
    { path: 'a.ts', content: 'new A', expectedRevision: a.revision },
    { path: 'b.ts', content: 'new B', expectedRevision: b.revision },
  ]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.committedPaths, ['a.ts']);
  assert.deepEqual(
    result.remaining.map((edit) => edit.path),
    ['b.ts'],
  );
  assert.equal(result.failures[0]?.kind, 'io');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'new A');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'B');
  assert.deepEqual((await readdir(root)).sort(), ['a.ts', 'b.ts']);
});

test('cancellation between committed documents reports partial progress without replaying', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'A');
  await writeFile(join(root, 'b.ts'), 'B');
  const a = await documents.read('a.ts');
  const b = await documents.read('b.ts');
  const cancellation = new AbortController();
  const reader = documents as unknown as {
    readTarget(
      full: string,
      path: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceDocument>;
  };
  const original = reader.readTarget.bind(documents);
  t.mock.method(
    reader,
    'readTarget',
    async (full: string, path: string, signal?: AbortSignal) => {
      const value = await original(full, path, signal);
      if (path === 'a.ts' && value.content === 'new A') cancellation.abort();
      return value;
    },
  );
  const result = await documents.applyEdits(
    [
      { path: 'a.ts', content: 'new A', expectedRevision: a.revision },
      { path: 'b.ts', content: 'new B', expectedRevision: b.revision },
    ],
    { signal: cancellation.signal },
  );
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.committedPaths, ['a.ts']);
  assert.equal(result.failures[0]?.kind, 'cancelled');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'new A');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'B');
});

test(
  'cleanup failure retains partial disk facts and names the staged file',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (t) => {
    const { root, documents } = await fixture(t);
    await writeFile(join(root, 'a.ts'), 'A');
    await writeFile(join(root, 'b.ts'), 'B');
    const a = await documents.read('a.ts');
    const b = await documents.read('b.ts');
    const reader = documents as unknown as {
      readTarget(
        full: string,
        path: string,
        signal?: AbortSignal,
      ): Promise<WorkspaceDocument>;
    };
    const original = reader.readTarget.bind(documents);
    t.mock.method(
      reader,
      'readTarget',
      async (full: string, path: string, signal?: AbortSignal) => {
        const value = await original(full, path, signal);
        if (path === 'a.ts' && value.content === 'new A') {
          await chmod(root, 0o500);
          throw Error('read failure after permissions changed');
        }
        return value;
      },
    );
    try {
      const result = await documents.applyEdits([
        { path: 'a.ts', content: 'new A', expectedRevision: a.revision },
        { path: 'b.ts', content: 'new B', expectedRevision: b.revision },
      ]);
      assert.equal(result.status, 'partial');
      assert.deepEqual(result.committedPaths, ['a.ts']);
      assert.deepEqual(
        result.remaining.map((edit) => edit.path),
        ['b.ts'],
      );
      assert.ok(
        result.failures.some((failure) =>
          failure.message.includes('could not remove staged file'),
        ),
      );
      assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'new A');
      assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'B');
      assert.ok(
        (await readdir(root)).some((name) =>
          name.startsWith('.circle-document-'),
        ),
      );
    } finally {
      await chmod(root, 0o700);
    }
  },
);

test('cancelled writes never create or replace files', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'file.txt'), 'original');
  const initial = await documents.read('file.txt');
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    documents.save('file.txt', 'cancelled', initial.revision, {
      signal: cancellation.signal,
    }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    documents.applyEdits(
      [{ path: 'new.txt', content: 'cancelled', expectedRevision: null }],
      { signal: cancellation.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['file.txt']);
});

test('workspace traversal, absolute paths and credential names are denied', async (t) => {
  const { scratch, root, documents } = await fixture(t);
  await writeFile(join(scratch, 'outside.txt'), 'outside');
  await writeFile(join(root, '.env'), 'private');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'private');
  for (const path of [
    '../outside.txt',
    join(scratch, 'outside.txt'),
    'sub/../file',
    '.env',
    '.git/config',
    'nested\\outside.txt',
    'C:/outside.txt',
  ]) {
    await assert.rejects(documents.read(path), DocumentPathError);
    await assert.rejects(
      documents.save(path, 'forbidden', null),
      DocumentPathError,
    );
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    await assert.rejects(documents.read('.ENV'), DocumentPathError);
    await assert.rejects(
      documents.save('CREDENTIALS.JSON', 'forbidden', null),
      DocumentPathError,
    );
    await assert.rejects(documents.read('.GIT/config'), DocumentPathError);
  }
  const custom = new WorkspaceDocuments(root, {
    credentialFiles: ['company.key'],
  });
  t.after(() => custom.close());
  await assert.rejects(
    custom.save('company.key', 'secret', null),
    DocumentPathError,
  );
  await assert.rejects(custom.save('.env', 'secret', null), DocumentPathError);
  assert.equal(await readFile(join(scratch, 'outside.txt'), 'utf8'), 'outside');
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'private');
});

test('symbolic links to files or parent folders do not extend workspace grants', async (t) => {
  const { scratch, root, documents } = await fixture(t);
  const external = join(scratch, 'external');
  await mkdir(external);
  await writeFile(join(external, 'secret.txt'), 'outside');
  await writeFile(join(root, 'safe.txt'), 'inside');
  await symlink(join(external, 'secret.txt'), join(root, 'outside.txt'));
  await symlink(external, join(root, 'alias'));
  await symlink(join(root, 'safe.txt'), join(root, 'inside-alias.txt'));
  for (const path of [
    'outside.txt',
    'alias/secret.txt',
    'inside-alias.txt',
    'alias/new.txt',
  ]) {
    await assert.rejects(documents.read(path), DocumentPathError);
    await assert.rejects(
      documents.save(path, 'forbidden', null),
      DocumentPathError,
    );
  }
  assert.equal(await readFile(join(external, 'secret.txt'), 'utf8'), 'outside');
  assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'inside');
  assert.deepEqual(
    (await documents.refresh()).files.map((file) => file.path),
    ['safe.txt'],
  );
});

test('hard links cannot alias credential contents into an allowed file name', async (t) => {
  const { scratch, root, documents } = await fixture(t);
  await writeFile(join(scratch, 'credentials.json'), 'private');
  await link(join(scratch, 'credentials.json'), join(root, 'ordinary.txt'));
  await assert.rejects(documents.read('ordinary.txt'), DocumentPathError);
  await assert.rejects(
    documents.save('ordinary.txt', 'forbidden', null),
    DocumentPathError,
  );
  assert.deepEqual((await documents.refresh()).files, []);
  assert.equal(
    await readFile(join(scratch, 'credentials.json'), 'utf8'),
    'private',
  );
});

test('a replaced workspace root requires a new grant', async (t) => {
  const { scratch, root, documents } = await fixture(t);
  await writeFile(join(root, 'file.txt'), 'original');
  await rename(root, join(scratch, 'old-workspace'));
  await mkdir(root);
  await writeFile(join(root, 'file.txt'), 'different folder');
  await assert.rejects(documents.read('file.txt'), DocumentPathError);
  await assert.rejects(documents.refresh(), DocumentPathError);
  assert.equal(
    await readFile(join(root, 'file.txt'), 'utf8'),
    'different folder',
  );
});

test('refresh discovers external files without re-opening the granted root', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'old.txt'), 'old');
  const first = await documents.refresh();
  const id = first.files[0]!.id;
  assert.equal((await documents.read('old.txt')).id, id);
  await writeFile(join(root, 'old.txt'), 'changed');
  await writeFile(join(root, 'new.txt'), 'new');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored');
  await writeFile(join(root, 'credentials.json'), '{}');
  const second = await documents.refresh();
  assert.deepEqual(
    second.files.map((file) => file.path),
    ['new.txt', 'old.txt'],
  );
  assert.equal(second.files.find((file) => file.path === 'old.txt')?.id, id);
  assert.deepEqual(
    second.changes.map(({ kind, file }) => [kind, file.path]).sort(),
    [
      ['added', 'new.txt'],
      ['changed', 'old.txt'],
    ],
  );
  await unlink(join(root, 'old.txt'));
  const third = await documents.refresh();
  assert.equal(third.changes[0]?.kind, 'removed');
  assert.equal(third.changes[0]?.file.id, id);
});

test('a slow catalog scan does not hold the document mutation queue', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'slow.txt'), 'catalog');
  await writeFile(join(root, 'fast.txt'), 'original');
  const fast = await documents.read('fast.txt');
  let entered!: () => void;
  let release!: () => void;
  const enteredScan = new Promise<void>((done) => {
    entered = done;
  });
  const blockedScan = new Promise<void>((done) => {
    release = done;
  });
  const paths = documents as unknown as {
    target(
      path: string,
      allowMissing?: boolean,
    ): Promise<{ full: string; path: string }>;
  };
  const original = paths.target.bind(documents);
  t.mock.method(
    paths,
    'target',
    async (path: string, allowMissing?: boolean) => {
      if (path === 'slow.txt') {
        entered();
        await blockedScan;
      }
      return original(path, allowMissing);
    },
  );
  const scan = documents.refresh();
  await enteredScan;
  try {
    const saved = await Promise.race([
      documents.save('fast.txt', 'saved during discovery', fast.revision),
      // The scan stays held until release(); finishing at all shows it does not block.
      delay(5000).then(() => {
        throw Error('discovery blocked manual save');
      }),
    ]);
    assert.equal(saved.content, 'saved during discovery');
    assert.equal(await readFile(join(root, 'fast.txt'), 'utf8'), saved.content);
  } finally {
    release();
    await scan;
  }
});

test('credential policy updates apply to cached services and refresh results', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'company.key'), 'private after policy update');
  const before = await documents.read('company.key');
  assert.equal((await documents.refresh()).files.length, 1);
  documents.setCredentialFiles(['company.key']);
  await assert.rejects(documents.read('company.key'), DocumentPathError);
  await assert.rejects(
    documents.save('company.key', 'forbidden', before.revision),
    DocumentPathError,
  );
  assert.deepEqual((await documents.refresh()).files, []);
  documents.setCredentialFiles([]);
  await assert.rejects(
    documents.save('.env', 'forbidden', null),
    DocumentPathError,
  );
});

test('watch delivers independent subscribers, detects external edits, and closes cleanly', async (t) => {
  const { root, documents } = await fixture(t);
  const first: WorkspaceFilesSnapshot[] = [];
  const second: WorkspaceFilesSnapshot[] = [];
  const stop = new AbortController();
  const a = documents.watch((snapshot) => first.push(snapshot), {
    signal: stop.signal,
    pollIntervalMs: 40,
  });
  const b = documents.watch((snapshot) => second.push(snapshot), {
    pollIntervalMs: 40,
  });
  await Promise.all([a.ready, b.ready]);
  await writeFile(join(root, 'created.txt'), 'external file');
  const deadline = Date.now() + 3000;
  while (
    !first.some((snapshot) =>
      snapshot.files.some((file) => file.path === 'created.txt'),
    ) ||
    !second.some((snapshot) =>
      snapshot.files.some((file) => file.path === 'created.txt'),
    )
  ) {
    assert.ok(Date.now() < deadline, 'both watchers should receive discovery');
    await delay(20);
  }
  stop.abort();
  b.close();
  const counts = [first.length, second.length];
  await writeFile(join(root, 'another.txt'), 'external file');
  await delay(120);
  assert.deepEqual([first.length, second.length], counts);
  assert.equal((await documents.refresh()).files.length, 2);
});

test('binary content, invalid UTF-8 and oversized documents are not corrupted', async (t) => {
  const { root } = await fixture(t);
  const documents = new WorkspaceDocuments(root, { maxBytes: 8 });
  t.after(() => documents.close());
  await writeFile(join(root, 'binary.bin'), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, 'large.txt'), '123456789');
  await assert.rejects(documents.read('binary.bin'));
  await assert.rejects(documents.read('large.txt'), /too large/);
  await assert.rejects(
    documents.save('new.txt', '123456789', null),
    /too large/,
  );
  await assert.rejects(documents.save('new.txt', 'zero\0', null), /binary/);
  assert.deepEqual((await readdir(root)).sort(), ['binary.bin', 'large.txt']);
});

test('a read torn by a concurrent write is read again, and only a file that keeps changing is an error', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'main.ts'), 'whole new file\n');
  const service = documents as unknown as {
    readTargetOnce: (...args: unknown[]) => Promise<WorkspaceDocument>;
  };
  const once = service.readTargetOnce.bind(documents);
  let torn = 2;
  let reads = 0;
  service.readTargetOnce = async (...args) => {
    reads++;
    if (torn-- > 0)
      throw new TornReadError(
        'file changed while reading: main.ts; read it again',
      );
    return once(...args);
  };
  const read = await documents.read('main.ts');
  assert.equal(read.content, 'whole new file\n');
  assert.equal(reads, 3);
  torn = Infinity;
  reads = 0;
  await assert.rejects(
    documents.read('main.ts'),
    /file changed while reading: main\.ts; read it again/,
  );
  assert.equal(reads, 5);
});

test('a write landing just after a save is not reported as the save, so the next save meets a conflict', async (t) => {
  const { root, documents } = await fixture(t);
  await writeFile(join(root, 'main.ts'), 'original\n');
  const first = await documents.read('main.ts');
  const service = documents as unknown as {
    readTarget: (...args: unknown[]) => Promise<WorkspaceDocument>;
  };
  const readTarget = service.readTarget.bind(documents);
  let interfere = true;
  // Another program writes between our rename and the read that reports it:
  // the first read that finds our content on disk.
  service.readTarget = async (...args) => {
    if (
      interfere &&
      (await readFile(join(root, 'main.ts'), 'utf8')) === 'ours\n'
    ) {
      interfere = false;
      await writeFile(join(root, 'main.ts'), 'external\n');
    }
    return readTarget(...args);
  };
  const saved = await documents.save('main.ts', 'ours\n', first.revision);
  assert.equal(saved.content, 'ours\n');
  const disk = await documents.read('main.ts');
  assert.equal(disk.content, 'external\n');
  assert.notEqual(saved.revision, disk.revision);
  await assert.rejects(
    documents.save('main.ts', 'ours again\n', saved.revision),
    DocumentConflictError,
  );
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), 'external\n');
  // A save with nothing in between still reports the file as read back.
  const next = await documents.save('main.ts', 'ours\n', disk.revision);
  assert.equal(next.revision, (await documents.read('main.ts')).revision);
});
