import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpManager, mcpToolName } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';

const FIXTURE = resolve('tests/fixtures/mcp-server.ts');
const server = (name: string, env?: Record<string, string>) => ({
  name,
  command: process.execPath,
  args: [FIXTURE],
  ...(env ? { env } : {}),
});
const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});

test('an MCP server named with a dot and a space starts, and the model gets and calls its tools under API-safe names', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const settings = defaultSettings();
  settings.mcp_servers = [server('lab tools.v2')];
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'env', name: 'lab_tools_v2_environment', args: {} },
      ]),
    },
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
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.name, 'lab tools.v2');
  assert.equal(runtime.mcp.status[0]?.error, '');
  await runtime.harness.run('look');
  const offered = model.requests[0]!.tools.map((tool) => tool.name);
  for (const name of [
    'lab_tools_v2_environment',
    'lab_tools_v2_login_wait',
    'lab_tools_v2_write_receipt',
  ])
    assert.ok(offered.includes(name), `${name} in ${offered.join(', ')}`);
  assert.ok(offered.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
  const result = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'env',
  )!;
  assert.match(result.content, /"pid":\d+/);
});

test('MCP tool names keep 0.5.0 names when valid and stay distinct when shortened', () => {
  assert.equal(
    mcpToolName('memory', 'create_entities'),
    'memory_create_entities',
  );
  assert.equal(
    mcpToolName('lab tools.v2', 'login.wait'),
    'lab_tools_v2_login_wait',
  );
  const long = 'x'.repeat(70);
  const one = mcpToolName(long, 'a');
  const two = mcpToolName(long, 'b');
  assert.equal(one.length, 64);
  assert.notEqual(one, two);
  assert.match(one, /^[A-Za-z0-9_-]+$/);
});

test('two MCP servers with one name, or names that become one prefix, are reported and the rest load', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  await manager.load([
    server('twin', { TEST_SUPPLIED: 'earlier' }),
    server('twin', { TEST_SUPPLIED: 'later' }),
    server('a.b'),
    server('a b'),
  ]);
  const twins = manager.status.filter((entry) => entry.name === 'twin');
  assert.equal(twins.length, 2);
  assert.match(
    twins.find((entry) => entry.error)!.error,
    /also named 'twin'; the later one is used/,
  );
  const output = await manager.tools
    .find((tool) => tool.name === 'twin_environment')!
    .run({}, { signal: new AbortController().signal, sessionId: 'one' });
  assert.equal(JSON.parse(output).supplied, 'later');
  assert.equal(manager.status.find((entry) => entry.name === 'a.b')!.error, '');
  assert.match(
    manager.status.find((entry) => entry.name === 'a b')!.error,
    /tool 'a_b_\w+' already exists/,
  );
  assert.ok(manager.tools.some((tool) => tool.name === 'a_b_environment'));
  assert.match(manager.describe(), /failed: another MCP server/);
});

// Starts the fixture's login.wait, lets `seconds` pass on a mocked clock, and says whether
// the call had ended by then. The fixture answers once `release` exists.
async function waitThrough(
  t: TestContext,
  manager: McpManager,
  root: string,
  seconds: number[],
): Promise<{ ended: boolean; release: () => Promise<string> }> {
  const release = join(root, `release-${crypto.randomUUID()}`);
  const started = release + '.started';
  let ended = false;
  const call = manager.tools
    .find((tool) => tool.name === 'fixture_login_wait')!
    .run(
      { path: release, started },
      { signal: new AbortController().signal, sessionId: 'one' },
    );
  call.then(
    () => (ended = true),
    () => (ended = true),
  );
  const deadline = performance.now() + 10_000;
  while (!existsSync(started)) {
    assert.ok(performance.now() < deadline, 'the fixture never got the call');
    await new Promise((done) => setImmediate(done));
  }
  for (const step of seconds) {
    t.mock.timers.tick(step * 1000);
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  }
  return {
    ended,
    release: async () => {
      writeFileSync(release, '');
      return call;
    },
  };
}

test('an MCP tool call is not stopped at 30 seconds, nor at the SDK default of 60 or after 300', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  await manager.load([server('fixture')]);
  assert.equal(manager.status[0]?.error, '');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const wait = await waitThrough(t, manager, root, [30.001, 30, 240, 1]);
    assert.equal(wait.ended, false);
    t.mock.timers.reset();
    assert.equal(await wait.release(), 'logged in');
  } finally {
    t.mock.timers.reset();
  }
});

test('a call timeout given to the MCP manager still stops a call on the same mocked clock', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root, 30_000, 30_000);
  cleanup(t, () => manager.close());
  await manager.load([server('fixture')]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const wait = await waitThrough(t, manager, root, [30.001]);
    assert.equal(wait.ended, true);
    t.mock.timers.reset();
    await assert.rejects(wait.release(), /timed out/i);
  } finally {
    t.mock.timers.reset();
  }
});
