import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  mkdir,
  writeFile,
  readFile,
  symlink,
  cp,
  realpath,
  rm,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { workspaceRuntimePath } from '../src/runtime-tools.ts';

test('worker runtime PATH preparation preserves original entries and is idempotent', () => {
  const original = process.env.PATH;
  const runtime = join('/synthetic', 'node', 'bin', 'node');
  const once = workspaceRuntimePath(runtime, original);
  assert.equal(workspaceRuntimePath(runtime, once), once);
  assert.ok(once.startsWith(dirname(runtime)));
  assert.equal(process.env.PATH, original);
});

test('actual scripted desktop worker runs nested npm with strict system PATH through bundled Node', async () => {
  const originalPath = process.env.PATH;
  const nodeRuntime =
    process.env.CIRCLE_JS_DEBUG_RUNTIME ??
    fileURLToPath(
      new URL(
        '../dist/tools/node/bin/' +
          (process.platform === 'win32' ? 'node.exe' : 'node'),
        import.meta.url,
      ),
    );
  const expected = await realpath(nodeRuntime);
  const toolsRoot = dirname(dirname(nodeRuntime));
  const appModules = fileURLToPath(new URL('../node_modules', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'circle-worker-npm-'));
  const app = join(root, 'app'),
    home = join(root, 'home'),
    workspace = join(root, 'workspace');
  try {
    await Promise.all(
      [app, home, workspace, join(app, 'tools')].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await symlink(
      toolsRoot,
      join(app, 'tools/node'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // The shipped worker finds its external packages beside it: the desktop's own,
    // plus koffi and its native package (the Windows command Job), from the root.
    const modules = join(app, 'node_modules');
    await mkdir(modules);
    const link = (from: string, name: string) =>
      symlink(
        from,
        join(modules, name),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    for (const name of await readdir(appModules))
      if (!name.startsWith('.')) await link(join(appModules, name), name);
    const rootModules = fileURLToPath(
      new URL('../../../node_modules', import.meta.url),
    );
    for (const name of ['koffi', '@koromix'])
      if (!existsSync(join(modules, name)))
        await link(join(rootModules, name), name);
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: { outer: 'npm run inner', inner: 'node probe.cjs' },
      }),
    );
    await writeFile(
      join(workspace, 'probe.cjs'),
      `console.log('BUNDLED_EXEC_PATH='+require('fs').realpathSync(process.execPath));console.log('NESTED_NODE_VERSION='+process.version);`,
    );
    const settings = trustFolder(defaultSettings(), workspace);
    settings.initialized = true;
    settings.update_check = false;
    saveSettings(settings, home);
    await writeFile(
      join(home, 'desktop-session.json'),
      JSON.stringify({ workspace, sessionId: 'missing-fixture-session' }),
    );
    const fixture = join(root, 'fixture.json'),
      requests = join(root, 'requests.jsonl');
    await writeFile(
      fixture,
      JSON.stringify({
        requestsPath: requests,
        replies: [
          {
            message: {
              id: 'npm-call',
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'execute-npm',
                  name: 'execute',
                  args: { command: 'npm run outer' },
                },
              ],
            },
          },
          {
            message: {
              id: 'done',
              role: 'assistant',
              content: 'worker npm done',
            },
          },
        ],
      }),
    );
    // Match the shipped worker's complete resource layout. A native execute
    // starts this static supervisor with the bundled Node; it has no fallback
    // into this checkout or the user's PATH.
    await cp(
      fileURLToPath(
        new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
      ),
      join(app, 'tools', 'command-supervisor.mjs'),
    );
    const bundle = join(app, 'runtime-worker.mjs');
    await build({
      entryPoints: [
        fileURLToPath(new URL('../src/runtime-worker.ts', import.meta.url)),
      ],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      // Match build.mjs: keep Koffi's loader/native payload external and avoid
      // colliding with module imports bundled from dependencies.
      external: [
        'koffi',
        'node-pty',
        'typescript-language-server',
        'typescript',
      ],
      banner: {
        js: "import { createRequire as circleCreateRequire } from 'node:module'; const require = circleCreateRequire(import.meta.url);",
      },
    });
    for (const folder of ['prompts', 'data'])
      await cp(
        fileURLToPath(new URL(`../../../src/${folder}`, import.meta.url)),
        join(app, folder),
        { recursive: true },
      );
    const wrapper = `let listener,started=false;Object.defineProperty(process,'parentPort',{value:{on(n,cb){listener=cb},postMessage(m){if(m.type==='update'&&!started){started=true;queueMicrotask(()=>listener({data:{id:'auto',name:'set-auto',sessionId:m.update.snapshot.activeSessionId,payload:{enabled:true}}}));}if(m.type==='reply'&&m.reply.id==='auto'){queueMicrotask(()=>listener({data:{id:'prompt',name:'prompt',payload:{text:'Run the nested npm fixture'}}}));}if(m.type==='update'&&m.update.snapshot.sessions.some(s=>s.messages.some(v=>v.text==='worker npm done'))){queueMicrotask(()=>listener({data:{id:'finish',name:'close',payload:{}}}));}if(m.type==='reply'&&m.reply.id==='finish'){console.log('WORKER_NPM_DONE');process.exit(0);}}}});await import(${JSON.stringify(pathToFileURL(bundle).href)});`;
    const systemPath =
      process.platform === 'win32'
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
        : '/usr/bin:/bin:/usr/sbin:/sbin';
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', wrapper],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: systemPath,
          HOME: home,
          USERPROFILE: home,
          ZDOTDIR: home,
          ENV: '',
          BASH_ENV: '',
          CIRCLE_HOME: home,
          CIRCLE_DESKTOP_RUNTIME_HOME: home,
          CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
          CIRCLE_WORKBENCH_TEST_PROFILE: '1',
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_NO_UPDATE_CHECK: '1',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          NPM_CONFIG_AUDIT: 'false',
          NPM_CONFIG_FUND: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('worker npm fixture timed out'));
      }, 30000);
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /WORKER_NPM_DONE/);
    const actualRequests = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(actualRequests.length, 2);
    const output = actualRequests[1].messages.find(
      (message: { tool_call_id?: string }) =>
        message.tool_call_id === 'execute-npm',
    );
    assert.ok(output);
    const history = new CheckpointStore(home);
    let stored;
    try {
      stored = history
        .list(undefined, true)
        .flatMap((session) => history.messages(session.id))
        .find(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'execute-npm',
        );
    } finally {
      history.close();
    }
    assert.ok(
      stored,
      'the real worker persists its execute result before closing',
    );
    assert.equal(stored.status, output.status);
    assert.equal(stored.content, output.content);
    assert.deepEqual(stored.commandExecutions, output.commandExecutions);
    assert.equal(output.status, 'success', JSON.stringify({ output, stored }));
    if (process.platform !== 'win32') {
      assert.equal(stored.commandExecutions?.length, 1);
      const receipt = stored.commandExecutions![0]!;
      assert.equal(receipt.toolCallId, 'execute-npm');
      assert.equal(receipt.completion.kind, 'pty-group');
      assert.equal(receipt.completion.rootExit?.exitCode, 0);
      assert.ok(receipt.completion.controlledGroupEmpty);
      assert.ok(receipt.completion.transportAndLogClosed);
      assert.ok(receipt.terminal);
      const workspaceHash = createHash('sha256')
        .update(await realpath(workspace))
        .digest('hex');
      const terminal = JSON.parse(
        await readFile(
          join(
            root,
            'workspace-services',
            'workspaces',
            workspaceHash,
            'terminals',
            receipt.terminal.id,
            'metadata.json',
          ),
          'utf8',
        ),
      );
      assert.equal(terminal.id, receipt.terminal.id);
      assert.equal(terminal.epoch, receipt.terminal.epoch);
      assert.equal(terminal.managedCommand.executionId, receipt.executionId);
      assert.equal(terminal.managedCommand.executionEpoch, receipt.epoch);
      assert.equal(terminal.managedCommand.commandPid, receipt.pid);
      assert.equal(terminal.sessionId, receipt.executionSessionId);
    }

    assert.ok(
      output.content.includes(`BUNDLED_EXEC_PATH=${expected}`),
      output.content,
    );
    assert.match(output.content, /NESTED_NODE_VERSION=v24\./);
    assert.equal(
      process.env.PATH,
      originalPath,
      'host process environment must remain unchanged',
    );
  } finally {
    // Windows keeps the folder busy for a moment after the worker exits.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});
