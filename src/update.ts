import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  INSTALL_SCHEMA,
  activeVersion,
  validateRelease,
} from './install_layout.js';
import { VERSION, validVersion, compareVersions } from './version.js';
export async function updateInstalled(
  args: string[],
  request: typeof fetch = fetch,
): Promise<number> {
  const check = args.includes('--check');
  const versions = args.filter((arg) => arg !== '--check');
  if (versions.length > 1 || versions[0]?.startsWith('-'))
    throw new Error('usage: circle update [version] [--check]');
  const prefix = process.env.CIRCLE_INSTALL_PREFIX;
  if (!prefix)
    throw new Error('circle update requires an installer-managed installation');
  const installed = activeVersion(prefix);
  const root = realpathSync(resolve(import.meta.dirname, '../..'));
  if (
    !installed ||
    installed !== VERSION ||
    realpathSync(join(prefix, 'versions', installed)) !== root
  )
    throw new Error('this program is not the active installed version');
  validateRelease(root);
  const metadata = JSON.parse(
    readFileSync(join(prefix, 'installation.json'), 'utf8'),
  ) as { schema: string; repo: string; binDir: string; prefix: string };
  if (
    metadata.schema !== INSTALL_SCHEMA ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.repo) ||
    resolve(metadata.prefix) !== resolve(prefix) ||
    typeof metadata.binDir !== 'string'
  )
    throw new Error('invalid installation receipt');
  let target = versions[0]?.replace(/^v/, '');
  if (!target) {
    const response = await request(
      `https://api.github.com/repos/${metadata.repo}/releases/latest`,
      {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    if (!response.ok)
      throw new Error(`release lookup failed: HTTP ${response.status}`);
    const data = (await response.json()) as { tag_name?: string };
    target = data.tag_name?.replace(/^v/, '');
  }
  if (!target || !validVersion(target))
    throw new Error('release has an invalid semantic version');
  if (compareVersions(target, installed) <= 0 && !versions[0]) {
    process.stdout.write(`circle ${installed} is up to date\n`);
    return 0;
  }
  if (check) {
    process.stdout.write(`Installed ${installed}; available ${target}\n`);
    return 0;
  }
  const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const script = join(
    root,
    'app',
    process.platform === 'win32' ? 'install.ps1' : 'install.sh',
  );
  const childArgs =
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
      : [script];
  return await new Promise<number>((resolveResult, reject) => {
    const child = spawn(command, childArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        CIRCLE_VERSION: target,
        CIRCLE_PREFIX: prefix,
        CIRCLE_BIN_DIR: metadata.binDir,
        CIRCLE_REPO: metadata.repo,
      },
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult(code ?? 1));
  });
}
