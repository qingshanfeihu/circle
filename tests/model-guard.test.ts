import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ModelGuard,
  BUDGETS,
  errorKind,
  retryAfterMs,
  backoffMs,
} from '../src/model_guard.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { RepetitionMonitor } from '../src/text_repetition.js';
import type { ModelRequest, ModelResponse, ModelNotice } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
const answer = (content: string): ModelResponse => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
});
const request = (): ModelRequest => ({
  system: 'system',
  messages: [{ id: 'user', role: 'user', content: 'hello' }],
  tools: [],
  signal: new AbortController().signal,
  token: () => {},
});
const error = (
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): Error => Object.assign(new Error(message), { status, ...extra });
function chunk(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string | null = null,
): void {
  response.write(
    'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      '\n\n',
  );
}
async function gateway(
  t: Parameters<typeof scratch>[0],
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const data of request) body += data;
    handler(request, response, body ? JSON.parse(body) : {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1`;
}
function model(
  t: Parameters<typeof scratch>[0],
  base: string,
  wait?: (ms: number, signal: AbortSignal) => Promise<void>,
  stallMs?: number,
): GatewayModel {
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth.base_url = base;
  settings.auth.model = 'test-model';
  settings.default_thinking = 'high';
  saveCredentials({ api_key: 'fake-key' }, home);
  return new GatewayModel(settings, home, undefined, { wait, stallMs });
}
test('retry classification separates budgets and never retries exhausted quota or unrelated client errors', () => {
  assert.equal(errorKind(error(429, 'rate limit')), 'rate_limit');
  assert.equal(errorKind(error(503, 'busy')), 'server');
  assert.equal(
    errorKind(Object.assign(new Error('network'), { code: 'ECONNRESET' })),
    'network',
  );
  for (const failure of [
    error(402, 'quota'),
    error(429, 'quota', { error: { code: 'insufficient_quota' } }),
    error(401, 'key'),
    error(400, 'context too large'),
  ])
    assert.equal(errorKind(failure), undefined);
  assert.equal(
    retryAfterMs(
      error(429, 'slow', {
        headers: new Headers({ 'retry-after-ms': '7000' }),
      }),
    ),
    7000,
  );
  assert.equal(retryAfterMs(error(429, 'try again in 2 minutes')), 120000);
  assert.equal(backoffMs('network', 2), 12000);
});
test('independent retry budgets, endpoint hints and no retry after streaming output', async () => {
  const notices: ModelNotice[] = [];
  const waits: number[] = [];
  const guard = new ModelGuard(() => false, {
    wait: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5,
  });
  const input = request();
  input.notice = (event) => notices.push(event);
  let call = 0;
  const result = await guard.execute(input, async () => {
    if (call++ === 0)
      throw error(429, 'limited', {
        headers: new Headers({ 'retry-after': '7' }),
      });
    if (call === 2) throw error(503, 'server');
    return answer('done');
  });
  assert.equal(result.message.content, 'done');
  assert.deepEqual(waits, [7000, 2000]);
  assert.deepEqual(
    notices.map((event) => event.kind),
    ['rate_limit', 'server'],
  );
  let attempts = 0;
  await assert.rejects(
    guard.execute(request(), async (input) => {
      attempts++;
      input.token('partial');
      throw error(503, 'failure after output');
    }),
    /after output/,
  );
  assert.equal(attempts, 1);
  const network = new ModelGuard(() => false, { wait: async () => {} });
  let failures = 0;
  await assert.rejects(
    network.execute(request(), async () => {
      failures++;
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    }),
  );
  assert.equal(failures, BUDGETS.network.maxRetries + 1);
});
test('real SDK retries, drops only rejected parameters and retains the downgrade on later calls', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    if (bodies.length === 1) {
      response
        .writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after-ms': '100',
        })
        .end(
          JSON.stringify({
            error: { message: 'limited', type: 'rate_limit_error' },
          }),
        );
      return;
    }
    if (body.reasoning_effort) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: {
            message:
              'Unsupported value: the reasoning_effort parameter is invalid',
            param: 'reasoning_effort',
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'done' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  const waits: number[] = [];
  const instance = model(t, base, async (ms) => {
    waits.push(ms);
  });
  await instance.complete(request());
  await instance.complete(request());
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0]!.reasoning_effort, 'high');
  assert.ok(!('reasoning_effort' in bodies[2]!));
  assert.ok(!('reasoning_effort' in bodies[3]!));
  assert.equal(
    instance.downgrades.reasoning_effort,
    'rejected by the endpoint (400)',
  );
  assert.deepEqual(waits, [100]);
});
test('cancellation interrupts an actual Retry-After wait and never sends the queued retry', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    response
      .writeHead(429, {
        'Content-Type': 'application/json',
        'retry-after': '60',
      })
      .end(
        JSON.stringify({
          error: { message: 'limited', type: 'rate_limit_error' },
        }),
      );
  });
  const instance = model(t, base);
  const controller = new AbortController();
  const input = request();
  input.signal = controller.signal;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  input.notice = (event) => {
    if (event.event === 'retry') entered();
  };
  const running = instance.complete(input);
  const rejected = assert.rejects(running, /abort|Interrupted/i);
  await ready;
  controller.abort(new Error('Interrupted'));
  await rejected;
  await delay(20);
  assert.equal(calls, 1);
});
test('keepalive-only stream is terminated at a real deadline and resent once, while partial text prevents a resend', async (t) => {
  let calls = 0;
  const base = await gateway(t, (request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 2) {
      chunk(response, { content: 'recovered' }, 'stop');
      response.end('data: [DONE]\n\n');
      return;
    }
    chunk(response, {});
    const interval = setInterval(() => chunk(response, {}), 10);
    response.on('close', () => clearInterval(interval));
  });
  const instance = model(t, base, undefined, 50);
  assert.equal(
    (await instance.complete(request())).message.content,
    'recovered',
  );
  assert.equal(calls, 2);
  let partialCalls = 0;
  const partialBase = await gateway(t, (_request, response) => {
    partialCalls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'already output' });
  });
  const partial = model(t, partialBase, undefined, 50);
  await assert.rejects(partial.complete(request()), /stalled/);
  assert.equal(partialCalls, 1);
});
test('empty missing-finish stream is retried once; partial output is retained and marked truncated', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) chunk(response, {});
    else chunk(response, { content: 'done' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  assert.equal(
    (await model(t, base).complete(request())).message.content,
    'done',
  );
  assert.equal(calls, 2);
  let partialCalls = 0;
  const partialBase = await gateway(t, (_request, response) => {
    partialCalls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'partial' });
    response.end('data: [DONE]\n\n');
  });
  const result = await model(t, partialBase).complete(request());
  assert.equal(result.message.content, 'partial');
  assert.equal(result.message.truncated, true);
  assert.equal(partialCalls, 1);
});
test('thinking repetition receives a bounded recovery reminder and varied text is left alone', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (bodies.length === 1)
      chunk(response, {
        reasoning_content: 'one two three four five six seven eight '.repeat(
          40,
        ),
      });
    else chunk(response, { content: 'changed approach' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  const result = await model(t, base).complete(request());
  assert.equal(result.message.content, 'changed approach');
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1]!.messages), /different approach/);
  const monitor = new RepetitionMonitor();
  assert.equal(
    monitor.feed(
      Array.from({ length: 800 }, (_, index) => 'unique' + index).join(' ') +
        ' ',
    ),
    undefined,
  );
});
test('stream stall deadline starts after connection and does not replay a slow successful handshake', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(response, { content: 'one response' }, 'stop');
      response.end('data: [DONE]\n\n');
    }, 120);
  });
  const result = await model(t, base, undefined, 20).complete(request());
  assert.equal(result.message.content, 'one response');
  assert.equal(calls, 1);
});
