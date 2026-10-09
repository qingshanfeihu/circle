import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  chmodSync,
  cpSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validVersion } from './version.js';
export interface ReleaseManifest {
  schema: 'circle-next-release/v1';
  version: string;
  target: string;
  nodeVersion: string;
  commit: string;
  files: Record<string, { sha256: string; size: number }>;
}
export function targetFor(
  platform = process.platform,
  arch = process.arch,
): string {
  if (
    !['darwin', 'linux', 'win32'].includes(platform) ||
    !['x64', 'arm64'].includes(arch)
  )
    throw new Error(`unsupported platform: ${platform}/${arch}`);
  return `${platform === 'win32' ? 'windows' : platform}-${arch}`;
}
export function fileInventory(root: string): ReleaseManifest['files'] {
  const files: ReleaseManifest['files'] = {};
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink())
        throw new Error('release contains a symbolic link');
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) {
        const key = relative(root, full).split(sep).join('/');
        if (key !== 'release.json')
          files[key] = {
            sha256: createHash('sha256')
              .update(readFileSync(full))
              .digest('hex'),
            size: stat.size,
          };
      } else throw new Error('release contains a special file');
    }
  };
  visit(root);
  return files;
}
export function validateRelease(
  root: string,
  expectedTarget = targetFor(),
): ReleaseManifest {
  if (lstatSync(root).isSymbolicLink())
    throw new Error('release directory must not be a link');
  const value = JSON.parse(
    readFileSync(join(root, 'release.json'), 'utf8'),
  ) as ReleaseManifest;
  if (
    value.schema !== 'circle-next-release/v1' ||
    !validVersion(value.version) ||
    value.target !== expectedTarget ||
    !/^24\.\d+\.\d+$/.test(value.nodeVersion) ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    !value.files ||
    typeof value.files !== 'object'
  )
    throw new Error('invalid release manifest');
  const actual = fileInventory(root);
  if (Object.keys(actual).length !== Object.keys(value.files).length)
    throw new Error('release file list does not match manifest');
  for (const [name, entry] of Object.entries(actual))
    if (
      value.files[name]?.sha256 !== entry.sha256 ||
      value.files[name]?.size !== entry.size
    )
      throw new Error(`release file verification failed: ${name}`);
  const nodePath = value.target.startsWith('windows-')
    ? 'runtime/node.exe'
    : 'runtime/node';
  for (const required of [
    nodePath,
    'app/dist/cli.js',
    'app/dist/install_manager.js',
    'app/dist/data/models_dev.json.gz',
    'app/dist/data/provider_profiles.json.gz',
    'app/dist/prompts/circle_guidelines.md',
    'app/package.json',
  ])
    if (!actual[required]) throw new Error(`release is missing ${required}`);
  return value;
}
function atomicText(path: string, body: string, mode = 0o600): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, body, { mode, flag: 'wx' });
    renameSync(temporary, path);
    if (process.platform !== 'win32') chmodSync(path, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}
const shellQuote = (text: string): string =>
  "'" + text.replaceAll("'", "'\\''") + "'";
export function activeVersion(prefix: string): string | undefined {
  if (!existsSync(join(prefix, 'current.ref'))) return undefined;
  const value = readFileSync(join(prefix, 'current.ref'), 'utf8').trim();
  if (!validVersion(value))
    throw new Error('invalid installed version pointer');
  return value;
}
export function activateRelease(
  root: string,
  prefix: string,
  binDir: string,
  repo = 'qingshanfeihu/circle-next',
): ReleaseManifest {
  root = realpathSync(root);
  prefix = resolve(prefix);
  binDir = resolve(binDir);
  const manifest = validateRelease(root);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('invalid release repository');
  const nodePath = join(
    root,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const result = spawnSync(
    nodePath,
    [join(root, 'app/dist/cli.js'), '--version'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CIRCLE_NO_MODELS_REFRESH: '1' },
    },
  );
  if (result.status !== 0 || result.stdout.trim() !== manifest.version)
    throw new Error('release version smoke failed');
  const nodeVersion = spawnSync(nodePath, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (
    nodeVersion.status !== 0 ||
    nodeVersion.stdout.trim() !== 'v' + manifest.nodeVersion
  )
    throw new Error('release runtime version does not match manifest');
  const versions = join(prefix, 'versions');
  mkdirSync(versions, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const destination = join(versions, manifest.version);
  if (existsSync(destination)) {
    const existing = validateRelease(destination);
    if (JSON.stringify(existing) !== JSON.stringify(manifest))
      throw new Error('installed version conflicts with this release');
  } else {
    const stage = join(versions, '.staging-' + randomUUID());
    try {
      cpSync(root, stage, { recursive: true, errorOnExist: true });
      validateRelease(stage);
      renameSync(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  const winPrefix = prefix.replaceAll('%', '%%');
  if (process.platform === 'win32') {
    if (/[\r\n"]/.test(prefix)) throw new Error('invalid installation prefix');
    atomicText(
      join(binDir, 'circle.cmd'),
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "CIRCLE_INSTALL_PREFIX=${winPrefix}"\r\nset /p circle_active_version=<"%CIRCLE_INSTALL_PREFIX%\\current.ref"\r\n"%CIRCLE_INSTALL_PREFIX%\\versions\\%circle_active_version%\\runtime\\node.exe" "%CIRCLE_INSTALL_PREFIX%\\versions\\%circle_active_version%\\app\\dist\\cli.js" %*\r\nexit /b %errorlevel%\r\n`,
    );
  } else {
    atomicText(
      join(binDir, 'circle'),
      `#!/bin/sh\nCIRCLE_INSTALL_PREFIX=${shellQuote(prefix)}\nexport CIRCLE_INSTALL_PREFIX\nIFS= read -r circle_active_version < "$CIRCLE_INSTALL_PREFIX/current.ref" || exit 1\ncase "$circle_active_version" in ''|*[!0-9A-Za-z.+-]*) printf 'Invalid installed version\\n' >&2; exit 1;; esac\nexec "$CIRCLE_INSTALL_PREFIX/versions/$circle_active_version/runtime/node" "$CIRCLE_INSTALL_PREFIX/versions/$circle_active_version/app/dist/cli.js" "$@"\n`,
      0o755,
    );
  }
  atomicText(
    join(prefix, 'installation.json'),
    JSON.stringify({ schema: 'circle-next-install/v1', repo, binDir, prefix }) +
      '\n',
  );
  atomicText(join(prefix, 'current.ref'), manifest.version + '\n');
  return manifest;
}
