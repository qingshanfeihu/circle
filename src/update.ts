import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_REPO,
  INSTALL_SCHEMA,
  activeVersion,
  validateRelease,
} from './install_layout.js';
import { VERSION, validVersion, compareVersions } from './version.js';

// ── the daily reminder ── shares update-check.json with the Python releases.
const CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_S = 24 * 60 * 60;
export function updateCheckEnabled(settings: {
  update_check?: unknown;
}): boolean {
  const off = (process.env.CIRCLE_NO_UPDATE_CHECK || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(off)) return false;
  return settings.update_check !== false;
}
// The newest published release, from where github.com/<repo>/releases/latest redirects.
export async function latestRelease(
  repo = process.env.CIRCLE_REPO || DEFAULT_REPO,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request(`https://github.com/${repo}/releases/latest`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(5000),
  });
  const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(response.url)?.[1];
  if (!response.ok || !tag || !validVersion(tag))
    throw new Error(`${repo} has not published a release yet`);
  return tag;
}
// The newest version if it is newer than `current`. Asks the network at most once a day and
// remembers the answer, also when the check failed. Never throws.
export async function availableUpdate(
  home: string,
  current = VERSION,
  latest: () => Promise<string> = () => latestRelease(),
  now = Date.now() / 1000,
): Promise<string | undefined> {
  const path = join(home, CACHE_FILE);
  let cache: { checked_at?: unknown; latest?: unknown } = {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object') cache = value;
  } catch {
    cache = {};
  }
  let known = typeof cache.latest === 'string' ? cache.latest : '';
  const checked = Number(cache.checked_at);
  if (
    !Number.isFinite(checked) ||
    now - checked >= CHECK_INTERVAL_S ||
    checked > now
  ) {
    try {
      known = await latest();
    } catch {
      // Offline or rate limited: try again tomorrow.
    }
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ checked_at: now, latest: known }) + '\n',
      );
    } catch {
      // A read-only data folder only means asking again next start.
    }
  }
  return known && validVersion(known) && compareVersions(known, current) > 0
    ? known
    : undefined;
}
export const updateNotice = (latest: string, current = VERSION): string =>
  `Circle ${latest} is available (you have ${current}) · run \`circle update\``;

export async function updateInstalled(
  args: string[],
  request: typeof fetch = fetch,
): Promise<number> {
  const check = args.includes('--check');
  // `--version X` is how the Python releases took a version.
  const versions = args.flatMap((arg, index) =>
    arg === '--check' || arg === '--version'
      ? []
      : args[index - 1] === '--version' || !arg.startsWith('-')
        ? [arg]
        : ['-'],
  );
  if (versions.length > 1 || versions[0] === '-' || args.at(-1) === '--version')
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
