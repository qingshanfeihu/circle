import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assetPath,
  assetType,
  boundedText,
  safeExternalUrl,
  trustedAppUrl,
  validSaveName,
} from '../src/policy.ts';
import { nativeFile, WorkspaceGrants } from '../src/files.ts';

test('only the application frame URL is trusted', () => {
  assert.equal(trustedAppUrl('circle://workbench/index.html#/session/a'), true);
  for (const value of [
    'https://example.test',
    'file:///tmp/index.html',
    'circle://other/index.html',
    'circle://workbench/assets/evil.html',
  ])
    assert.equal(trustedAppUrl(value), false);
});
test('local protocol assets cannot escape the bundled renderer', () => {
  const renderer = resolve('app', 'renderer');
  assert.equal(
    assetPath(renderer, 'circle://workbench/assets/app.js'),
    join(renderer, 'assets', 'app.js'),
  );
  for (const url of [
    'circle://other/index.html',
    'circle://workbench/%2e%2e%2fsecret',
    'circle://workbench/%5csecret',
    'circle://workbench/%00secret',
  ])
    assert.throws(() => assetPath(renderer, url));
});
test('exports require a filename and bounded content', () => {
  assert.equal(validSaveName('session.md'), 'session.md');
  for (const value of ['../secret', 'a/b', 'a\\b', '..', 'a\0b', ''])
    assert.throws(() => validSaveName(value));
  assert.equal(boundedText('ok', 2), 'ok');
  assert.throws(() => boundedText('exceeds', 3));
  assert.throws(() => boundedText({ text: 'x' }, 100));
});
test('external links only admit ordinary HTTP URLs', () => {
  assert.equal(
    safeExternalUrl('https://example.test/docs'),
    'https://example.test/docs',
  );
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/x',
    'data:text/html,evil',
    'https://user:secret@example.test',
  ])
    assert.equal(safeExternalUrl(url), undefined);
});
test('workspace grants reject unknown, cross-workspace and forged handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-grants-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, 'note.md'), '# granted content');
    await writeFile(join(b, 'outside.md'), 'outside');
    const grants = new WorkspaceGrants();
    const first = await grants.open(a),
      second = await grants.open(b);
    assert.equal(first.files.length, 1);
    const file = await grants.read(first.id, first.files[0]!.id);
    assert.equal(file.content, '# granted content');
    await assert.rejects(
      () => grants.read(second.id, first.files[0]!.id),
      /not granted/,
    );
    await assert.rejects(
      () => grants.read('unknown', first.files[0]!.id),
      /not granted/,
    );
    await assert.rejects(
      () => grants.read(first.id, '../../outside.md'),
      /not granted/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace grants reject a granted path replaced by a filesystem link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-grant-link-'));
  try {
    const selected = join(root, 'selected');
    const outside = join(root, 'outside');
    await mkdir(selected);
    await mkdir(outside);
    const note = join(selected, 'note.md');
    const outsideNote = join(outside, 'note.md');
    await writeFile(note, 'selected');
    await writeFile(outsideNote, 'outside');
    const grants = new WorkspaceGrants();
    const workspace = await grants.open(selected);
    await rm(note);
    // Junctions do not need Windows symlink privileges. Both are genuine
    // filesystem links and must be refused before the replacement is read.
    await symlink(
      process.platform === 'win32' ? outside : outsideNote,
      note,
      process.platform === 'win32' ? 'junction' : 'file',
    );
    await assert.rejects(
      () => grants.read(workspace.id, workspace.files[0]!.id),
      /symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace grants exclude directory links and reject replaced parent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-grant-escape-'));
  try {
    const selected = join(root, 'selected');
    const nested = join(selected, 'nested');
    const outside = join(root, 'outside');
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await writeFile(join(nested, 'note.md'), 'selected');
    await writeFile(join(outside, 'note.md'), 'outside');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(outside, join(selected, 'outside-link'), linkType);
    const grants = new WorkspaceGrants();
    const workspace = await grants.open(selected);
    assert.deepEqual(
      workspace.files.map((file) => file.path),
      ['nested/note.md'],
    );
    const granted = workspace.files[0]!;
    assert.equal(
      (await grants.read(workspace.id, granted.id)).content,
      'selected',
    );
    await rm(nested, { recursive: true });
    await symlink(outside, nested, linkType);
    await assert.rejects(
      () => grants.read(workspace.id, granted.id),
      /outside the selected workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('workspace grants still open when a subdirectory cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-grant-unreadable-'));
  const hidden = join(root, 'selected', 'hidden');
  try {
    const selected = join(root, 'selected');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(selected, 'note.md'), 'yes');
    await writeFile(join(hidden, 'secret.txt'), 'nope');
    await chmod(hidden, 0);
    const workspace = await new WorkspaceGrants().open(selected);
    const paths = workspace.files.map((file) => file.path);
    assert.ok(paths.includes('note.md'));
    if (typeof process.getuid === 'function' && process.getuid() !== 0)
      assert.equal(paths.includes('hidden/secret.txt'), false);
  } finally {
    await chmod(hidden, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
test('native text preview discloses truncation and supports full import text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-file-'));
  try {
    const path = join(root, 'large.md');
    await writeFile(path, 'x'.repeat(300_000));
    const preview = await nativeFile(path);
    assert.equal(preview.truncated, true);
    assert.equal(preview.content.length, 256_000);
    const imported = await nativeFile(path, 4_000_000);
    assert.equal(imported.truncated, false);
    assert.equal(imported.content.length, 300_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chosen pictures and PDFs go whole up to 20 MB, other files up to 4 MB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-native-files-'));
  try {
    const picture = join(root, 'screen.png');
    await writeFile(picture, Buffer.alloc(6_000_000, 1));
    const chosen = await nativeFile(picture);
    assert.equal(chosen.kind, 'image');
    assert.equal(chosen.size, 6_000_000);
    const pdf = join(root, 'paper.pdf');
    await writeFile(pdf, '%PDF-1.7 a small paper');
    const document = await nativeFile(pdf);
    assert.equal(document.kind, 'document');
    assert.equal(
      document.content,
      'data:application/pdf;base64,' +
        Buffer.from('%PDF-1.7 a small paper').toString('base64'),
    );
    const large = join(root, 'large.png');
    await writeFile(large, Buffer.alloc(21 * 1024 * 1024, 1));
    await assert.rejects(nativeFile(large), /large\.png is over 20 MB/);
    const notes = join(root, 'notes.txt');
    await writeFile(notes, Buffer.alloc(4_100_000, 97));
    await assert.rejects(nativeFile(notes), /notes\.txt is over 4 MB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the window serves its own files under the types a module, worker and stylesheet need', () => {
  assert.equal(
    assetType('/r/assets/index-abc.js'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(
    assetType('/r/assets/editor.worker-abc.js'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(assetType('/r/index.html'), 'text/html; charset=utf-8');
  assert.equal(assetType('/r/assets/index-abc.css'), 'text/css; charset=utf-8');
  assert.equal(assetType('/r/assets/codicon-abc.ttf'), 'font/ttf');
  assert.equal(
    assetType('/r/assets/index-abc.js.map'),
    'application/json; charset=utf-8',
  );
  assert.equal(
    assetType('/r/ASSETS/LOUD.JS'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(assetType('/r/assets/unknown.bin'), 'application/octet-stream');
});
