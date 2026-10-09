import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('Windows cancellation waits for the original tree termination after shell close and escalation', () => {
  // Isolate builtin mocks and platform changes from the other test workers.
  const sandboxUrl = new URL('../src/sandbox.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { setTimeout as delay } from 'node:timers/promises';
    import { Sandbox } from ${JSON.stringify(sandboxUrl)};
    const child = new EventEmitter();
    child.pid = 123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    childProcess.spawn = () => child;
    const requests = [];
    childProcess.execFile = (file, args, callback) => {
      assert.equal(file, 'taskkill');
      assert.deepEqual(args, ['/PID', '123', '/T', '/F']);
      requests.push(callback);
      // A second request can return immediately once the shell PID is gone,
      // while the first request is still terminating descendants.
      if (requests.length > 1) queueMicrotask(() => callback(null));
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', {value: 'win32'});
    const controller = new AbortController();
    let settled = false;
    const running = new Sandbox(process.cwd()).execute('echo ready', controller.signal)
      .then(result => { settled = true; return result; });
    controller.abort();
    child.emit('close', 1);
    // Include the force-escalation timer, which must reuse the same request.
    await delay(650);
    assert.equal(settled, false, 'command returned before descendants were terminated');
    assert.equal(requests.length, 1);
    requests[0](null);
    const result = await running;
    assert.equal(result.exit_code, 1);
    assert.match(result.output, /Stopped:/);
  `;
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        timeout: 10000,
        stdio: 'pipe',
      },
    ),
  );
});
