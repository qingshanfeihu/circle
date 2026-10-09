import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runRpc } from '../src/rpc.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { scratch, cleanup } from './helpers.js';
import type { Message, ModelResponse } from '../src/types.js';
import { rpcMessage } from '../src/rpc_codec.js';
const answer = (content: string): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
});
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('RPC did not reach expected state');
    await delay(5);
  }
}
test('RPC reports queue, busy guards, persisted usage, model changes and exported HTML through the real runtime', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  saveCredentials({ api_key: 'fake' }, home);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    async (request) => {
      await new Promise<void>((resolve, reject) => {
        gate.then(resolve);
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      });
      return {
        message: answer('first answer'),
        usage: { input_tokens: 12, output_tokens: 7, cache_read_tokens: 3 },
      };
    },
  ]);
  const settings = defaultSettings();
  settings.auth.base_url = 'http://127.0.0.1:1/v1';
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  cleanup(t, () => {
    input.destroy();
  });
  const output: Record<string, unknown>[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => {
      output.push(JSON.parse(text));
    },
  });
  const send = (value: unknown): void => {
    input.write(JSON.stringify(value) + '\n');
  };
  const response = (id: string): Record<string, unknown> | undefined =>
    output.find((record) => record.id === id);
  send({ id: 'start', type: 'prompt', message: 'start' });
  await waitFor(() => model.requests.length === 1);
  send({ id: 'steer', type: 'steer', message: 'steer' });
  send({ id: 'follow', type: 'follow_up', message: 'follow' });
  send({ id: 'state', type: 'get_state' });
  send({ id: 'busy', type: 'set_model', modelId: 'new-model' });
  send({ id: 'clear', type: 'clear_queue' });
  await waitFor(() => Boolean(response('clear')));
  assert.equal(
    (response('state')!.data as { pendingMessageCount: number })
      .pendingMessageCount,
    2,
  );
  assert.equal(response('busy')!.success, false);
  assert.deepEqual(response('clear')!.data, {
    steering: ['steer'],
    followUp: ['follow'],
  });
  release();
  await waitFor(() => output.some((record) => record.type === 'agent_settled'));
  send({ id: 'stats', type: 'get_session_stats' });
  send({ id: 'export', type: 'export_html', outputPath: 'conversation.html' });
  send({ id: 'set', type: 'set_model', modelId: 'new-model' });
  send({ id: 'thinking', type: 'set_thinking_level', level: 'high' });
  send({ id: 'again', type: 'set_model', modelId: 'new-model' });
  send({ id: 'messages', type: 'get_messages' });
  send({ id: 'final', type: 'get_state' });
  await waitFor(() => Boolean(response('final')));
  const stats = response('stats')!.data as {
    tokens: Record<string, number>;
    userMessages: number;
    assistantMessages: number;
  };
  assert.deepEqual(stats.tokens, { input: 12, output: 7, total: 19 });
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(runtime.stats().usage.cache_read_tokens, 3);
  assert.deepEqual(response('thinking')!.data, { thinkingLevel: 'high' });
  const wire = (
    response('messages')!.data as {
      messages: { type: string; data: { content: string } }[];
    }
  ).messages;
  assert.deepEqual(
    wire.map((message) => message.type),
    ['human', 'ai'],
  );
  assert.equal(wire[1]!.data.content, 'first answer');
  assert.ok(existsSync(join(workspace, 'conversation.html')));
  assert.match(
    readFileSync(join(workspace, 'conversation.html'), 'utf8'),
    /first answer/,
  );
  assert.equal(
    (response('final')!.data as { model: string; thinkingLevel: string }).model,
    'new-model',
  );
  assert.equal(
    (response('final')!.data as { thinkingLevel: string }).thinkingLevel,
    'high',
  );
  const id = runtime.session.id;
  input.end();
  assert.equal(await runner, 0);
  await runtime.close();
  const reopened = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => reopened.close());
  assert.deepEqual(reopened.stats().usage, {
    input_tokens: 12,
    output_tokens: 7,
    cache_read_tokens: 3,
  });
});

test('RPC message DTOs match frozen serialization samples without loading a framework', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/rpc-messages.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { native: Message; expected: unknown }[] };
  for (const item of fixture.cases)
    assert.deepEqual(rpcMessage(item.native), item.expected);
});

test('RPC list_jobs and jobId stop the real process before reporting the settled job', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  writeFileSync(
    join(root, 'job.cjs'),
    "require('node:fs').writeFileSync('ready', 'yes'); setTimeout(() => require('node:fs').writeFileSync('late', 'bad'), 2000); setTimeout(() => {}, 10000);",
  );
  const input = new PassThrough();
  const output: any[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  const job = runtime.jobs.startShell(
    `"${process.execPath}" "${join(root, 'job.cjs')}"`,
    { sessionId: runtime.session.id, startedBy: 'user' },
  );
  await waitFor(() => existsSync(join(root, 'ready')));
  input.write(JSON.stringify({ id: 'list', type: 'list_jobs' }) + '\n');
  input.write(
    JSON.stringify({ id: 'stop', type: 'stop_job', jobId: job.id }) + '\n',
  );
  await waitFor(() => output.some((record) => record.id === 'stop'));
  const listed = output.find((record) => record.id === 'list').data.jobs[0];
  assert.equal(listed.output, job.virtualPath);
  assert.equal(listed.startedBy, 'user');
  assert.equal(typeof listed.elapsed, 'number');
  assert.equal(listed.exitCode, null);
  assert.equal(
    output.find((record) => record.id === 'stop').data.job.status,
    'stopped',
  );
  input.write(
    JSON.stringify({ id: 'again', type: 'stop_job', jobId: job.id }) + '\n',
  );
  input.end();
  assert.equal(await runner, 0);
  assert.equal(output.find((record) => record.id === 'again').success, false);
  await delay(2200);
  assert.equal(existsSync(join(root, 'late')), false);
  assert.ok(
    output.some(
      (record) =>
        record.type === 'job' &&
        record.event === 'ended' &&
        record.job.id === job.id,
    ),
  );
  assert.equal(output.at(-1).type, 'jobs_stopped');
});

test('closing RPC input waits for a model job and delivers its actual result in a notice turn', async (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'job.cjs'),
    "setTimeout(() => { require('node:fs').writeFileSync('receipt', 'completed'); console.log('actual result'); }, 250);",
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'start',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'background',
            name: 'execute',
            args: {
              command: `"${process.execPath}" "${join(root, 'job.cjs')}"`,
              background: true,
            },
          },
        ],
      },
    },
    { message: answer('started') },
    { message: answer('noticed') },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  runtime.policy.setYolo(runtime.session.id, true);
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const output: any[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  input.end(
    JSON.stringify({
      id: 'prompt',
      type: 'prompt',
      message: 'start background work',
    }) + '\n',
  );
  assert.equal(await runner, 0);
  assert.equal(readFileSync(join(root, 'receipt'), 'utf8'), 'completed');
  assert.equal(model.requests.length, 3);
  assert.ok(
    model.requests[2]!.messages.some(
      (message) =>
        message.internal === 'job_notice' &&
        message.content.includes('actual result'),
    ),
  );
  assert.equal(
    runtime.jobs.list().some((job) => job.status === 'running'),
    false,
  );
  assert.deepEqual(output.at(-1), { type: 'jobs_stopped', count: 0 });
});
