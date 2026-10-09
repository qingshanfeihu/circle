import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  availableUpdate,
  downloadFile,
  updateInstalled,
  updateNotice,
} from '../src/update.js';
import {
  activateRelease,
  assetName,
  fileInventory,
} from '../src/install_layout.js';
import { VERSION } from '../src/version.js';
import { fixture } from './release-fixture.js';
import { loadRemap } from '../src/keybindings.js';
import { SessionApp } from '../src/tui/session_app.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

function app(t: Parameters<typeof cleanup>[0], home: string): SessionApp {
  const session = new SessionApp(scratch(t), home, defaultSettings());
  const ui = session as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  return session;
}

test('the update check asks once a day, remembers a failed check and shares its file with the Python releases', async (t) => {
  const home = scratch(t);
  let asked = 0;
  const latest = async (): Promise<string> => {
    asked++;
    return '1.2.0';
  };
  assert.equal(await availableUpdate(home, '1.0.0', latest, 1000), '1.2.0');
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')),
    { checked_at: 1000, latest: '1.2.0' },
  );
  assert.equal(await availableUpdate(home, '1.0.0', latest, 2000), '1.2.0');
  assert.equal(asked, 1);
  assert.equal(await availableUpdate(home, '1.2.0', latest, 3000), undefined);
  const failing = async (): Promise<string> => {
    asked++;
    throw new Error('offline');
  };
  // A day later the network fails: the last answer stays and is not asked for again today.
  assert.equal(
    await availableUpdate(home, '1.0.0', failing, 1000 + 86400),
    '1.2.0',
  );
  assert.equal(
    await availableUpdate(home, '1.0.0', failing, 2000 + 86400),
    '1.2.0',
  );
  assert.equal(asked, 2);
  // What 0.5.0 wrote is read as it is.
  writeFileSync(
    join(home, 'update-check.json'),
    JSON.stringify({ checked_at: 5000.25, latest: '0.5.0' }) + '\n',
  );
  assert.equal(await availableUpdate(home, '1.0.0', latest, 5001), undefined);
  assert.equal(asked, 2);
});

test('the terminal shows the update line unless the check is turned off', async (t) => {
  const home = scratch(t);
  const latest = async (): Promise<string> => '9.0.0';
  const previous = process.env.CIRCLE_NO_UPDATE_CHECK;
  cleanup(t, () => {
    if (previous === undefined) delete process.env.CIRCLE_NO_UPDATE_CHECK;
    else process.env.CIRCLE_NO_UPDATE_CHECK = previous;
  });
  delete process.env.CIRCLE_NO_UPDATE_CHECK;
  const shown = app(t, home);
  await shown.checkForUpdate(latest);
  assert.deepEqual(shown.state.notices, [updateNotice('9.0.0')]);
  const off = app(t, scratch(t));
  off.settings.update_check = false;
  await off.checkForUpdate(latest);
  process.env.CIRCLE_NO_UPDATE_CHECK = '1';
  const quiet = app(t, scratch(t));
  await quiet.checkForUpdate(latest);
  assert.deepEqual([...off.state.notices, ...quiet.state.notices], []);
});

test('circle update takes a version the way the Python releases did', async () => {
  const previous = process.env.CIRCLE_INSTALL_PREFIX;
  delete process.env.CIRCLE_INSTALL_PREFIX;
  try {
    for (const args of [['--version', '1.0.1'], ['1.0.1'], ['--check']])
      await assert.rejects(
        updateInstalled(args),
        /requires an installer-managed installation/,
      );
    for (const args of [['--version'], ['1.0.1', '1.0.2'], ['--force']])
      await assert.rejects(updateInstalled(args), /usage: circle update/);
  } finally {
    if (previous !== undefined) process.env.CIRCLE_INSTALL_PREFIX = previous;
  }
});

// A response whose body comes in `parts`, one every `gap` milliseconds; without an end it
// never finishes. Like fetch's, it fails with the reason when `signal` aborts.
function slowly(
  parts: Uint8Array[],
  {
    gap = 0,
    end = true,
    length = true,
    signal,
  }: {
    gap?: number;
    end?: boolean;
    length?: boolean;
    signal?: AbortSignal | null;
  } = {},
): Response {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason));
      for (const part of parts) {
        if (signal?.aborted) return;
        controller.enqueue(part);
        await new Promise((resolveWait) => setTimeout(resolveWait, gap));
      }
      if (end && !signal?.aborted) controller.close();
    },
  });
  return new Response(body, {
    headers: length ? { 'content-length': String(total) } : {},
  });
}
const screen = (columns = 80) => {
  const writes: string[] = [];
  return {
    writes,
    out: { isTTY: true, columns, write: (text: string) => writes.push(text) },
  };
};

