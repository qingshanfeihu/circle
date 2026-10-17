import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceDebugService } from '../src/workspace/debug.ts';
import { patience } from './helpers/patience.mjs';

const nodeExecutable = process.env.CIRCLE_JS_DEBUG_NODE ?? process.execPath;
const adapterPath =
  process.env.CIRCLE_JS_DEBUG_ADAPTER ??
  fileURLToPath(
    new URL('../dist/tools/js-debug/src/dapDebugServer.js', import.meta.url),
  );
test(
  'Node project launch hits breakpoint, inspects locals, steps and stops',
  {
    timeout: patience(40000),
    skip:
      !existsSync(adapterPath) &&
      'set CIRCLE_JS_DEBUG_ADAPTER to the pinned standalone adapter',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-'));
    const file = path.join(root, 'fixture.cjs');
    await writeFile(
      file,
      'const value = 41;\nconst answer = value + 1;\nconsole.log(answer);\nsetInterval(()=>{},1000);\n',
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
    });
    try {
      await service.handle('setBreakpoints', { path: file, lines: [2] });
      await service.handle('launch', { program: file });
      const deadline = Date.now() + patience(15000);
      while (service.snapshot().status !== 'paused' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        service.snapshot().status,
        'paused',
        JSON.stringify(service.snapshot()),
      );
      const stack = await service.handle('stackTrace');
      assert.ok(stack.stackFrames.length > 0);
      const scopes = await service.handle('scopes', {
        frameId: stack.stackFrames[0].id,
      });
      const locals = await service.handle('variables', {
        variablesReference: scopes.scopes[0].variablesReference,
      });
      assert.ok(
        locals.variables.some(
          (v: any) => v.name === 'value' && v.value === '41',
        ),
      );
      await service.handle('next');
      await new Promise((r) => setTimeout(r, 100));
      await service.handle('continue');
      await new Promise((r) => setTimeout(r, 100));
      assert.match(service.snapshot().output, /42/);
      await service.handle('stop');
      assert.equal(service.snapshot().status, 'stopped');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('rejects sources outside workspace and malformed launches without spawning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-boundary-'));
  const outside = path.join(tmpdir(), `circle-outside-${Date.now()}.cjs`);
  await writeFile(outside, '');
  const service = new WorkspaceDebugService({
    workspaceRoot: root,
    nodeExecutable,
    runtimeExecutable: process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
    adapterPath: 'missing',
  });
  try {
    await assert.rejects(
      service.handle('setBreakpoints', { path: outside, lines: [1] }),
      /outside/,
    );
    await assert.rejects(service.handle('attach', { port: 0 }), /port/);
    await assert.rejects(
      service.handle('launch', { program: outside, args: [1] }),
      /outside/,
    );
    assert.equal(service.snapshot().status, 'idle');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside);
  }
});

