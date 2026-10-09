import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { activeVersion, pruneVersions } from '../src/install_layout.js';
import {
  chooseLocation,
  findPythonCopies,
  removePythonCopies,
  runningCopies,
  type InstallerCopy,
  type PipCopy,
  type Surroundings,
} from '../src/legacy_install.js';
import { cleanup, scratch } from './helpers.js';
import { fixture } from './release-fixture.js';

const windows = process.platform === 'win32';
const program = windows ? 'circle.exe' : 'circle';

// What the Python installer left: versions/<v>/circle/circle, `current` linking to the newest
// (a junction on Windows), and ~/.local/bin/circle -> <prefix>/current/circle/circle (on
// Windows, <prefix>\current\circle on PATH instead).
function pythonInstall(
  base: string,
  versions = ['0.4.0', '0.5.0'],
): { prefix: string; bin: string; pathEntry: string } {
  const prefix = join(base, 'python prefix');
  for (const version of versions) {
    const folder = join(prefix, 'versions', version, 'circle');
    mkdirSync(join(folder, '_internal'), { recursive: true });
    writeFileSync(join(folder, program), 'frozen python ' + version);
  }
  symlinkSync(
    join(prefix, 'versions', versions.at(-1)!),
    join(prefix, 'current'),
    windows ? 'junction' : 'dir',
  );
  const bin = join(base, 'home', '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  if (!windows)
    symlinkSync(
      join(prefix, 'current', 'circle', 'circle'),
      join(bin, 'circle'),
    );
  return { prefix, bin, pathEntry: join(prefix, 'current', 'circle') };
}
function around(base: string, path: string[]): Surroundings {
  return {
    platform: process.platform,
    home: join(base, 'home'),
    localAppData: join(base, 'appdata'),
    path: path.join(windows ? ';' : ':'),
  };
}
function dataHome(base: string): { path: string; bytes: Buffer }[] {
  const home = join(base, 'data');
  mkdirSync(home);
  return [
    'settings.json',
    'credentials.json',
    'sessions.sqlite',
    'checkpoints.sqlite',
  ].map((name) => {
    const path = join(home, name);
    writeFileSync(path, 'unchanged ' + name);
    return { path, bytes: readFileSync(path) };
  });
}
function runManager(
  base: string,
  root: string,
  path: string[],
  extra: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'CIRCLE_PREFIX',
    'CIRCLE_BIN_DIR',
    'CIRCLE_REPO',
    'CIRCLE_INSTALL_RESULT',
  ])
    delete env[name];
  // Only fake locations: the real PATH and home may hold a real Python circle.
  Object.assign(env, {
    HOME: join(base, 'home'),
    USERPROFILE: join(base, 'home'),
    LOCALAPPDATA: join(base, 'appdata'),
    PATH: path.join(windows ? ';' : ':'),
    Path: path.join(windows ? ';' : ':'),
    ...extra,
  });
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/install_manager.ts', root],
    { encoding: 'utf8', env, timeout: 60_000 },
  );
}

test('the installer removes a Python installation found through its bin link and installs in its place', (t) => {
  const base = scratch(t);
  const { prefix, bin, pathEntry } = pythonInstall(base);
  // A release of this implementation in the same prefix is not Python's and stays.
  const kept = fixture(base, '0.9.0');
  cpSync(kept, join(prefix, 'versions', '0.9.0'), { recursive: true });
  const data = dataHome(base);
  const path = windows ? [pathEntry] : [bin];
  const where = around(base, path);
  const copies = findPythonCopies(where);
  assert.equal(copies.length, 1);
  const copy = copies[0] as InstallerCopy;
  assert.equal(copy.kind, 'installer');
  assert.equal(copy.prefix, realpathSync(prefix));
  assert.deepEqual(
    copy.versions.map((folder) => folder.split(/[\\/]/).at(-1)),
    ['0.4.0', '0.5.0'],
  );
  assert.ok(copy.current);
  assert.deepEqual(copy.links, windows ? [] : [join(bin, 'circle')]);
  const location = chooseLocation(copies, where);
  assert.equal(location.prefix, realpathSync(prefix));
  assert.equal(
    location.binDir,
    windows ? join(realpathSync(prefix), 'bin') : bin,
  );

  const result = join(base, 'result.json');
  const run = runManager(base, fixture(base, '1.0.0'), path, {
    CIRCLE_INSTALL_RESULT: result,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /removing the Python circle installed in/);
  for (const version of ['0.4.0', '0.5.0'])
    assert.equal(existsSync(join(prefix, 'versions', version)), false);
  assert.equal(existsSync(join(prefix, 'current')), false);
  assert.ok(existsSync(join(prefix, 'versions', '0.9.0', 'release.json')));
  assert.equal(activeVersion(prefix), '1.0.0');
  const receipt = JSON.parse(readFileSync(result, 'utf8'));
  assert.deepEqual(receipt.removedPrefixes, [realpathSync(prefix)]);
  const launcher = join(location.binDir, windows ? 'circle.cmd' : 'circle');
  const started = spawnSync(
    windows ? 'cmd.exe' : launcher,
    windows ? ['/d', '/s', '/c', `""${launcher}" --version"`] : ['--version'],
    { encoding: 'utf8', windowsVerbatimArguments: windows },
  );
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout.trim(), '1.0.0');
  for (const row of data) assert.deepEqual(readFileSync(row.path), row.bytes);
  // Running it again finds nothing left to remove.
  assert.deepEqual(findPythonCopies(around(base, path)), []);
});

