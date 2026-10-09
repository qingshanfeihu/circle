import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  activateRelease,
  activeVersion,
  fileInventory,
  targetFor,
  validateRelease,
  type ReleaseManifest,
} from '../src/install_layout.js';
import { validVersion, compareVersions } from '../src/version.js';
import { scratch } from './helpers.js';
import { fixture } from './release-fixture.js';
import { updateInstalled } from '../src/update.js';
test('semantic versions reject unsafe paths and order prereleases and numeric components without floating-point loss', () => {
  for (const value of ['0.1.0-dev', '1.0.0-rc.1', '2.0.0+build.7'])
    assert.equal(validVersion(value), true);
  for (const value of [
    '../1.0.0',
    '1.0',
    '01.0.0',
    '1.0.0-01',
    '1.0.0\n',
    '1.0.0/evil',
    '1.0.0;echo',
  ])
    assert.equal(validVersion(value), false);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compareVersions('9999999999999999999999.0.0', '2.0.0'), 1);
});
test('installation validates all files before switching and its launcher works with spaces in paths', (t) => {
  const base = scratch(t);
  const root = fixture(base, '0.1.0');
  const prefix = join(base, 'install space');
  const bin = join(base, 'bin space');
  activateRelease(root, prefix, bin);
  assert.equal(activeVersion(prefix), '0.1.0');
  const launcher = join(
    bin,
    process.platform === 'win32' ? 'circle.cmd' : 'circle',
  );
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'cmd.exe' : launcher,
    windows ? ['/d', '/s', '/c', `""${launcher}" --version"`] : ['--version'],
    {
      encoding: 'utf8',
      windowsVerbatimArguments: windows,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.1.0');
  const manifest = validateRelease(join(prefix, 'versions', '0.1.0'));
  assert.equal(manifest.version, '0.1.0');
});
test('upgrades preserve settings, credentials and session bytes; corrupted and incomplete targets never change current', (t) => {
  const base = scratch(t);
  const prefix = join(base, 'install');
  const bin = join(base, 'bin');
  const home = join(base, 'data');
  mkdirSync(home);
  const data = ['settings.json', 'credentials.json', 'circle.sqlite'].map(
    (name) => {
      const path = join(home, name);
      writeFileSync(path, 'unchanged-' + name);
      return { path, bytes: readFileSync(path) };
    },
  );
  activateRelease(fixture(base, '0.1.0'), prefix, bin);
  activateRelease(fixture(base, '0.2.0'), prefix, bin);
  assert.equal(activeVersion(prefix), '0.2.0');
  assert.ok(existsSync(join(prefix, 'versions', '0.1.0')));
  for (const row of data) assert.deepEqual(readFileSync(row.path), row.bytes);
  const broken = fixture(base, '0.3.0');
  writeFileSync(join(broken, 'app/dist/cli.js'), 'corrupt');
  assert.throws(
    () => activateRelease(broken, prefix, bin),
    /verification failed/,
  );
  assert.equal(activeVersion(prefix), '0.2.0');
  const incomplete = fixture(base, '0.4.0');
  const manifest = JSON.parse(
    readFileSync(join(incomplete, 'release.json'), 'utf8'),
  );
  delete manifest.files['app/dist/cli.js'];
  writeFileSync(join(incomplete, 'release.json'), JSON.stringify(manifest));
  assert.throws(() => activateRelease(incomplete, prefix, bin), /file list/);
  assert.equal(activeVersion(prefix), '0.2.0');
});
test('existing version conflicts and invalid pointer values are diagnosed instead of activating another program', (t) => {
  const base = scratch(t);
  const root = fixture(base, '0.1.0');
  const prefix = join(base, 'install');
  const bin = join(base, 'bin');
  activateRelease(root, prefix, bin);
  writeFileSync(join(prefix, 'versions/0.1.0/app/dist/cli.js'), 'modified');
  assert.throws(
    () => activateRelease(root, prefix, bin),
    /verification failed/,
  );
  writeFileSync(join(prefix, 'current.ref'), '../outside\n');
  assert.throws(() => activeVersion(prefix), /invalid installed version/);
});
test('update refuses a source checkout before contacting a release endpoint', async () => {
  const previous = process.env.CIRCLE_INSTALL_PREFIX;
  delete process.env.CIRCLE_INSTALL_PREFIX;
  let called = false;
  try {
    await assert.rejects(
      updateInstalled([], async () => {
        called = true;
        return Response.json({ tag_name: 'v1.0.0' });
      }),
      /installer-managed/,
    );
    assert.equal(called, false);
  } finally {
    if (previous === undefined) delete process.env.CIRCLE_INSTALL_PREFIX;
    else process.env.CIRCLE_INSTALL_PREFIX = previous;
  }
});
