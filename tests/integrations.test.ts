import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { McpManager } from '../src/mcp_loader.js';
import { ExtensionHost } from '../src/extensions.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder, saveSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { LspClient, LspManager } from '../src/lsp_tool.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultRunOptions } from '../src/run_options.js';
import type { Message } from '../src/types.js';

function extension(root: string, name: string, source: string): void {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'extension.mjs'), source);
}
const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});
const schema = '{type:"object",properties:{}}';
test('MCP stdio uses explicit server environment, preserves text errors, and closes its real child process', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'ambient-secret';
  try {
    await manager.load([
      {
        name: 'fixture',
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp-server.ts')],
        env: { TEST_SUPPLIED: 'explicit' },
      },
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.equal(manager.status[0]?.error, '');
  const context = { signal: new AbortController().signal, sessionId: 'one' };
  const output = await manager.tools
    .find((tool) => tool.name === 'fixture_environment')!
    .run({}, context);
  const observed = JSON.parse(output) as {
    pid: number;
    ambient?: string;
    supplied: string;
  };
  assert.equal(observed.ambient, undefined);
  assert.equal(observed.supplied, 'explicit');
  assert.equal(manager.tools[0]!.effect, 'unknown');
  await assert.rejects(
    manager.tools
      .find((tool) => tool.name === 'fixture_failure')!
      .run({}, context),
    /fixture error/,
  );
  await manager.close();
  assert.throws(() => process.kill(observed.pid, 0));
});
test('MCP cancellation sends a real notification that stops a delayed side effect', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'fixture',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp-server.ts')],
    },
  ]);
  const controller = new AbortController();
  const path = join(root, 'should-not-exist');
  const call = manager.tools
    .find((tool) => tool.name === 'fixture_write_receipt')!
    .run({ path, delay: 500 }, { signal: controller.signal, sessionId: 'one' });
  const result = assert.rejects(call, /cancel|Interrupted|abort/i);
  await delay(50);
  controller.abort(new Error('Interrupted'));
  await result;
  await delay(600);
  assert.equal(existsSync(path), false);
});
test('runtime gates an actual MCP tool in plan mode and later executes the same server call only after authorization', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const path = join(workspace, 'actual-receipt');
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'fixture',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp-server.ts')],
    },
  ];
  const call = (id: string) =>
    assistant('', [{ id, name: 'fixture_write_receipt', args: { path } }]);
  const model = new ScriptedModel([
    { message: call('blocked') },
    { message: assistant('planned') },
    { message: call('allowed') },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.harness.planMode = true;
  await runtime.harness.run('plan');
  assert.equal(existsSync(path), false);
  assert.match(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'blocked',
    )!.content,
    /read-only/,
  );
  runtime.harness.planMode = false;
  await runtime.harness.run('implement');
  assert.equal(readFileSync(path, 'utf8'), 'MCP wrote this');
  assert.equal(model.requests.at(-1)!.messages.at(-1)!.content, 'written');
});
test('extension discovery respects trust and disabled settings; failed staging and name clashes stay isolated', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'a_bad',
    `export function register(api){api.registerTool('half','half',${schema},()=> 'half');throw Error('registration crashed')}`,
  );
  extension(
    join(home, 'extensions'),
    'b_good',
    `export function register(api){api.registerTool('inspect','inspect',${schema},()=> ({ok:true}),{readOnly:true})}`,
  );
  extension(
    join(home, 'extensions'),
    'c_clash',
    `export function register(api){api.registerTool('execute','shadow',${schema},()=> 'wrong')}`,
  );
  extension(
    join(workspace, '.circle/extensions'),
    'project_only',
    `export function register(api){api.registerCommand('project','command',()=>{})}`,
  );
  const untrusted = await new ExtensionHost({
    home,
    workspace,
    trusted: false,
    reservedTools: new Set(['execute']),
  }).load();
  assert.ok(!untrusted.extensions.some((ext) => ext.name === 'project_only'));
  assert.deepEqual(
    untrusted.tools().map((tool) => tool.name),
    ['inspect'],
  );
  assert.match(untrusted.describe(), /registration crashed/);
  assert.match(untrusted.describe(), /already exists/);
  const trusted = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    settings: { b_good: { enabled: false } },
    reservedTools: new Set(['execute']),
  }).load();
  assert.ok(trusted.commands().has('project'));
  assert.deepEqual(trusted.tools(), []);
});
test('extension middleware, events, errors and tools run through the real runtime', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const receipt = join(root, 'events.jsonl');
  extension(
    join(home, 'extensions'),
    'sample',
    `import{appendFileSync}from'node:fs';export function register(api){api.registerTool('inspect','inspect',${schema},()=>({ok:true}),{readOnly:true});api.registerTool('failure','failure',${schema},()=>{throw new api.ToolError('expected error')},{readOnly:true});api.registerMiddleware(async(r,next)=>{r={...r,system:r.system+'\\nplugin marker'};return next(r)},'model_call');api.registerMiddleware(async(r,next)=>'wrapped '+await next(r),'tool_boundary');api.on('turn_end',event=>appendFileSync(${JSON.stringify(receipt)},JSON.stringify(event)+'\\n'));api.on('tool_result',()=>{throw Error('handler is isolated')})}`,
  );
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'inspect', name: 'inspect', args: {} },
        { id: 'failure', name: 'failure', args: {} },
      ]),
    },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: trustFolder(defaultSettings(), workspace),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('inspect');
  assert.match(model.requests[0]!.system, /plugin marker/);
  const results = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(results[0]!.content, /wrapped.*ok/);
  assert.equal(results[1]!.status, 'error');
  assert.equal(results[1]!.content, 'expected error');
  assert.match(readFileSync(receipt, 'utf8'), /done/);
  assert.match(runtime.extensions.describe(), /handler is isolated/);
});
test('stateful extensions require approval and cannot bypass read-only even when approval is disabled', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const path = join(workspace, 'changed');
  extension(
    join(home, 'extensions'),
    'writer',
    `import{writeFileSync}from'node:fs';export function register(api){api.registerTool('writer','writer',${schema},()=>{writeFileSync(${JSON.stringify(path)},'changed');return 'written'});api.registerTool('ungated','ungated',${schema},()=>{writeFileSync(${JSON.stringify(path)},'changed');return 'written'},{approval:false})}`,
  );
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'write1', name: 'writer', args: {} }]) },
    { message: assistant('refused') },
    { message: assistant('', [{ id: 'write2', name: 'ungated', args: {} }]) },
    { message: assistant('blocked') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('write');
  assert.equal(existsSync(path), false);
  assert.match(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'write1',
    )!.content,
    /approval/,
  );
  runtime.harness.planMode = true;
  await runtime.harness.run('plan');
  assert.equal(existsSync(path), false);
  assert.match(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'write2',
    )!.content,
    /read-only/,
  );
});
test('extension-defined general-purpose replaces the bundled spec, whitelists tools and retains parent cancellation', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'override',
    `export function register(api){api.registerTool('inspect','inspect',${schema},()=> 'inspected',{readOnly:true});api.registerSubagent({name:'general-purpose',description:'project inspector',system_prompt:'custom subagent marker'},['inspect'])}`,
  );
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'task',
          name: 'task',
          args: { description: 'look', subagent_type: 'general-purpose' },
        },
      ]),
    },
    { message: assistant('', [{ id: 'read', name: 'inspect', args: {} }]) },
    { message: assistant('child done') },
    { message: assistant('main done') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  const result = await runtime.harness.run('inspect');
  assert.equal(result.answer, 'main done');
  assert.match(model.requests[1]!.system, /custom subagent marker/);
  assert.deepEqual(
    model.requests[1]!.tools.map((tool) => tool.name),
    ['inspect'],
  );
  assert.match(
    runtime.harness.messages.find((message) => message.tool_call_id === 'task')!
      .content,
    /child done/,
  );
  const description = runtime.harness.tools.find(
    (tool) => tool.name === 'task',
  )!.description;
  assert.equal(description.split('- general-purpose:').length - 1, 1);
  assert.match(description, /project inspector/);
});
test('reload during a live tool keeps the same harness and the same request queue', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  saveSettings(defaultSettings(), home);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'wait', name: 'wait', args: {} }]) },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const original = runtime.harness;
  original.tools.push({
    name: 'wait',
    description: '',
    parameters: {},
    effect: 'read',
    run: async () => {
      entered();
      await gate;
      return 'done';
    },
  });
  const running = original.run('start');
  await ready;
  await assert.rejects(runtime.reloadIntegrations(), /current turn/);
  assert.equal(runtime.harness, original);
  original.queue('steer');
  original.clearQueue();
  release();
  await running;
});
test('LSP reads fragmented byte frames, opens documents by notification and times out without blocking', async (t) => {
  const root = scratch(t);
  const path = join(root, 'file.ts');
  writeFileSync(path, 'const 中文 = 1;');
  const log = join(root, 'lsp.json');
  const previous = process.env.LSP_TEST_LOG;
  process.env.LSP_TEST_LOG = log;
  const client = new LspClient(
    {
      command: process.execPath,
      args: [resolve('tests/fixtures/lsp-server.ts')],
    },
    root,
    200,
  );
  if (previous === undefined) delete process.env.LSP_TEST_LOG;
  else process.env.LSP_TEST_LOG = previous;
  cleanup(t, () => client.close());
  const signal = new AbortController().signal;
  await client.initialize(signal);
  client.open(path);
  const result = await client.request(
    'textDocument/hover',
    { textDocument: { uri: path } },
    signal,
  );
  assert.match(JSON.stringify(result), /文档 hover/);
  const records = JSON.parse(readFileSync(log, 'utf8')) as {
    id?: number;
    method: string;
  }[];
  assert.equal(
    records.find((record) => record.method === 'textDocument/didOpen')?.id,
    undefined,
  );
  const started = Date.now();
  await assert.rejects(client.request('never/respond', {}, signal), /timeout/);
  assert.ok(Date.now() - started < 1500);
  await client.close();
});
test('the LSP tool sends file content and converts one-based editor positions to protocol positions', async (t) => {
  const root = scratch(t);
  const path = join(root, 'file.ts');
  writeFileSync(path, 'const value = 1;');
  const log = join(root, 'requests.json');
  const previous = process.env.LSP_TEST_LOG;
  process.env.LSP_TEST_LOG = log;
  const manager = new LspManager(new Sandbox(root), {
    '.ts': {
      command: process.execPath,
      args: [resolve('tests/fixtures/lsp-server.ts')],
    },
  });
  cleanup(t, () => manager.close());
  try {
    const result = await manager.tool().run(
      {
        operation: 'goToDefinition',
        filePath: 'file.ts',
        line: 3,
        character: 4,
      },
      { signal: new AbortController().signal, sessionId: 'test' },
    );
    assert.match(result, /definition.ts/);
  } finally {
    if (previous === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = previous;
  }
  const records = JSON.parse(readFileSync(log, 'utf8')) as {
    method: string;
    params: Record<string, unknown>;
  }[];
  assert.deepEqual(
    records.find((record) => record.method === 'textDocument/definition')!
      .params.position,
    { line: 2, character: 3 },
  );
  assert.equal(
    (
      records.find((record) => record.method === 'textDocument/didOpen')!.params
        .textDocument as { text: string }
    ).text,
    'const value = 1;',
  );
});
test('main tool limits retain the subagent tool set and subagent approvals belong to the visible session', async (t) => {
  const root = scratch(t);
  const path = join(root, 'child.txt');
  const run = defaultRunOptions();
  run.tools = ['task'];
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'task',
          name: 'task',
          args: { description: 'write in the child' },
        },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: path, content: 'child effect' },
        },
      ]),
    },
    { message: assistant('child done') },
    { message: assistant('main done') },
  ]);
  let approvals = 0;
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    run,
    headless: true,
    approve: async () => {
      approvals++;
      return 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('task');
  assert.deepEqual(runtime.harness.tools.map((tool) => tool.name).sort(), [
    'compact_conversation',
    'task',
  ]);
  assert.ok(
    model.requests[1]!.tools.some((tool) => tool.name === 'write_file'),
  );
  assert.equal(readFileSync(path, 'utf8'), 'child effect');
  assert.equal(approvals, 1);
  assert.equal(runtime.policy.store.rules(runtime.session.id).length, 1);
});
test('a read-only switch while a child approval is pending blocks the already queued mutation', async (t) => {
  const root = scratch(t);
  const path = join(root, 'blocked.txt');
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'task',
          name: 'task',
          args: { description: 'write in the child' },
        },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: path, content: 'must not write' },
        },
      ]),
    },
    { message: assistant('child blocked') },
    { message: assistant('main done') },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
    approve: async () => {
      entered();
      await gate;
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  const running = runtime.harness.run('task');
  await ready;
  runtime.harness.planMode = true;
  release();
  await running;
  assert.equal(existsSync(path), false);
});
test('read-only is rechecked after awaited extension middleware before the actual effect', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const path = join(workspace, 'blocked.txt');
  extension(
    join(home, 'extensions'),
    'delay',
    `export function register(api){api.registerMiddleware(async(request,next)=>{await new Promise(resolve=>setTimeout(resolve,50));return next(request)},'tool_boundary')}`,
  );
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: path, content: 'must not be written' },
        },
      ]),
    },
    { message: assistant('blocked') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.bus.subscribe((event) => {
    if (event.kind === 'tool_start')
      setTimeout(() => {
        runtime.harness.planMode = true;
      }, 5);
  });
  await runtime.harness.run('write');
  assert.equal(existsSync(path), false);
  assert.match(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'write',
    )!.content,
    /read-only/,
  );
});
