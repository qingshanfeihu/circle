import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_REPO,
  INSTALL_SCHEMA,
  activeVersion,
  assetName,
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

// Where `circle update` says what it is doing: the terminal, or a test.
export interface UpdateOutput {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1);
// Downloads `url` to `path`. On a terminal one line shows how far it has got and redraws
// itself; elsewhere one line says what is downloading. Stops when no data has come for
// `idleMs`, or when `signal` aborts.
export async function downloadFile(
  url: string,
  path: string,
  {
    request = fetch,
    out = process.stdout,
    signal,
    idleMs = 60_000,
  }: {
    request?: typeof fetch;
    out?: UpdateOutput;
    signal?: AbortSignal;
    idleMs?: number;
  } = {},
): Promise<void> {
  const label = basename(path);
  const idle = new AbortController();
  const timer = setTimeout(
    () =>
      idle.abort(
        new Error(`download stalled: no data for ${idleMs / 1000} seconds`),
      ),
    idleMs,
  );
  const stops = signal ? [idle.signal, signal] : [idle.signal];
  // `total` is unknown until the answer comes, and 0 when the answer gives no size.
  let width = 0,
    total: number | undefined,
    done = 0,
    shown = 0,
    started = Date.now();
  const draw = (last: boolean): void => {
    const now = Date.now();
    if (!last && now - shown < 100) return;
    shown = now;
    const seconds = (now - started) / 1000;
    const numbers =
      total === undefined
        ? ''
        : [
            ...(total
              ? [
                  `${Math.floor((done * 100) / total)}%`,
                  `${megabytes(done)}/${megabytes(total)} MB`,
                ]
              : [`${megabytes(done)} MB`]),
            ...(seconds >= 1 ? [`${megabytes(done / seconds)} MB/s`] : []),
          ].join('  ');
    // A line that wraps would leave every redraw on a row of its own: on a narrow terminal
    // the name gives way to the numbers.
    const room = (out.columns || 80) - 1 - (numbers ? numbers.length + 2 : 0);
    const line = [`downloading ${label}`.slice(0, Math.max(0, room)), numbers]
      .filter(Boolean)
      .join('  ');
    out.write('\r' + line.padEnd(width) + (last ? '\n' : ''));
    width = last ? 0 : line.length;
  };
  try {
    // GitHub takes a moment to send the file elsewhere: say what is coming meanwhile.
    if (out.isTTY) draw(false);
    const response = await request(url, { signal: AbortSignal.any(stops) });
    if (!response.ok || !response.body)
      throw new Error(`download failed: HTTP ${response.status} for ${url}`);
    total = Number(response.headers.get('content-length')) || 0;
    started = Date.now();
    shown = 0;
    if (out.isTTY) draw(false);
    else
      out.write(
        `downloading ${label}${total ? ` (${megabytes(total)} MB)` : ''}\n`,
      );
    const file = await open(path, 'w');
    try {
      for await (const chunk of response.body) {
        await file.write(chunk);
        done += chunk.length;
        timer.refresh();
        if (out.isTTY) draw(false);
      }
    } finally {
      await file.close();
    }
    if (out.isTTY) draw(true);
  } catch (error) {
    if (width) out.write('\n');
    throw idle.signal.aborted
      ? idle.signal.reason
      : signal?.aborted
        ? signal.reason
        : error;
  } finally {
    clearTimeout(timer);
  }
}

export async function updateInstalled(
  args: string[],
  request: typeof fetch = fetch,
  {
    root = resolve(import.meta.dirname, '../..'),
    out = process.stdout,
  }: { root?: string; out?: UpdateOutput } = {},
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
  root = realpathSync(root);
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
    out.write(`circle ${installed} is up to date\n`);
    return 0;
  }
  if (check) {
    out.write(`Installed ${installed}; available ${target}\n`);
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
  out.write(`updating circle ${installed} to ${target}\n`);
  // The download is here rather than in the installer so that it shows how far it has got on
  // every system; the installer then checks the file as it checks one it downloaded itself.
  const folder = mkdtempSync(join(tmpdir(), 'circle-update-'));
  const stop = new AbortController();
  const cancel = (): void => stop.abort(new Error('update cancelled'));
  process.once('SIGINT', cancel);
  try {
    const asset = assetName(target);
    const base = `https://github.com/${metadata.repo}/releases/download/v${target}/`;
    await downloadFile(base + asset, join(folder, asset), {
      request,
      out,
      signal: stop.signal,
    });
    await downloadFile(
      base + asset + '.sha256',
      join(folder, asset + '.sha256'),
      {
        request,
        out: { write: () => true },
        signal: stop.signal,
      },
    );
    return await new Promise<number>((resolveResult, reject) => {
      const child = spawn(command, childArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          CIRCLE_VERSION: target,
          CIRCLE_PREFIX: prefix,
          CIRCLE_BIN_DIR: metadata.binDir,
          CIRCLE_REPO: metadata.repo,
          CIRCLE_ASSET_DIR: folder,
        },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolveResult(code ?? 1));
    });
  } finally {
    process.off('SIGINT', cancel);
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}
