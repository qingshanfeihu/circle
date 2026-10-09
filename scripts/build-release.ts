import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VERSION } from '../src/version.js';
import {
  ARCHIVE_ROOT,
  RELEASE_SCHEMA,
  assetName,
  fileInventory,
  targetFor,
  validateRelease,
  type ReleaseManifest,
} from '../src/install_layout.js';
const runtimes = JSON.parse(
  readFileSync('scripts/node-runtime.json', 'utf8'),
) as {
  version: string;
  archives: Record<string, { name: string; sha256: string }>;
};
const target = targetFor();
const runtime = runtimes.archives[target];
if (!runtime) throw new Error('runtime is not pinned for this target');
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string;
};
if (manifest.version !== VERSION)
  throw new Error('package and CLI versions do not match');
const output = resolve(process.argv[2] || '.tmp/release');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'circle-release-'));
function run(command: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16_000_000,
    shell: process.platform === 'win32' && command === 'npm.cmd',
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
  const archive = join(temporary, runtime.name);
  const response = await fetch(
    `https://nodejs.org/dist/v${runtimes.version}/${runtime.name}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok)
    throw new Error(`runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== runtime.sha256)
    throw new Error('runtime checksum does not match pinned digest');
  writeFileSync(archive, bytes);
  const extracted = join(temporary, 'runtime');
  mkdirSync(extracted);
  const expandScript = join(temporary, 'expand.ps1');
  const compressScript = join(temporary, 'compress.ps1');
  writeFileSync(
    expandScript,
    'param([string]$Source,[string]$Destination)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory($Source,$Destination)\n',
  );
  writeFileSync(
    compressScript,
    'param([string]$Source,[string]$Destination)\n$ErrorActionPreference="Stop"\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination\n',
  );
  if (process.platform === 'win32')
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      expandScript,
      archive,
      extracted,
    ]);
  else run('tar', ['-xzf', archive, '-C', extracted]);
  const runtimeRoot = join(
    extracted,
    runtime.name.replace(/\.(?:zip|tar\.gz)$/, ''),
  );
  const packageRoot = join(temporary, ARCHIVE_ROOT);
  const app = join(packageRoot, 'app');
  const binary = join(packageRoot, 'runtime');
  mkdirSync(app, { recursive: true });
  mkdirSync(binary);
  cpSync(
    join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node'),
    join(binary, process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  cpSync(join(runtimeRoot, 'LICENSE'), join(binary, 'LICENSE'));
  if (process.platform !== 'win32') chmodSync(join(binary, 'node'), 0o755);
  cpSync('dist', join(app, 'dist'), { recursive: true });
  cpSync('docs', join(app, 'docs'), { recursive: true });
  for (const name of [
    'package.json',
    'package-lock.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'install.sh',
    'install.ps1',
  ])
    cpSync(name, join(app, name));
  // Install only the locked runtime packages in an isolated staging directory.
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    app,
  );
  rmSync(join(app, 'node_modules', '.bin'), { recursive: true, force: true });
  const release: ReleaseManifest = {
    schema: RELEASE_SCHEMA,
    version: VERSION,
    target,
    nodeVersion: runtimes.version,
    commit: run('git', ['rev-parse', 'HEAD']).trim(),
    files: fileInventory(packageRoot),
  };
  writeFileSync(
    join(packageRoot, 'release.json'),
    JSON.stringify(release, null, 2) + '\n',
  );
  validateRelease(packageRoot);
  const name = assetName(VERSION, target);
  const packaged = join(output, name);
  rmSync(packaged, { force: true });
  if (process.platform === 'win32')
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      compressScript,
      packageRoot,
      packaged,
    ]);
  else run('tar', ['-czf', packaged, '-C', temporary, ARCHIVE_ROOT]);
  const sha256 = createHash('sha256')
    .update(readFileSync(packaged))
    .digest('hex');
  writeFileSync(packaged + '.sha256', `${sha256}  ${name}\n`);
  process.stdout.write(
    JSON.stringify({
      archive: packaged,
      sha256,
      target,
      version: VERSION,
      runtime: runtimes.version,
    }) + '\n',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