test('a download shows how far it has got on one line of the terminal, and one plain line elsewhere', async (t) => {
  const folder = scratch(t);
  const parts = [1, 2, 3, 4].map(() => new Uint8Array(250_000).fill(7));
  const shown = screen();
  await downloadFile(
    'https://example.test/a.tar.gz',
    join(folder, 'a.tar.gz'),
    {
      request: async () => slowly(parts, { gap: 120 }),
      out: shown.out,
    },
  );
  assert.equal(readFileSync(join(folder, 'a.tar.gz')).length, 1_000_000);
  // Every redraw starts at the line's start and only the last one ends it.
  assert.ok(shown.writes.length >= 3);
  assert.ok(shown.writes.every((text) => text.startsWith('\r')));
  assert.deepEqual(
    shown.writes.map((text) => text.endsWith('\n')),
    shown.writes.map((_, index) => index === shown.writes.length - 1),
  );
  // The name shows before the answer, which can take a while; the numbers once it came.
  assert.equal(shown.writes[0], '\rdownloading a.tar.gz');
  assert.match(
    shown.writes[1]!,
    /^\rdownloading a\.tar\.gz {2}0% {2}0\.0\/1\.0 MB/,
  );
  assert.match(
    shown.writes.at(-1)!,
    /downloading a\.tar\.gz {2}100% {2}1\.0\/1\.0 MB/,
  );
  assert.ok(
    shown.writes.some((text) => /\b(25|50|75)%/.test(text)),
    shown.writes.join('|'),
  );
  // Without a size it counts what came; on a narrow terminal the line is cut so that it
  // never wraps, which would leave every redraw on a line of its own.
  const narrow = screen(30);
  const long = 'circle-1.0.4-darwin-arm64.tar.gz';
  await downloadFile('https://example.test/' + long, join(folder, long), {
    request: async () => slowly(parts, { length: false }),
    out: narrow.out,
  });
  assert.ok(narrow.writes.every((text) => text.trim().length <= 29));
  assert.equal(
    narrow.writes.at(-1),
    '\r' + `downloading ${long}`.slice(0, 21) + '  1.0 MB\n',
  );
  const plain: string[] = [];
  await downloadFile('https://example.test/c.zip', join(folder, 'c.zip'), {
    request: async () => slowly(parts),
    out: { write: (text: string) => plain.push(text) },
  });
  assert.deepEqual(plain, ['downloading c.zip (1.0 MB)\n']);
});

test('a download that stalls, fails or is cancelled says why and ends the progress line', async (t) => {
  const folder = scratch(t);
  const shown = screen();
  await assert.rejects(
    downloadFile('https://example.test/a', join(folder, 'a'), {
      request: async (_url, init) =>
        slowly([new Uint8Array(10)], { end: false, signal: init?.signal }),
      out: shown.out,
      idleMs: 200,
    }),
    /download stalled: no data for 0\.2 seconds/,
  );
  assert.equal(shown.writes.at(-1), '\n');
  await assert.rejects(
    downloadFile('https://example.test/missing', join(folder, 'b'), {
      request: async () => new Response('Not Found', { status: 404 }),
      out: { write: () => true },
    }),
    /download failed: HTTP 404 for https:\/\/example\.test\/missing/,
  );
  const stop = new AbortController();
  const cancelled = downloadFile('https://example.test/c', join(folder, 'c'), {
    request: async (_url, init) =>
      slowly([new Uint8Array(10)], { end: false, signal: init?.signal }),
    out: { write: () => true },
    signal: stop.signal,
  });
  setTimeout(() => stop.abort(new Error('update cancelled')), 50);
  await assert.rejects(cancelled, /update cancelled/);
});

