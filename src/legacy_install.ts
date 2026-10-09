// Finds and removes copies of the Python implementation (0.5.0 and older) before the installer
// switches to this one. The data folder (CIRCLE_HOME) is never touched: settings, credentials
// and sessions carry over.
//
// Two kinds of copy exist:
//   installer  <prefix>/versions/<version>/circle/circle[.exe] plus a `current` link (0.1.0 made
//              `current` a real folder), with ~/.local/bin/circle linking into it or, on
//              Windows, <prefix>\current\circle on the user PATH
//   pip        a console script `circle` on PATH that runs `from circle.cli import main`
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export interface InstallerCopy {
  kind: 'installer';
  prefix: string;
  versions: string[];
  current?: string;
  links: string[];
  leftovers: string[];
}
export interface PipCopy {
  kind: 'pip';
  python: string;
  script: string;
}
export type PythonCopy = InstallerCopy | PipCopy;
export interface Surroundings {
  platform: NodeJS.Platform;
  home: string;
  localAppData?: string;
  path: string;
  prefix?: string;
  binDir?: string;
}
type Run = (
  command: string,
  args: string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

const runCommand: Run = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });

export function surroundings(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = env.HOME || env.USERPROFILE || '',
): Surroundings {
  return {
    platform,
    home,
    localAppData: env.LOCALAPPDATA,
    path: env.PATH ?? env.Path ?? '',
    prefix: env.CIRCLE_PREFIX || undefined,
    binDir: env.CIRCLE_BIN_DIR || undefined,
  };
}
export function defaultPrefix(where: Surroundings): string {
  return where.platform === 'win32'
    ? join(where.localAppData || join(where.home, 'AppData', 'Local'), 'circle')
    : join(where.home, '.local', 'share', 'circle');
}
export function defaultBinDir(where: Surroundings, prefix: string): string {
  return where.platform === 'win32'
    ? join(prefix, 'bin')
    : join(where.home, '.local', 'bin');
}
const exe = (where: Surroundings): string =>
  where.platform === 'win32' ? 'circle.exe' : 'circle';
const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const inside = (path: string, folder: string): boolean => {
  const rest = relative(resolve(folder), resolve(path));
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
};
const pathDirs = (where: Surroundings): string[] =>
  where.path
    .split(where.platform === 'win32' ? ';' : delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry && isAbsolute(entry));

// A version folder the Python installer made: a version name, the frozen program inside, and
// no release.json (which every release of this implementation has).
function pythonVersions(prefix: string, where: Surroundings): string[] {
  const folder = join(prefix, 'versions');
  if (!isDirectory(folder)) return [];
  return readdirSync(folder)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .map((name) => join(folder, name))
    .filter(
      (path) =>
        isDirectory(path) &&
        isFile(join(path, 'circle', exe(where))) &&
        !existsSync(join(path, 'release.json')),
    );
}
function pythonCurrent(
  prefix: string,
  where: Surroundings,
): string | undefined {
  const current = join(prefix, 'current');
  if (isLink(current)) {
    const target = real(current);
    // A dangling link or one into a Python version folder.
    if (
      !target ||
      pythonVersions(prefix, where).some((path) => real(path) === target)
    )
      return current;
    return undefined;
  }
  return isDirectory(current) &&
    isFile(join(current, 'circle', exe(where))) &&
    !existsSync(join(current, 'release.json'))
    ? current
    : undefined;
}
// The prefix a bin link or PATH entry belongs to, if it looks like a Python installer layout.
function prefixOfProgram(program: string): string | undefined {
  // <prefix>/versions/<v>/circle/circle  or  <prefix>/current/circle/circle
  const folder = dirname(dirname(program));
  if (basename(dirname(program)) !== 'circle') return undefined;
  if (basename(folder) === 'current') return dirname(folder);
  if (basename(dirname(folder)) === 'versions') return dirname(dirname(folder));
  return undefined;
}