test(
  'the 0.1.0 layout, where current is a real folder, is removed with its link',
  {
    skip: windows,
  },
  (t) => {
    const base = scratch(t);
    const prefix = join(base, 'old');
    mkdirSync(join(prefix, 'current', 'circle', '_internal'), {
      recursive: true,
    });
    writeFileSync(join(prefix, 'current', 'circle', 'circle'), 'frozen 0.1.0');
    const bin = join(base, 'bin');
    mkdirSync(bin);
    symlinkSync(
      join(prefix, 'current', 'circle', 'circle'),
      join(bin, 'circle'),
    );
    const copies = findPythonCopies(around(base, [bin]));
    assert.equal(copies.length, 1);
    removePythonCopies(copies);
    assert.equal(existsSync(join(prefix, 'current')), false);
    assert.equal(existsSync(join(bin, 'circle')), false);
    assert.equal(existsSync(prefix), false);
  },
);

test('other programs named circle, links elsewhere and releases of this implementation are left alone', (t) => {
  const base = scratch(t);
  const other = join(base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, program), '#!/bin/sh\necho another circle\n');
  const tool = join(base, 'tool');
  mkdirSync(join(tool, 'bin'), { recursive: true });
  writeFileSync(join(tool, 'bin', 'circle-tool'), 'not ours');
  const links = join(base, 'links');
  mkdirSync(links);
  if (!windows)
    symlinkSync(join(tool, 'bin', 'circle-tool'), join(links, 'circle'));
  // A prefix holding only releases of this implementation.
  const prefix = join(base, 'home', '.local', 'share', 'circle');
  mkdirSync(join(prefix, 'versions'), { recursive: true });
  cpSync(fixture(base, '1.0.0'), join(prefix, 'versions', '1.0.0'), {
    recursive: true,
  });
  writeFileSync(join(prefix, 'current.ref'), '1.0.0\n');
  assert.deepEqual(findPythonCopies(around(base, [other, links])), []);
});