// An installation of this version whose installer only keeps what it was given.
function installed(t: Parameters<typeof scratch>[0]) {
  const base = scratch(t);
  const root = fixture(base, VERSION);
  writeFileSync(
    join(root, 'app/install.sh'),
    'mkdir -p "$CIRCLE_TEST_SEEN"\ncp "$CIRCLE_ASSET_DIR"/* "$CIRCLE_TEST_SEEN"/\n' +
      'printf %s "$CIRCLE_ASSET_DIR" > "$CIRCLE_TEST_SEEN/folder"\n' +
      'printf %s "$CIRCLE_VERSION" > "$CIRCLE_TEST_SEEN/version"\n',
  );
  writeFileSync(
    join(root, 'app/install.ps1'),
    "$ErrorActionPreference = 'Stop'\n" +
      'New-Item -ItemType Directory -Force -Path $env:CIRCLE_TEST_SEEN | Out-Null\n' +
      "Copy-Item -Path (Join-Path $env:CIRCLE_ASSET_DIR '*') -Destination $env:CIRCLE_TEST_SEEN\n" +
      "Set-Content -NoNewline -LiteralPath (Join-Path $env:CIRCLE_TEST_SEEN 'folder') -Value $env:CIRCLE_ASSET_DIR\n" +
      "Set-Content -NoNewline -LiteralPath (Join-Path $env:CIRCLE_TEST_SEEN 'version') -Value $env:CIRCLE_VERSION\n",
  );
  const manifest = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  manifest.files = fileInventory(root);
  writeFileSync(join(root, 'release.json'), JSON.stringify(manifest));
  const prefix = join(base, 'install');
  activateRelease(root, prefix, join(base, 'bin'), 'example/circle');
  const seen = join(base, 'seen');
  const saved = {
    prefix: process.env.CIRCLE_INSTALL_PREFIX,
    seen: process.env.CIRCLE_TEST_SEEN,
  };
  process.env.CIRCLE_INSTALL_PREFIX = prefix;
  process.env.CIRCLE_TEST_SEEN = seen;
  cleanup(t, () => {
    for (const [name, value] of [
      ['CIRCLE_INSTALL_PREFIX', saved.prefix],
      ['CIRCLE_TEST_SEEN', saved.seen],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  return { root: join(prefix, 'versions', VERSION), seen };
}
const updateFolders = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('circle-update-'));

test('circle update downloads the release itself, showing how far it got, and hands it to the installer', async (t) => {
  const { root, seen } = installed(t);
  const asset = assetName('99.0.0');
  const archive = new Uint8Array(300_000).fill(3);
  const asked: string[] = [];
  const shown = screen();
  const before = updateFolders();
  const code = await updateInstalled(
    ['99.0.0'],
    async (url) => {
      asked.push(String(url));
      return String(url).endsWith('.sha256')
        ? new Response(`${'a'.repeat(64)}  ${asset}\n`)
        : slowly([archive.subarray(0, 100_000), archive.subarray(100_000)], {
            gap: 120,
          });
    },
    { root, out: shown.out },
  );
  assert.equal(code, 0);
  const base = 'https://github.com/example/circle/releases/download/v99.0.0/';
  assert.deepEqual(asked, [base + asset, base + asset + '.sha256']);
  assert.equal(shown.writes[0], `updating circle ${VERSION} to 99.0.0\n`);
  assert.match(
    shown.writes.at(-1)!,
    new RegExp(`downloading ${asset.replaceAll('.', '\\.')} {2}100%`),
  );
  // The installer got both files and the version, and the folder is gone afterwards.
  assert.deepEqual(readFileSync(join(seen, asset)), Buffer.from(archive));
  assert.match(
    readFileSync(join(seen, asset + '.sha256'), 'utf8'),
    /^a{64} {2}/,
  );
  assert.equal(readFileSync(join(seen, 'version'), 'utf8'), '99.0.0');
  assert.equal(existsSync(readFileSync(join(seen, 'folder'), 'utf8')), false);
  assert.deepEqual(updateFolders(), before);
});

test('ctrl+c during the download of circle update stops it and leaves nothing behind', async (t) => {
  const { root, seen } = installed(t);
  const before = updateFolders();
  const listeners = process.listeners('SIGINT');
  const update = updateInstalled(
    ['99.0.0'],
    async (_url, init) => {
      // The update's own handler is the one added since; it stands for ctrl+c.
      const added = process
        .listeners('SIGINT')
        .filter((listener) => !listeners.includes(listener));
      assert.equal(added.length, 1);
      setTimeout(() => added[0]!('SIGINT'), 50);
      return slowly([new Uint8Array(10)], { end: false, signal: init?.signal });
    },
    { root, out: { write: () => true } },
  );
  await assert.rejects(update, /update cancelled/);
  assert.deepEqual(process.listeners('SIGINT'), listeners);
  assert.deepEqual(updateFolders(), before);
  assert.equal(existsSync(seen), false);
});

test('keybindings.json from the Python releases keeps working and its problems are shown', (t) => {
  const home = scratch(t);
  writeFileSync(
    join(home, 'keybindings.json'),
    JSON.stringify({
      'job.background': 'ctrl+k',
      'command.background': 'alt+b',
      'no.such': 'ctrl+y',
    }),
  );
  const { remap, problems } = loadRemap(home);
  assert.equal(remap['ctrl+k'], 'ctrl+b');
  assert.equal(remap['alt+b'], 'ctrl+b');
  assert.deepEqual(problems, ["unknown action 'no.such' in keybindings.json"]);
  const session = app(t, home);
  session.applyRunSettings();
  assert.deepEqual(session.state.notices, [
    "✖ unknown action 'no.such' in keybindings.json",
  ]);
});
