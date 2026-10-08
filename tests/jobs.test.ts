import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JobRegistry, outputTail, plainJobOutput } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message, ModelResponse, Tool } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { InteractionQueue } from '../src/tui/interaction_queue.js';
import { installExitGuard } from '../src/exit_guard.js';
import { scratch, cleanup } from './helpers.js';
let scriptNumber = 0;
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function script(root: string, code: string): string {
  const path = join(root, `job-${++scriptNumber}.cjs`);
  writeFileSync(path, code);
  return `"${process.execPath}" "${path}"`;
}
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for actual job state');
    await delay(20);
  }
}
function response(
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
): ModelResponse {
  return {
    message: { id, role: 'assistant', content, tool_calls: calls },
    usage: emptyUsage(),
  };
}
test('background shells retain complete ordered output, UTF-8 bytes, exit codes and conversation-owned notices', async (t) => {
  const root = scratch(t);
  const sandbox = new Sandbox(root, join(root, 'data'));
  const jobs = new JobRegistry(sandbox);
  cleanup(t, () => jobs.close().then(() => {}));
  const command = script(
    root,
    `const fs=require('fs'); fs.writeSync(1,'first\\n'); fs.writeSync(2,'second\\n'); const bytes=Buffer.from('中文🙂\\n'); for (const b of bytes) fs.writeSync(1,Buffer.from([b])); fs.writeSync(1,'x'.repeat(90000)); process.exitCode=7;`,
  );
  const job = jobs.startShell(command, { sessionId: 'one' });
  await jobs.wait([job.id], 5, new AbortController().signal);
  assert.equal(jobs.get(job.id)!.status, 'failed');
  assert.equal(jobs.get(job.id)!.exitCode, 7);
  assert.equal(
    sandbox.resolvePath(job.virtualPath),
    realpathSync(job.outputPath),
  );
  const output = readFileSync(job.outputPath, 'utf8');
  assert.ok(output.startsWith('first\nsecond\n中文🙂\n'));
  assert.ok(output.length > 90000);
  assert.equal(jobs.takeNotices('two').length, 0);
  const notices = jobs.takeNotices('one');
  assert.equal(notices[0]!.internal, 'job_notice');
  assert.match(notices[0]!.content, /exit 7/);
  assert.equal(jobs.takeNotices('one').length, 0);
  assert.throws(() => sandbox.checkMutablePath(job.outputPath), /read-only/);
});
test('Ctrl+B and the default timeout promote the actual running command without starting it twice', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  const command = script(
    root,
    `const fs=require('fs'); fs.appendFileSync('runs.txt','once\\n'); setTimeout(()=>console.log('completed'),200);`,
  );
  const first = jobs.execute(
    command,
    { sessionId: 'one' },
    new AbortController().signal,
    undefined,
    30,
  );
  const moved = await first;
  assert.ok(moved.job);
  await jobs.wait([moved.job.id], 5, new AbortController().signal);
  assert.equal(readFileSync(join(root, 'runs.txt'), 'utf8'), 'once\n');
  const second = jobs.execute(
    command,
    { sessionId: 'one' },
    new AbortController().signal,
  );
  assert.equal(jobs.backgroundForeground(), 1);
  const userMoved = await second;
  assert.equal(userMoved.how, 'moved');
  await jobs.wait([userMoved.job!.id], 5, new AbortController().signal);
  assert.equal(readFileSync(join(root, 'runs.txt'), 'utf8'), 'once\nonce\n');
});
test('explicit foreground timeout stops a command and never silently promotes it', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  const result = await jobs.execute(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: 'one' },
    new AbortController().signal,
    0.05,
  );
  assert.match(result.output, /timeout/);
  assert.equal(jobs.list().length, 0);
  assert.equal(result.job, undefined);
  await assert.rejects(
    jobs.execute(
      'echo bad',
      { sessionId: 'one' },
      new AbortController().signal,
      0,
    ),
    /positive/,
  );
});
test(
  'a foreground shell that exits adopts its remaining process group and stopping the job prevents late writes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t);
    const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
    cleanup(t, () => jobs.close().then(() => {}));
    const childPath = join(root, 'left-running.cjs');
    writeFileSync(
      childPath,
      `require('fs').writeFileSync('adopted-ready','ok'); setTimeout(()=>require('fs').writeFileSync('adopted-late','bad'),2000);`,
    );
    const command = script(
      root,
      `require('child_process').spawn(process.execPath,[${JSON.stringify(childPath)}],{stdio:'inherit'}); process.exit(0);`,
    );
    const result = await jobs.execute(
      command,
      { sessionId: 'one' },
      new AbortController().signal,
    );
    assert.equal(result.job!.kind, 'adopted');
    assert.equal(result.how, 'adopted');
    await until(() => existsSync(join(root, 'adopted-ready')));
    await jobs.stop(result.job!.id);
    await delay(2200);
    assert.equal(existsSync(join(root, 'adopted-late')), false);
  },
);
test('job display discards terminal commands and carriage-return progress while raw log bytes remain intact', () => {
  assert.equal(
    plainJobOutput(
      '\x1b]52;c;c2VjcmV0\x07\x1b[2Jloading 10%\r\x1b[31mcomplete\x1b[0m\t✓\r\n',
    ),
    'complete    ✓\n',
  );
});
test('stop and close end real process trees before late file writes on every supported OS', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  const marker = join(root, 'late.txt');
  const ready = join(root, 'ready.txt');
  const child = join(root, 'child.cjs');
  writeFileSync(
    child,
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),2000);`,
  );
  const command = script(
    root,
    `require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'}); setTimeout(()=>{},10000);`,
  );
  const job = jobs.startShell(command, { sessionId: 'one' });
  await until(() => existsSync(ready));
  await jobs.stop(job.id, 'user');
  assert.equal(jobs.get(job.id)!.status, 'stopped');
  await delay(2200);
  assert.equal(existsSync(marker), false);
  const second = jobs.startShell(script(root, 'setTimeout(()=>{},10000);'), {
    sessionId: 'two',
  });
  const stopped = await jobs.close();
  assert.ok(stopped.some((job) => job.id === second.id));
  assert.equal(jobs.get(second.id)!.status, 'stopped');
});
test('cancelling a foreground command waits for termination; a promoted job belongs to the application', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  const controller = new AbortController();
  const run = jobs.execute(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: 'one' },
    controller.signal,
  );
  controller.abort(new Error('Interrupted'));
  await assert.rejects(run, /Interrupted/);
  const nextController = new AbortController();
  const next = jobs.execute(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: 'one' },
    nextController.signal,
  );
  jobs.backgroundForeground();
  const result = await next;
  nextController.abort(new Error('Interrupted'));
  assert.equal(jobs.get(result.job!.id)!.status, 'running');
});
test('output limits and background timeouts fail jobs, and capacity checks do not launch rejected commands', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    undefined,
    1,
    1024,
  );
  cleanup(t, () => jobs.close().then(() => {}));
  const job = jobs.startShell(
    script(root, `console.log('x'.repeat(3000)); setTimeout(()=>{},10000);`),
    { sessionId: 'one' },
  );
  assert.throws(
    () => jobs.startShell('echo bad', { sessionId: 'one' }),
    /already running/,
  );
  await jobs.wait([job.id], 5, new AbortController().signal);
  assert.equal(jobs.get(job.id)!.status, 'failed');
  assert.equal(jobs.get(job.id)!.reason, 'output limit');
  const timed = jobs.startShell(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: 'one' },
    0.05,
  );
  await jobs.wait([timed.id], 5, new AbortController().signal);
  assert.equal(jobs.get(timed.id)!.reason, 'timeout');
  assert.equal(jobs.get(timed.id)!.status, 'failed');
});
test('subagent reports are logged and stopping awaits the asynchronous cancellation cleanup', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  let cleaned = false;
  const job = jobs.startAgent(
    'research',
    { sessionId: 'one' },
    async (signal, log) => {
      log('read_file(docs)');
      try {
        await delay(10000, undefined, { signal });
        return 'report';
      } finally {
        await delay(40);
        cleaned = true;
      }
    },
  );
  await until(() => outputTail(job.outputPath).includes('read_file'));
  await jobs.stop(job.id);
  assert.equal(cleaned, true);
  assert.equal(jobs.get(job.id)!.status, 'stopped');
});
test('a completed job is checkpointed before the next real model request, then survives restart without replay', async (t) => {
  const root = scratch(t);
  let runtime!: AgentRuntime;
  const wait: Tool = {
    name: 'wait_for_finish',
    description: 'Wait in this test only',
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    approval: false,
    run: async () => {
      await until(() => runtime.jobs.get('j1')?.status === 'done');
      return 'settled';
    },
  };
  const command = script(
    root,
    `require('fs').appendFileSync('receipt.txt','once'); console.log('job receipt');`,
  );
  const model = new ScriptedModel([
    response('start', '', [
      {
        id: 'background',
        name: 'execute',
        args: { command, background: true },
      },
      { id: 'wait', name: wait.name, args: {} },
    ]),
    response('end', 'observed'),
  ]);
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    extraTools: [wait],
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('run a job');
  const notice = model.requests[1]!.messages.find(
    (message) => message.internal === 'job_notice',
  );
  assert.match(notice!.content, /job receipt/);
  assert.equal(
    runtime.harness.messages.filter(
      (message) => message.internal === 'job_notice',
    ).length,
    1,
  );
  const id = runtime.session.id;
  await runtime.close();
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => resumed.close());
  assert.equal(resumed.jobs.list().length, 0);
  assert.equal(
    resumed.harness.messages.filter(
      (message) => message.internal === 'job_notice',
    ).length,
    1,
  );
  assert.equal(readFileSync(join(root, 'receipt.txt'), 'utf8'), 'once');
});
test('an idle job notice resumes the model without inventing a user prompt and stopped jobs never wake it', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    response('answer', 'read the completed job'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const job = runtime.jobs.startShell(script(root, 'console.log("ready");'), {
    sessionId: runtime.session.id,
  });
  await runtime.jobs.wait([job.id], 5, new AbortController().signal);
  assert.equal(await runtime.runJobNotices(), 'read the completed job');
  assert.equal(
    runtime.harness.messages.filter(
      (message) => message.role === 'user' && !message.internal,
    ).length,
    0,
  );
  const stopped = runtime.jobs.startShell(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: runtime.session.id },
  );
  await runtime.jobs.stop(stopped.id);
  assert.equal(await runtime.runJobNotices(), undefined);
  assert.equal(model.requests.length, 1);
});
test('native background subagents return immediately, retain live read-only checks and report without nested task tools', async (t) => {
  const root = scratch(t);
  const reached = deferred<void>();
  const release = deferred<void>();
  const requests: import('../src/types.js').ModelRequest[] = [];
  const model: import('../src/types.js').ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      requests.push(request);
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )!.content;
      if (user === 'research') {
        if (!request.messages.some((message) => message.role === 'tool')) {
          reached.resolve();
          await release.promise;
          return response('child-write', '', [
            {
              id: 'child-write',
              name: 'write_file',
              args: { file_path: 'blocked.txt', content: 'bad' },
            },
          ]);
        }
        return response(
          'child-report',
          'Research complete; write remained blocked.',
        );
      }
      return request.messages.some((message) => message.role === 'assistant')
        ? response('main-end', 'Research is running.')
        : response('main-start', '', [
            {
              id: 'task',
              name: 'task',
              args: { description: 'research', background: true },
            },
          ]);
    },
  };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: false,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  assert.equal(
    (await runtime.harness.run('start')).answer,
    'Research is running.',
  );
  await reached.promise;
  const job = runtime.jobs.get('j1')!;
  assert.equal(job.status, 'running');
  await runtime.reloadIntegrations();
  assert.ok(!runtime.harness.tools.some((tool) => tool.name === 'wait_jobs'));
  runtime.setPlanMode(true);
  release.resolve();
  await runtime.jobs.wait([job.id], 5, new AbortController().signal);
  assert.equal(existsSync(join(root, 'blocked.txt')), false);
  assert.equal(runtime.jobs.get(job.id)!.status, 'done');
  assert.match(outputTail(job.outputPath), /write remained blocked/);
  const childRequest = requests.find(
    (request) => request.messages[0]?.content === 'research',
  )!;
  assert.ok(!childRequest.tools.some((tool) => tool.name === 'task'));
  assert.ok(childRequest.tools.some((tool) => tool.name === 'wait_jobs'));
  assert.ok(!runtime.harness.tools.some((tool) => tool.name === 'wait_jobs'));
});
test('a background subagent ends every shell it owns before its report is marked complete', async (t) => {
  const root = scratch(t);
  const command = script(
    root,
    `require('fs').writeFileSync('server-ready','ok'); setTimeout(()=>require('fs').writeFileSync('late-server','bad'),2000);`,
  );
  const model: import('../src/types.js').ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )!.content;
      const hasTool = request.messages.some(
        (message) => message.role === 'tool',
      );
      if (user === 'server research') {
        if (!hasTool)
          return response('server', '', [
            {
              id: 'server',
              name: 'execute',
              args: { command, background: true },
            },
          ]);
        await until(() => existsSync(join(root, 'server-ready')));
        return response('report', 'Server research finished.');
      }
      return hasTool
        ? response('main-end', 'started')
        : response('main-start', '', [
            {
              id: 'task',
              name: 'task',
              args: { description: 'server research', background: true },
            },
          ]);
    },
  };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('start');
  await runtime.jobs.wait(['j1'], 5, new AbortController().signal);
  assert.equal(runtime.jobs.get('j1')!.status, 'done');
  assert.equal(runtime.jobs.get('j2')!.parent, 'j1');
  assert.equal(runtime.jobs.get('j2')!.status, 'stopped');
  await delay(2200);
  assert.equal(existsSync(join(root, 'late-server')), false);
});
test('card ownership queues background interactions while typing, prioritizes foreground and cancels queued cards without presenting them', async (t) => {
  let typing = true;
  const order: string[] = [];
  const queue = new InteractionQueue((background) => !background || !typing);
  t.after(() => queue.close());
  const controller = new AbortController();
  const cancelled = queue.run(
    async () => {
      order.push('cancelled');
    },
    controller.signal,
    true,
  );
  const rejected = assert.rejects(cancelled, /Interrupted/);
  controller.abort(new Error('Interrupted'));
  await rejected;
  const gate = deferred<void>();
  const background = queue.run(
    async () => {
      order.push('background');
    },
    new AbortController().signal,
    true,
  );
  const foreground = queue.run(async () => {
    order.push('foreground');
    await gate.promise;
  }, new AbortController().signal);
  typing = false;
  await delay(70);
  assert.deepEqual(order, ['foreground']);
  gate.resolve();
  await Promise.all([background, foreground]);
  assert.deepEqual(order, ['foreground', 'background']);
});
test('terminal signal cleanup awaits actual jobs before exit and records no ordinary exit notice', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const job = runtime.jobs.startShell(
    script(root, 'setTimeout(()=>{},10000);'),
    { sessionId: runtime.session.id },
  );
  const exited = deferred<number>();
  const off = installExitGuard(runtime, (code) => exited.resolve(code));
  t.after(off);
  process.emit('SIGTERM');
  assert.equal(await exited.promise, 143);
  assert.equal(runtime.jobs.get(job.id)!.status, 'stopped');
});
test('concurrent shutdown callers wait for the same subagent cleanup and save one cancellation notice', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const started = deferred<void>();
  let cleaned = false;
  runtime.jobs.startAgent(
    'slow cleanup',
    { sessionId: runtime.session.id },
    async (signal) => {
      started.resolve();
      try {
        await delay(10000, undefined, { signal });
        return 'done';
      } finally {
        await delay(50);
        cleaned = true;
      }
    },
  );
  await started.promise;
  const id = runtime.session.id;
  const first = runtime.close();
  const second = runtime.close();
  await second;
  assert.equal(cleaned, true);
  await first;
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => resumed.close());
  const notices = resumed.harness.messages.filter(
    (message) => message.internal === 'job_notice',
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, /stopped/);
});