export function findPythonCopies(where: Surroundings): PythonCopy[] {
  const prefixes = new Map<string, Set<string>>();
  const note = (prefix: string, link?: string): void => {
    // One key per folder, however it was reached (macOS reaches /var through /private/var).
    const key = real(prefix) ?? resolve(prefix);
    if (!prefixes.has(key)) prefixes.set(key, new Set());
    if (link) prefixes.get(key)!.add(link);
  };
  if (where.prefix) note(where.prefix);
  note(defaultPrefix(where));
  const pips: PipCopy[] = [];
  const seenScripts = new Set<string>();
  const binDirs = [
    ...(where.binDir ? [where.binDir] : []),
    ...(where.platform === 'win32' ? [] : [defaultBinDir(where, '')]),
    ...pathDirs(where),
  ];
  for (const folder of binDirs) {
    if (where.platform === 'win32') {
      // install.ps1 put <prefix>\current\circle on PATH.
      if (
        basename(folder).toLowerCase() === 'circle' &&
        basename(dirname(folder)).toLowerCase() === 'current' &&
        isFile(join(folder, 'circle.exe'))
      ) {
        note(dirname(dirname(folder)));
        continue;
      }
    }
    const program = join(folder, exe(where));
    if (isLink(program)) {
      const target = real(program);
      let text: string | undefined;
      try {
        text = resolve(folder, readlinkSync(program));
      } catch {
        text = undefined;
      }
      const prefix =
        (target && prefixOfProgram(target)) || (text && prefixOfProgram(text));
      if (prefix) {
        note(prefix, program);
        continue;
      }
      // Otherwise a link to a console script, as pipx makes.
      if (!target || !isFile(target)) continue;
    } else if (!isFile(program)) continue;
    const key = real(program) || program;
    if (seenScripts.has(key)) continue;
    seenScripts.add(key);
    const python = pipPython(program, where);
    if (python) pips.push({ kind: 'pip', python, script: program });
  }
  const copies: PythonCopy[] = [];
  for (const [prefix, links] of prefixes) {
    const versions = pythonVersions(prefix, where);
    const current = pythonCurrent(prefix, where);
    if (!versions.length && !current) continue;
    const leftovers = [join(prefix, '.current.new')];
    for (const parent of [prefix, join(prefix, 'versions')])
      if (isDirectory(parent))
        for (const name of readdirSync(parent))
          if (/^\.update-|\.partial$/.test(name))
            leftovers.push(join(parent, name));
    copies.push({
      kind: 'installer',
      prefix,
      versions,
      current,
      links: [...links],
      leftovers: leftovers.filter((path) => existsSync(path) || isLink(path)),
    });
  }
  return [...copies, ...pips];
}

