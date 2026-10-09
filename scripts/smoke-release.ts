import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  ARCHIVE_ROOT,
  assetName,
  fileInventory,
  targetFor,
  validateRelease,
  activeVersion,
  type ReleaseManifest,
} from '../src/install_layout.js';
import { VERSION } from '../src/version.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../src/settings.js';
const output = resolve(process.argv[2] || '.tmp/release');
const target = targetFor();
const windows = process.platform === 'win32';
const asset = assetName(VERSION, target);
const archive = join(output, asset);
const bytes = readFileSync(archive);
assert.equal(
  readFileSync(archive + '.sha256', 'utf8').split(/\s+/)[0],
  createHash('sha256').update(bytes).digest('hex'),
);
const temporary = mkdtempSync(join(tmpdir(), 'circle-dist-smoke-'));
let server: ReturnType<typeof createServer> | undefined;
function sync(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const batch = windows && command.endsWith('.cmd');
  const actualCommand = batch ? 'cmd.exe' : command;
  const actualArgs = batch
    ? [
        '/d',
        '/s',
        '/c',
        `""${command}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
      ]
    : args;
  const result = spawnSync(actualCommand, actualArgs, {
    encoding: 'utf8',
    env,
    windowsVerbatimArguments: batch,
    timeout: 120_000,
    maxBuffer: 16_000_000,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
  return result.stdout;
}
function extract(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  if (windows) {
    const script = join(temporary, 'extract.ps1');
    writeFileSync(
      script,
      'param([string]$Source,[string]$Destination)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory($Source,$Destination)\n',
    );
    sync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      source,
      destination,
    ]);
  } else sync('tar', ['-xzf', source, '-C', destination]);
}
try {
  const relocated = join(temporary, 'relocated package');
  extract(archive, relocated);
  const root = join(relocated, ARCHIVE_ROOT);
  validateRelease(root);
  const node = join(root, 'runtime', windows ? 'node.exe' : 'node');
  const cli = join(root, 'app/dist/cli.js');
  assert.equal(sync(node, [cli, '--version']).trim(), VERSION);
  const home = join(temporary, 'data');
  const workspace = join(temporary, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  let calls = 0;
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { messages: unknown[] };
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta =
      calls === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    file_path: 'receipt.txt',
                    content: 'release smoke',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'release verified' };
    if (calls === 2)
      assert.match(JSON.stringify(payload.messages), /Wrote.*receipt.txt/);
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'smoke',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        '\n\n',
    );
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'smoke',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: calls === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    response.end();
  });
  await new Promise<void>((resolveReady) =>
    server!.listen(0, '127.0.0.1', resolveReady),
  );
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    model: 'smoke',
    base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  };
  saveSettings(trustFolder(settings, workspace), home);
  saveCredentials({ api_key: 'fake-release-smoke-key' }, home);
  const env = {
    ...process.env,
    CIRCLE_HOME: home,
    CIRCLE_NO_MODELS_REFRESH: '1',
  };
  const answer = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      node,
      [cli, '-p', '--yolo', 'write a receipt', workspace],
      { env },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveResult(stdout) : reject(new Error(stderr)),
    );
  });
  assert.match(answer, /release verified/);
  assert.equal(calls, 2);
  assert.equal(
    readFileSync(join(workspace, 'receipt.txt'), 'utf8'),
    'release smoke',
  );
  const preserved = ['settings.json', 'credentials.json', 'circle.sqlite'].map(
    (name) => ({
      path: join(home, name),
      bytes: readFileSync(join(home, name)),
    }),
  );
  const prefix = join(temporary, 'install space');
  const bin = join(temporary, 'bin space');
  const installEnv = {
    ...env,
    CIRCLE_VERSION: VERSION,
    CIRCLE_ASSET_DIR: output,
    CIRCLE_PREFIX: prefix,
    CIRCLE_BIN_DIR: bin,
    CIRCLE_NO_PATH: '1',
  };
  sync(
    windows ? 'powershell.exe' : 'bash',
    windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('install.ps1'),
        ]
      : [resolve('install.sh')],
    installEnv,
  );
  const launcher = join(bin, windows ? 'circle.cmd' : 'circle');
  assert.equal(sync(launcher, ['--version'], env).trim(), VERSION);
  assert.equal(activeVersion(prefix), VERSION);
  const second = join(temporary, 'second');
  cpSync(root, second, { recursive: true });
  const upgraded = VERSION.replace(
    /^(\d+)\.(\d+)\.(\d+)/,
    (_, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`,
  );
  const packageJson = JSON.parse(
    readFileSync(join(second, 'app/package.json'), 'utf8'),
  );
  packageJson.version = upgraded;
  writeFileSync(join(second, 'app/package.json'), JSON.stringify(packageJson));
  writeFileSync(
    join(second, 'app/dist/version.js'),
    readFileSync(join(second, 'app/dist/version.js'), 'utf8').replace(
      `'${VERSION}'`,
      `'${upgraded}'`,
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(second, 'release.json'), 'utf8'),
  ) as ReleaseManifest;
  manifest.version = upgraded;
  manifest.files = fileInventory(second);
  writeFileSync(join(second, 'release.json'), JSON.stringify(manifest));
  sync(
    join(second, 'runtime', windows ? 'node.exe' : 'node'),
    [join(second, 'app/dist/install_manager.js'), second, prefix, bin],
    env,
  );
  assert.equal(sync(launcher, ['--version'], env).trim(), upgraded);
  const corrupt = join(temporary, 'corrupt');
  mkdirSync(corrupt);
  cpSync(archive, join(corrupt, asset));
  writeFileSync(
    join(corrupt, asset + '.sha256'),
    '0'.repeat(64) + '  ' + asset + '\n',
  );
  const rejected = spawnSync(
    windows ? 'powershell.exe' : 'bash',
    windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('install.ps1'),
        ]
      : [resolve('install.sh')],
    { env: { ...installEnv, CIRCLE_ASSET_DIR: corrupt }, encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(activeVersion(prefix), upgraded);
  for (const row of preserved)
    assert.deepEqual(readFileSync(row.path), row.bytes);
  process.stdout.write(
    JSON.stringify({
      target,
      version: VERSION,
      relocated: true,
      installed: true,
      upgraded: true,
      checksumRejected: true,
      dataPreserved: true,
      modelRequests: calls,
      sideEffect: 'receipt.txt',
    }) + '\n',
  );
} finally {
  if (server)
    await new Promise<void>((resolveClosed) =>
      server!.close(() => resolveClosed()),
    );
  rmSync(temporary, { recursive: true, force: true });
}