test(
  'PTY callback launches owned debuggee and adapter stop kills it',
  {
    timeout: patience(15000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-terminal-'));
    const { spawn } = await import('node:child_process');
    let child: ReturnType<typeof spawn> | undefined;
    await writeFile(
      path.join(root, 'fixture.cjs'),
      'setInterval(()=>{},1000);\n',
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
      runInTerminal: async (args) => {
        const env = { ...process.env };
        for (const [key, value] of Object.entries(args.env ?? {})) {
          if (value === null) delete env[key];
          else env[key] = value;
        }
        child = spawn(args.args[0], args.args.slice(1), {
          cwd: args.cwd,
          env,
          stdio: 'ignore',
        });
        return { processId: child.pid! };
      },
    });
    try {
      await service.handle('launch', {
        program: 'fixture.cjs',
        stopOnEntry: true,
      });
      const until = Date.now() + patience(5000);
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'paused');
      assert.ok(child?.pid);
      await service.stop();
      const ended = Date.now() + 3000;
      while (
        child?.exitCode === null &&
        child?.signalCode === null &&
        Date.now() < ended
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        child?.exitCode !== null || child?.signalCode !== null,
        'debuggee must exit',
      );
    } finally {
      child?.kill();
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'attach pauses existing local process and detaches without killing owner',
  {
    timeout: patience(15000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-attach-'));
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--inspect=127.0.0.1:0', '-e', 'setInterval(()=>{},1000)'],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    // Register before any debugger operation: kill() only requests termination.
    // Windows retains the child's cwd until its actual process/stdio close.
    const childClosed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      child.stderr!.on('data', (chunk) => {
        output += chunk;
        const m = /127\.0\.0\.1:(\d+)/.exec(output);
        if (m) resolve(+m[1]);
      });
      child.once('error', reject);
    });
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
    });
    try {
      await service.handle('attach', { port });
      const until = Date.now() + patience(5000);
      let threads: any;
      do {
        threads = await service.handle('threads');
        if (!threads.threads.length)
          await new Promise((r) => setTimeout(r, 30));
      } while (!threads.threads.length && Date.now() < until);
      assert.ok(threads.threads.length);
      await service.handle('pause');
      // DAP acknowledges the request separately from the eventual stopped event.
      // Assert the real debugger effect, without assuming a 100ms scheduling window.
      const pausedDeadline = Date.now() + patience(5000);
      while (
        service.snapshot().status !== 'paused' &&
        Date.now() < pausedDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        service.snapshot().status,
        'paused',
        JSON.stringify(service.snapshot()),
      );
      await service.stop();
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
    } finally {
      child.kill();
      await childClosed;
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'TypeScript source maps bind original source breakpoint',
  {
    timeout: patience(15000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-sourcemap-'));
    const ts = await import('typescript');
    const source =
      'const value: number = 41;\nconst answer = value + 1;\nconsole.log(answer);\nsetInterval(()=>{},1000);\n';
    const compiled = ts.transpileModule(source, {
      fileName: 'fixture.ts',
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        sourceMap: true,
        inlineSources: true,
      },
    });
    await writeFile(path.join(root, 'fixture.ts'), source);
    await writeFile(path.join(root, 'fixture.js'), compiled.outputText);
    await writeFile(path.join(root, 'fixture.js.map'), compiled.sourceMapText!);
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
    });
    try {
      await service.handle('setBreakpoints', {
        path: 'fixture.ts',
        lines: [2],
      });
      await service.handle('launch', { program: 'fixture.js' });
      const until = Date.now() + patience(5000);
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'paused');
      const stack = await service.handle('stackTrace');
      assert.ok(stack.stackFrames[0].source.path.endsWith('fixture.ts'));
      assert.equal(stack.stackFrames[0].line, 2);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('DAP frames survive split headers and reject pending requests on close', async () => {
  const { createServer, connect } = await import('node:net');
  const { DapConnection } = await import('../src/workspace/debug.ts');
  const server = createServer((socket) =>
    socket.once('data', () => {
      const body = JSON.stringify({
        seq: 1,
        type: 'response',
        request_seq: 1,
        success: true,
        body: { threads: [{ id: 1, name: 'main' }] },
      });
      const response = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      socket.write(response.slice(0, 12));
      setTimeout(() => socket.write(response.slice(12)), 5);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const socket = connect(address.port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const connection = new DapConnection(socket);
  try {
    const reply = await connection.request('threads');
    assert.equal(reply.threads[0].name, 'main');
    const pending = connection.request('unanswered');
    connection.close();
    await assert.rejects(pending, /closed/);
  } finally {
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  'step in and out preserve project stack and evaluate paused locals',
  {
    timeout: patience(15000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-steps-'));
    await writeFile(
      path.join(root, 'fixture.cjs'),
      'function inner() {\n const local = 41;\n return local + 1;\n}\nfunction outer() {\n const result = inner();\n console.log(result);\n setInterval(()=>{},1000);\n}\nouter();\n',
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
    });
    const paused = async () => {
      const until = Date.now() + patience(5000);
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(service.snapshot().status, 'paused');
    };
    const step = async (method: string) => {
      await service.handle(method);
      await new Promise((r) => setTimeout(r, 50));
      await paused();
      return service.handle('stackTrace');
    };
    try {
      await service.handle('setBreakpoints', {
        path: 'fixture.cjs',
        lines: [6],
      });
      await service.handle('launch', { program: 'fixture.cjs' });
      await paused();
      const inside = await step('stepIn');
      assert.match(inside.stackFrames[0].name, /(?:^|\.)inner$/);
      await step('next');
      const stack = await service.handle('stackTrace');
      const evaluated = await service.handle('evaluate', {
        expression: 'local + 1',
        frameId: stack.stackFrames[0].id,
        context: 'repl',
      });
      assert.equal(evaluated.result, '42');
      const outside = await step('stepOut');
      assert.match(outside.stackFrames[0].name, /(?:^|\.)outer$/);
      await service.handle('continue');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('adapter launch rejection cleans up and leaves a recoverable failed state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-rejected-'));
  const adapter = path.join(root, 'adapter.cjs');
  await writeFile(path.join(root, 'fixture.cjs'), '');
  await writeFile(
    adapter,
    `const net=require('net');const server=net.createServer(s=>{let buffer=Buffer.alloc(0);let seq=0;const send=m=>{const b=JSON.stringify({seq:++seq,...m});s.write('Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b)};s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){let end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;let len=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+len)return;let m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);send({type:'response',request_seq:m.seq,command:m.command,success:m.command!=='launch',message:m.command==='launch'?'fixture launch rejected':undefined,body:{}});if(m.command==='initialize')send({type:'event',event:'initialized',body:{}});}})}).listen(0,'127.0.0.1',()=>console.log('Debug server listening at 127.0.0.1:'+server.address().port));`,
  );
  const service = new WorkspaceDebugService({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    adapterPath: adapter,
  });
  try {
    await assert.rejects(
      service.handle('launch', { program: 'fixture.cjs' }),
      /fixture launch rejected/,
    );
    assert.equal(service.snapshot().status, 'failed');
    assert.equal(service.snapshot().adapterPid, undefined);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'initialized coalesced with initialize response cannot deadlock launch configuration',
  { timeout: patience(5000) },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'circle-debug-initialized-'),
    );
    const adapter = path.join(root, 'adapter.cjs');
    await writeFile(path.join(root, 'fixture.cjs'), '');
    await writeFile(
      adapter,
      `const net=require('net');net.createServer(s=>{let buffer=Buffer.alloc(0),seq=0,launch;const frame=m=>{const b=JSON.stringify({seq:++seq,...m});return 'Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b};const reply=m=>frame({type:'response',request_seq:m.seq,command:m.command,success:true,body:{}});s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const len=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+len)return;const m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);if(m.command==='initialize')s.write(reply(m)+frame({type:'event',event:'initialized',body:{}}));else if(m.command==='launch')launch=m;else if(m.command==='configurationDone'){s.write(reply(m));s.write(reply(launch));}else s.write(reply(m));}})}).listen(0,'127.0.0.1',function(){console.log('Debug server listening at 127.0.0.1:'+this.address().port)});`,
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath: adapter,
    });
    try {
      const launched = await Promise.race([
        service.handle('launch', { program: 'fixture.cjs' }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error('initialize event was lost')),
            1000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(launched.status, 'running');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'launch arguments stay literal and entry pause is explicitly opt-in',
  {
    timeout: patience(30000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-arguments-'));
    const { spawn } = await import('node:child_process');
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
      runInTerminal: async (request) => {
        const env = { ...process.env };
        for (const [key, value] of Object.entries(request.env ?? {})) {
          if (value === null) delete env[key];
          else env[key] = value;
        }
        child = spawn(request.args[0], request.args.slice(1), {
          cwd: request.cwd,
          env,
        });
        child.stdout?.on('data', (chunk) => {
          output += String(chunk);
        });
        return { processId: child.pid! };
      },
    });
    try {
      await writeFile(
        path.join(root, 'args.cjs'),
        'console.log(JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000);\n',
      );
      const args = ['two words', '"quoted"', '', '$(touch should-not-exist)'];
      await service.handle('launch', {
        program: 'args.cjs',
        args,
        stopOnEntry: true,
      });
      const until = Date.now() + patience(10000);
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'paused');
      assert.equal(output.includes(JSON.stringify(args)), false);
      await service.handle('continue');
      while (!output.includes(JSON.stringify(args)) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(output.includes(JSON.stringify(args)), output);
      assert.equal(existsSync(path.join(root, 'should-not-exist')), false);
      await service.stop();
      const fallback = new WorkspaceDebugService({
        workspaceRoot: root,
        nodeExecutable,
        runtimeExecutable:
          process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
        adapterPath,
      });
      try {
        await fallback.handle('launch', { program: 'args.cjs', args });
        const deadline = Date.now() + patience(10000);
        while (
          !fallback.snapshot().output.includes(JSON.stringify(args)) &&
          Date.now() < deadline
        )
          await new Promise((r) => setTimeout(r, 20));
        assert.ok(
          fallback.snapshot().output.includes(JSON.stringify(args)),
          fallback.snapshot().output,
        );
      } finally {
        await fallback.dispose();
      }
    } finally {
      await service.dispose();
      child?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a breakpoint configured after natural termination keeps its requested position on the next launch',
  {
    timeout: patience(30000),
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-relaunch-'));
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable,
      runtimeExecutable:
        process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath,
      adapterPath,
    });
    try {
      await writeFile(
        path.join(root, 'first.cjs'),
        'console.log("FIRST_COMPLETED");\n',
      );
      await writeFile(
        path.join(root, 'second.cjs'),
        'const value=41;\nconsole.log(value+1);\nsetInterval(()=>{},1000);\n',
      );
      await service.handle('launch', { program: 'first.cjs' });
      let deadline = Date.now() + patience(10000);
      while (service.snapshot().status !== 'stopped' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'stopped');
      const configured = await service.handle('setBreakpoints', {
        path: 'second.cjs',
        lines: [2],
        columns: [1],
      });
      assert.equal(configured.breakpoints[0].requestedLine, 2);
      assert.equal(configured.breakpoints[0].requestedColumn, 1);
      assert.equal(
        configured.breakpoints[0].line,
        2,
        'unbound adapter reply must not erase the requested line',
      );
      assert.ok(configured.breakpoints[0].source.path.endsWith('second.cjs'));
      await service.handle('launch', { program: 'second.cjs' });
      deadline = Date.now() + patience(10000);
      while (service.snapshot().status !== 'paused' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        service.snapshot().status,
        'paused',
        JSON.stringify(service.snapshot()),
      );
      const stack = await service.handle('stackTrace');
      assert.equal(stack.stackFrames[0].line, 2);
      assert.ok(stack.stackFrames[0].source.path.endsWith('second.cjs'));
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'old persisted DAP output cannot overwrite a restarted debug generation',
  { timeout: patience(5000) },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'circle-debug-output-generation-'),
    );
    const adapter = path.join(root, 'adapter.cjs');
    const source = `const net=require('net');net.createServer(s=>{let buffer=Buffer.alloc(0),seq=0,launch;const frame=m=>{const b=JSON.stringify({seq:++seq,...m});return 'Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b};const reply=m=>frame({type:'response',request_seq:m.seq,command:m.command,success:true,body:{}});s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const len=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+len)return;const m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);if(m.command==='initialize')s.write(reply(m)+frame({type:'event',event:'initialized',body:{}}));else if(m.command==='launch')launch=m;else if(m.command==='configurationDone'){s.write(reply(m));s.write(reply(launch));}else s.write(reply(m));}})}).listen(0,'127.0.0.1',function(){console.log('Debug server listening at 127.0.0.1:'+this.address().port)});`;
    await writeFile(
      adapter,
      source.replace(
        's.write(reply(launch));',
        's.write(reply(launch));s.write(frame({type:"event",event:"output",body:{output:"OLD_OUTPUT"}}));',
      ),
    );
    await writeFile(path.join(root, 'fixture.cjs'), '');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const writing = new Promise<void>((resolve) => (entered = resolve));
    const persisted: string[] = [];
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath: adapter,
      output: async (text) => {
        entered();
        await held;
        persisted.push(text);
      },
    });
    try {
      await service.handle('launch', { program: 'fixture.cjs' });
      await writing;
      await service.stop();
      await writeFile(adapter, source);
      await service.handle('launch', { program: 'fixture.cjs' });
      assert.equal(service.snapshot().status, 'running');
      release();
      await service.flushOutput();
      assert.deepEqual(persisted, ['OLD_OUTPUT']);
      assert.equal(service.snapshot().output, '');
      assert.equal(service.snapshot().status, 'running');
    } finally {
      release();
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('adding a breakpoint keeps the file’s others, whatever spelling of the path is used', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-add-'));
  const file = path.join(root, 'fixture.cjs');
  await writeFile(file, 'a;\nb;\nc;\nd;\n');
  const service = new WorkspaceDebugService({
    workspaceRoot: root,
    nodeExecutable,
    runtimeExecutable: process.execPath,
    adapterPath,
  });
  try {
    await service.handle('setBreakpoints', { path: file, lines: [1] });
    // The editor sends a workspace-relative path; the state is keyed by the resolved one.
    await service.handle('setBreakpoints', {
      path: 'fixture.cjs',
      lines: [3],
      add: true,
    });
    await service.handle('setBreakpoints', {
      path: 'fixture.cjs',
      lines: [3],
      add: true,
    });
    const stored = Object.values(service.snapshot().breakpoints);
    assert.equal(stored.length, 1);
    assert.deepEqual(
      stored[0]!.map((b: { requestedLine: number }) => b.requestedLine),
      [1, 3],
    );
    // Without `add` the request is still the file's whole set, as the remove button needs.
    await service.handle('setBreakpoints', { path: file, lines: [3] });
    assert.deepEqual(
      Object.values(service.snapshot().breakpoints)[0]!.map(
        (b: { requestedLine: number }) => b.requestedLine,
      ),
      [3],
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'an adapter that writes a lot to stdout and stderr after listening does not stall',
  { timeout: patience(10000) },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-chatty-'));
    const adapter = path.join(root, 'adapter.cjs');
    await writeFile(path.join(root, 'fixture.cjs'), '');
    // Blocking writes: a pipe nobody reads would stop this adapter from replying.
    await writeFile(
      adapter,
      `const fs=require('fs');const flood=fd=>{const b=Buffer.alloc(1<<20,101);let o=0;while(o<b.length){try{o+=fs.writeSync(fd,b,o)}catch(e){if(e.code!=='EAGAIN')throw e}}};const net=require('net');net.createServer(s=>{let buffer=Buffer.alloc(0),seq=0,launch;const frame=m=>{const b=JSON.stringify({seq:++seq,...m});return 'Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b};const reply=m=>frame({type:'response',request_seq:m.seq,command:m.command,success:true,body:{}});s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const len=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+len)return;const m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);if(m.command==='initialize'){flood(2);flood(1);s.write(reply(m)+frame({type:'event',event:'initialized',body:{}}));}else if(m.command==='launch')launch=m;else if(m.command==='configurationDone'){s.write(reply(m));s.write(reply(launch));}else s.write(reply(m));}})}).listen(0,'127.0.0.1',function(){console.log('Debug server listening at 127.0.0.1:'+this.address().port)});`,
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath: adapter,
    });
    try {
      const launched = await Promise.race([
        service.handle('launch', { program: 'fixture.cjs' }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error('adapter stalled on a full pipe')),
            5000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(launched.status, 'running');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