// The interpreter of a pip console script for Circle's Python package, or undefined when the
// file is something else.
export function pipPython(
  script: string,
  where: Surroundings,
): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(script);
  } catch {
    return undefined;
  }
  if (bytes.length > 4 * 1024 * 1024) return undefined;
  const text = bytes.toString('latin1');
  if (!/from circle\.cli import main/.test(text)) return undefined;
  if (where.platform === 'win32') {
    // A pip launcher .exe ends with "#!<python.exe>" and a zip holding __main__.py.
    const shebang = /#!\s*"?([^"\r\n]*?pythonw?\.exe)"?/i.exec(text);
    const candidates = [
      shebang?.[1],
      join(dirname(script), 'python.exe'),
      join(dirname(dirname(script)), 'python.exe'),
    ];
    return candidates.find((path) => path && isAbsolute(path) && isFile(path));
  }
  const [first = '', second = ''] = text.split('\n', 2);
  if (!first.startsWith('#!')) return undefined;
  // pip writes a /bin/sh trampoline when the interpreter path is long or has spaces.
  const trampoline = /^'''exec' "?([^"]+?)"? "\$0" "\$@"/.exec(second);
  if (first.trim() === '#!/bin/sh' && trampoline) return trampoline[1];
  const [command = '', argument] = first.slice(2).trim().split(/\s+/);
  if (!command) return undefined;
  if (basename(command) !== 'env') return command;
  if (!argument) return undefined;
  for (const folder of pathDirs(where)) {
    const candidate = join(folder, argument);
    if (isFile(candidate) || isLink(candidate)) return candidate;
  }
  return undefined;
}

// Processes still running a copy: removing it would break them (Windows refuses outright).
export function runningCopies(
  copies: PythonCopy[],
  where: Surroundings,
  run: Run = runCommand,
): number[] {
  const pids = new Set<number>();
  const folders = copies.flatMap((copy) =>
    copy.kind === 'installer'
      ? [
          ...copy.versions,
          ...(copy.current && !isLink(copy.current) ? [copy.current] : []),
        ]
      : [],
  );
  const scripts = copies.flatMap((copy) =>
    copy.kind === 'pip' ? [copy.script] : [],
  );
  if (where.platform === 'linux') {
    for (const name of safeList('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const program = real(join('/proc', name, 'exe'));
      let commandLine = '';
      try {
        commandLine = readFileSync(join('/proc', name, 'cmdline'), 'utf8');
      } catch {
        commandLine = '';
      }
      const args = commandLine.split('\0');
      if (
        (program && folders.some((folder) => inside(program, folder))) ||
        scripts.some((script) => args.includes(script))
      )
        pids.add(Number(name));
    }
  } else if (where.platform === 'win32') {
    const targets = [...folders, ...scripts];
    if (targets.length) {
      const result = run(
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-Process | Where-Object { $_.Path } | ForEach-Object { "$($_.Id)`t$($_.Path)" }',
        ],
      );
      for (const line of (result.stdout || '').split(/\r?\n/)) {
        const [pid, path] = line.split('\t');
        if (!path) continue;
        const lower = path.toLowerCase();
        if (
          folders.some((folder) =>
            lower.startsWith(resolve(folder).toLowerCase() + '\\'),
          ) ||
          scripts.some((script) => lower === resolve(script).toLowerCase())
        )
          pids.add(Number(pid));
      }
    }
  } else {
    for (const folder of folders) {
      const result = run(systemTool('lsof'), ['-t', '+D', folder]);
      for (const line of (result.stdout || '').split('\n'))
        if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
    }
    if (scripts.length) {
      const result = run(systemTool('ps'), ['-axo', 'pid=,args=']);
      for (const line of (result.stdout || '').split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (
          match &&
          scripts.some((script) =>
            (' ' + match[2] + ' ').includes(' ' + script + ' '),
          )
        )
          pids.add(Number(match[1]));
      }
    }
  }
  pids.delete(process.pid);
  return [...pids].sort((a, b) => a - b);
}
// System tools by their fixed location: the installer may run with a PATH that lacks them.
const systemTool = (name: string): string =>
  ['/usr/sbin', '/usr/bin', '/bin', '/sbin']
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path)) || name;
const safeList = (folder: string): string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

// Where this installation goes when the caller did not say: into the Python copy the user ran,
// so a custom CIRCLE_PREFIX and its bin folder keep working.
export function chooseLocation(
  copies: PythonCopy[],
  where: Surroundings,
): { prefix: string; binDir: string } {
  const installer =
    copies.find(
      (copy): copy is InstallerCopy =>
        copy.kind === 'installer' && copy.links.length > 0,
    ) ||
    copies.find((copy): copy is InstallerCopy => copy.kind === 'installer');
  const prefix = where.prefix || installer?.prefix || defaultPrefix(where);
  const binDir =
    where.binDir ||
    (installer?.links[0] ? dirname(installer.links[0]) : undefined) ||
    defaultBinDir(where, prefix);
  return { prefix: resolve(prefix), binDir: resolve(binDir) };
}

// Removes the copies; returns what was removed. A pip uninstall that fails stops here, before
// anything else changes, so the caller can report it.
export function removePythonCopies(
  copies: PythonCopy[],
  run: Run = runCommand,
): string[] {
  const removed: string[] = [];
  const pythons = new Map<string, PipCopy>();
  for (const copy of copies)
    if (copy.kind === 'pip') pythons.set(copy.python, copy);
  for (const copy of pythons.values()) {
    const result = run(copy.python, ['-m', 'pip', 'uninstall', '-y', 'circle']);
    if (result.status !== 0)
      throw new Error(
        `could not uninstall the Python circle at ${copy.script}: ` +
          `"${copy.python}" -m pip uninstall -y circle failed: ` +
          (
            result.error?.message ||
            result.stderr ||
            result.stdout ||
            ''
          ).trim(),
      );
    removed.push(`pip package circle (${copy.script})`);
  }
  for (const copy of copies)
    if (
      copy.kind === 'pip' &&
      isLink(copy.script) &&
      !existsSync(copy.script)
    ) {
      rmSync(copy.script, { force: true });
      removed.push(copy.script);
    }
  for (const copy of copies) {
    if (copy.kind !== 'installer') continue;
    for (const link of copy.links) {
      rmSync(link, { force: true });
      removed.push(link);
    }
    if (copy.current) {
      // A link (or Windows junction) is removed itself, never what it points at.
      if (isLink(copy.current)) rmSync(copy.current, { force: true });
      else rmSync(copy.current, { recursive: true, force: true });
      removed.push(copy.current);
    }
    for (const path of [...copy.versions, ...copy.leftovers]) {
      if (isLink(path)) rmSync(path, { force: true });
      else rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
    for (const folder of [join(copy.prefix, 'versions'), copy.prefix])
      try {
        rmdirSync(folder);
      } catch {
        // Not empty, or already gone: other files stay.
      }
  }
  return removed;
}