test(
  'pip console scripts are uninstalled with their own interpreter, once per environment',
  {
    skip: windows,
  },
  (t) => {
    const base = scratch(t);
    const script = (folder: string, first: string, second = ''): string => {
      mkdirSync(folder, { recursive: true });
      const path = join(folder, 'circle');
      writeFileSync(
        path,
        `${first}\n${second}${second ? '\n' : ''}import sys\nfrom circle.cli import main\nif __name__ == "__main__":\n    sys.exit(main())\n`,
      );
      chmodSync(path, 0o755);
      return path;
    };
    const venv = join(base, 'venv', 'bin');
    const direct = script(venv, `#!${join(venv, 'python')}`);
    const spaced = join(base, 'a long venv path', 'bin');
    const trampoline = script(
      spaced,
      '#!/bin/sh',
      `'''exec' "${join(spaced, 'python')}" "$0" "$@"`,
    );
    const tools = join(base, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'python3'), '');
    const viaEnv = script(join(base, 'user', 'bin'), '#!/usr/bin/env python3');
    // pipx links its script into the bin folder.
    const pipx = join(base, 'pipx', 'venvs', 'circle', 'bin');
    const pipxScript = script(pipx, `#!${join(pipx, 'python')}`);
    const pipxBin = join(base, 'pipx-bin');
    mkdirSync(pipxBin);
    symlinkSync(pipxScript, join(pipxBin, 'circle'));
    const where = around(base, [
      venv,
      venv,
      spaced,
      join(base, 'user', 'bin'),
      tools,
      pipxBin,
    ]);
    const copies = findPythonCopies(where) as PipCopy[];
    assert.deepEqual(
      copies.map((copy) => [copy.python, copy.script]),
      [
        [join(venv, 'python'), direct],
        [join(spaced, 'python'), trampoline],
        [join(tools, 'python3'), viaEnv],
        [join(pipx, 'python'), join(pipxBin, 'circle')],
      ],
    );
    const calls: string[][] = [];
    const removed = removePythonCopies(copies, (command, args) => {
      calls.push([command, ...args]);
      // Uninstalling removes the script the pipx link points at.
      if (command === join(pipx, 'python')) rmSync(pipxScript);
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    assert.deepEqual(
      calls.map((call) => call.slice(1)),
      Array(4).fill(['-m', 'pip', 'uninstall', '-y', 'circle']),
    );
    assert.ok(removed.includes(join(pipxBin, 'circle')));
    assert.equal(existsSync(join(pipxBin, 'circle')), false);
  },
);

test(
  'a failed pip uninstall stops before the installer copy is touched',
  {
    skip: windows,
  },
  (t) => {
    const base = scratch(t);
    const { prefix, bin } = pythonInstall(base);
    const venv = join(base, 'venv', 'bin');
    mkdirSync(venv, { recursive: true });
    writeFileSync(
      join(venv, 'circle'),
      `#!${join(venv, 'python')}\nfrom circle.cli import main\n`,
    );
    const copies = findPythonCopies(around(base, [bin, venv]));
    assert.deepEqual(
      copies.map((copy) => copy.kind),
      ['installer', 'pip'],
    );
    assert.throws(
      () =>
        removePythonCopies(copies, () => ({
          status: 1,
          stdout: '',
          stderr: 'externally-managed-environment',
          error: undefined,
        })),
      /pip uninstall -y circle failed: externally-managed-environment/,
    );
    assert.ok(existsSync(join(prefix, 'versions', '0.5.0')));
    assert.ok(existsSync(join(bin, 'circle')));
  },
);

test('a running Python circle blocks the installation and nothing changes', async (t) => {
  const base = scratch(t);
  const { prefix, bin, pathEntry } = pythonInstall(base);
  const frozen = join(prefix, 'versions', '0.5.0', 'circle', program);
  rmSync(frozen);
  cpSync(process.execPath, frozen);
  if (!windows) chmodSync(frozen, 0o755);
  const child = spawn(frozen, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
  });
  cleanup(t, () => {
    child.kill();
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  const path = windows ? [pathEntry] : [bin];
  const where = around(base, path);
  assert.deepEqual(runningCopies(findPythonCopies(where), where), [child.pid]);
  const run = runManager(base, fixture(base, '1.0.0'), path);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    new RegExp(`still running \\(process ${child.pid}\\)`),
  );
  assert.ok(existsSync(frozen));
  assert.ok(existsSync(join(prefix, 'current')));
  assert.equal(existsSync(join(prefix, 'versions', '1.0.0')), false);
  assert.equal(activeVersion(prefix), undefined);
});

test('an explicit prefix and bin folder win over the Python location, which wins over the default', (t) => {
  const base = scratch(t);
  const { prefix, bin } = pythonInstall(base);
  const where = around(base, windows ? [] : [bin]);
  const copies = findPythonCopies(where);
  if (!windows) assert.equal(chooseLocation(copies, where).binDir, bin);
  assert.equal(chooseLocation(copies, where).prefix, realpathSync(prefix));
  assert.deepEqual(
    chooseLocation(copies, {
      ...where,
      prefix: join(base, 'mine'),
      binDir: join(base, 'my bin'),
    }),
    { prefix: join(base, 'mine'), binDir: join(base, 'my bin') },
  );
  assert.deepEqual(chooseLocation([], around(base, [])), {
    prefix: windows
      ? join(base, 'appdata', 'circle')
      : join(base, 'home', '.local', 'share', 'circle'),
    binDir: windows
      ? join(base, 'appdata', 'circle', 'bin')
      : join(base, 'home', '.local', 'bin'),
  });
});

test(
  'a launcher folder missing from PATH gets one marked line in the shell startup file',
  {
    skip: windows,
  },
  (t) => {
    const base = scratch(t);
    const root = fixture(base, '1.0.0');
    for (const run of [1, 2]) {
      const result = runManager(base, root, [], { SHELL: '/bin/bash' });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(/added .* to PATH/.test(result.stdout), run === 1);
    }
    const rc = readFileSync(join(base, 'home', '.bashrc'), 'utf8');
    assert.equal(rc.match(/# circle path/g)?.length, 1);
    assert.match(
      rc,
      new RegExp(
        `export PATH="${join(base, 'home', '.local', 'bin')}:\\$PATH"`,
      ),
    );
    const quiet = runManager(base, root, [], {
      SHELL: '/bin/zsh',
      CIRCLE_NO_PATH: '1',
    });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(existsSync(join(base, 'home', '.zshrc')), false);
  },
);

test('installing keeps the newest three versions and the one it replaces', (t) => {
  const base = scratch(t);
  const prefix = join(base, 'prefix');
  for (const version of ['0.9.0', '1.0.0', '1.0.1', '1.0.2', '1.1.0']) {
    mkdirSync(join(prefix, 'versions', version), { recursive: true });
    writeFileSync(join(prefix, 'versions', version, 'release.json'), '{}');
  }
  // A folder that is not one of ours stays.
  mkdirSync(join(prefix, 'versions', 'notes'));
  assert.deepEqual(pruneVersions(prefix, ['1.1.0', '0.9.0']).sort(), ['1.0.0']);
  assert.deepEqual(readdirSync(join(prefix, 'versions')).sort(), [
    '0.9.0',
    '1.0.1',
    '1.0.2',
    '1.1.0',
    'notes',
  ]);
});
