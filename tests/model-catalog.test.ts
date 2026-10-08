import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ModelCatalog,
  slimCatalog,
  validCatalog,
  windowOverrides,
  CATALOG_SCHEMA,
} from '../src/model_catalog.js';
import {
  defaultSettings,
  loadSettingsFromDict,
  saveCredentials,
} from '../src/settings.js';
import { GatewayModel } from '../src/model.js';
import { modelProfile, fitEffort } from '../src/model_profiles.js';
import { priceCall, UsageCostTotals, formatCosts } from '../src/pricing.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { ExtensionHost } from '../src/extensions.js';
import { scratch, cleanup } from './helpers.js';
const RAW = {
  zhipuai: {
    api: 'https://open.bigmodel.cn/api/paas/v4',
    models: {
      'glm-5.3': {
        limit: { context: 1_000_000, output: 131_072 },
        cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      },
    },
  },
  'zhipuai-coding-plan': {
    api: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: {
      'glm-5.3': { limit: { context: 900_000 }, cost: { input: 0, output: 0 } },
    },
  },
  'alibaba-cn': {
    api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: {
      qwen: {
        limit: { context: 1_000_000 },
        cost: { input: 0.12, output: 0.4 },
      },
    },
  },
  'alibaba-token-plan-cn': {
    api: 'https://token-plan.cn-beijing.maas.aliyuncs.com/v1',
    models: {
      qwen: { limit: { context: 800_000 }, cost: { input: 0, output: 0 } },
    },
  },
  'tencent-coding-plan': {
    api: 'https://api.lkeap.cloud.tencent.com/v1',
    models: {
      'hy-2': { limit: { context: 256_000 }, cost: { input: 0, output: 0 } },
    },
  },
  lmstudio: {
    api: 'http://127.0.0.1:1234/v1',
    models: {
      'local-7b': { limit: { context: 32_768 }, cost: { input: 0, output: 0 } },
    },
  },
  anthropic: {
    models: {
      'claude-sonnet-5': {
        limit: { context: 1_000_000, output: 128_000 },
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          cache_write: 2.5,
          context_over_200k: { input: 4, output: 15 },
        },
      },
    },
  },
};
function settings(url = '', protocol = 'openai') {
  const settings = defaultSettings();
  settings.auth.base_url = url;
  settings.auth.protocol = protocol;
  return settings;
}
test('catalog normalization preserves limits, cache prices and tiers and rejects corrupted nested data', () => {
  const data = slimCatalog({
    ...RAW,
    broken: 'invalid',
    empty: { models: { m: {} } },
    malformed: {
      models: {
        m: {
          limit: { context: true, output: -1 },
          cost: { input: NaN, output: '4' },
        },
      },
    },
  });
  assert.equal(validCatalog(data), true);
  assert.equal(
    data.providers.anthropic!.models['claude-sonnet-5']!.cost!
      .context_over_200k!.output,
    15,
  );
  assert.equal(data.providers.malformed, undefined);
  for (const invalid of [
    null,
    { schema: CATALOG_SCHEMA, providers: { x: { api: '', models: ['bad'] } } },
    {
      schema: CATALOG_SCHEMA,
      providers: { x: { api: '', models: { m: { cost: { input: NaN } } } } },
    },
  ])
    assert.equal(validCatalog(invalid), false);
});
test('the actual endpoint host selects paid and subscription entries, with no invented free subscription price', (t) => {
  const catalog = new ModelCatalog(scratch(t), {
    data: slimCatalog(RAW),
    env: {},
  });
  for (const [url, protocol, name, window, provider, priceProvider] of [
    [
      'https://open.bigmodel.cn/api/anthropic',
      'anthropic',
      'glm-5.3',
      1_000_000,
      'zhipuai',
      'zhipuai',
    ],
    [
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      'anthropic',
      'qwen',
      800_000,
      'alibaba-token-plan-cn',
      'alibaba-cn',
    ],
    ['', 'anthropic', 'claude-sonnet-5', 1_000_000, 'anthropic', 'anthropic'],
    [
      'http://127.0.0.1:1234/v1',
      'openai',
      'local-7b',
      32_768,
      'lmstudio',
      'lmstudio',
    ],
  ] as const) {
    const facts = catalog.facts(name, settings(url, protocol));
    assert.equal(facts.contextWindow, window);
    assert.equal(facts.provider, provider);
    assert.equal(facts.priceProvider, priceProvider);
    assert.equal(facts.windowKnown, true);
  }
  assert.equal(
    catalog.facts('hy-2', settings('https://api.lkeap.cloud.tencent.com/v1'))
      .rates,
    undefined,
  );
});
test('gateway aliases use vendor metadata; account overrides win over the environment and cached results stay immutable', (t) => {
  const catalog = new ModelCatalog(scratch(t), {
    data: slimCatalog(RAW),
    env: { CIRCLE_MODEL_CTX: '64_000' },
  });
  const configured = settings('https://gateway.example/v1');
  const first = catalog.facts('vendor/GLM-5.3', configured);
  assert.equal(first.contextWindow, 64_000);
  assert.equal(first.provider, 'zhipuai');
  first.rates!.input = 999;
  assert.equal(catalog.facts('vendor/GLM-5.3', configured).rates!.input, 1.4);
  configured.models = { 'vendor/GLM-5.3': { context_window: 500_000 } };
  assert.equal(
    catalog.facts('vendor/GLM-5.3', configured).contextWindow,
    500_000,
  );
  assert.deepEqual(
    windowOverrides({
      a: { context_window: 9 },
      b: { context_window: '9' },
      c: { context_window: true },
      d: { context_window: 0 },
    }),
    { a: 9 },
  );
  assert.deepEqual(
    loadSettingsFromDict({
      models: { good: { context_window: 4096 }, bad: 'x' },
    }).models,
    { good: { context_window: 4096 } },
  );
});
test('Kimi subscriptions use a paid twin only when that exact model is known', (t) => {
  const catalog = new ModelCatalog(scratch(t), {
    data: slimCatalog({
      'kimi-code-plan-cn': {
        api: 'https://api.kimi.com/coding/v1',
        models: {
          k3: { limit: { context: 1_048_576 }, cost: { input: 0, output: 0 } },
          'kimi-for-coding': {
            limit: { context: 262_144 },
            cost: { input: 0, output: 0 },
          },
        },
      },
      'moonshotai-cn': {
        models: {
          'kimi-k3': {
            limit: { context: 1_048_576 },
            cost: { input: 0.95, output: 4 },
          },
        },
      },
    }),
    env: {},
  });
  const endpoint = settings('https://api.kimi.com/coding/v1');
  assert.equal(catalog.facts('k3', endpoint).priceProvider, 'moonshotai-cn');
  assert.equal(catalog.facts('kimi-for-coding', endpoint).rates, undefined);
});
test('offline snapshots work without network; an invalid fresh cache does not suppress repair', async (t) => {
  const root = scratch(t);
  const snapshot = new ModelCatalog(root, { env: {} });
  assert.equal(snapshot.source, 'snapshot');
  assert.equal(
    snapshot.facts('completely-unknown', settings()).windowKnown,
    false,
  );
  assert.equal(
    snapshot.facts('completely-unknown', settings()).contextWindow,
    128_000,
  );
  assert.equal(
    snapshot.facts('not-in-catalog', settings(), 200_000).windowSource,
    'profile',
  );
  mkdirSync(join(root, 'cache'));
  writeFileSync(
    join(root, 'cache', 'models-dev.json'),
    '{"schema":"circle.models-dev/v1","providers":{"x":{"api":"","models":["bad"]}}}',
  );
  const repaired = new ModelCatalog(root, {
    env: {},
    request: async () => Response.json(RAW),
  });
  assert.equal(repaired.source, 'snapshot');
  assert.equal(await repaired.refreshIfStale(), true);
  assert.equal(new ModelCatalog(root).source, 'cache');
});
test('refresh is single-flight, writes a private atomic cache, honors freshness, and preserves data on failures', async (t) => {
  const root = scratch(t);
  let calls = 0;
  const catalog = new ModelCatalog(root, {
    data: slimCatalog(RAW),
    env: {},
    request: async () => {
      calls++;
      await delay(10);
      return Response.json(RAW);
    },
  });
  const a = catalog.refresh();
  const b = catalog.refresh();
  assert.equal(a, b);
  assert.equal(await a, true);
  assert.equal(calls, 1);
  assert.equal(catalog.refreshIfStale(), undefined);
  const bytes = readFileSync(catalog.cachePath);
  const failed = new ModelCatalog(root, {
    env: {},
    request: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(await failed.refresh(), false);
  assert.deepEqual(readFileSync(failed.cachePath), bytes);
  const stale = new Date(Date.now() - 90_000_000);
  utimesSync(catalog.cachePath, stale, stale);
  assert.equal(await catalog.refreshIfStale(), true);
  assert.equal(calls, 2);
  const disabled = new ModelCatalog(root, {
    env: { CIRCLE_NO_MODELS_REFRESH: '1' },
  });
  assert.equal(disabled.refreshIfStale(undefined, 0), undefined);
});
test('cancelling a partially received catalog stops its body and never replaces valid cached metadata', async (t) => {
  const root = scratch(t);
  let bodyStopped = false;
  const catalog = new ModelCatalog(root, {
    data: slimCatalog(RAW),
    env: {},
    request: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel() {
            bodyStopped = true;
          },
        }),
      ),
  });
  const refresh = catalog.refresh();
  await delay(10);
  await catalog.close();
  assert.equal(await refresh, false);
  assert.equal(bodyStopped, true);
  assert.equal(existsSync(catalog.cachePath), false);
  assert.equal(catalog.facts('glm-5.3', settings()).contextWindow, 1_000_000);
});
test('per-call prices freeze cache writes and long-context rates, preserve multiple currencies and disclose unknown calls', (t) => {
  const catalog = new ModelCatalog(scratch(t), {
    data: slimCatalog(RAW),
    env: {},
  });
  const receipt = priceCall(
    catalog.facts(
      'glm-5.3',
      settings('https://open.bigmodel.cn/api/anthropic'),
    ),
    {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 400_000,
      cache_write_tokens: 100_000,
    },
  );
  assert.ok(
    Math.abs(receipt.amount! - (0.5 * 1.4 + 0.4 * 0.26 + 0.1 * 1.4 + 4.4)) <
      1e-9,
  );
  const long = priceCall(
    catalog.facts('claude-sonnet-5', settings('', 'anthropic')),
    { input_tokens: 300_000, output_tokens: 1000, cache_read_tokens: 0 },
  );
  assert.ok(Math.abs(long.amount! - 1.215) < 1e-9);
  const total = new UsageCostTotals();
  total.add(receipt);
  total.add({ currency: 'RMB', amount: 2 });
  total.add({ amount: NaN, currency: 'USD' });
  assert.match(formatCosts([total.snapshot()]), /\$.* \+ ¥2.0000\+$/);
  assert.equal(
    formatCosts([{ amounts: {}, calls: 1, unpriced_calls: 1 }]),
    'N/A',
  );
  assert.equal(
    priceCall(catalog.facts('missing', settings()), {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
    }).amount,
    null,
  );
});
test('provider profiles are data only, preserve known-model windows and fit supported reasoning levels', () => {
  assert.ok(
    modelProfile('anthropic', 'vendor/claude-sonnet-4-5')!.max_input_tokens! >
      128_000,
  );
  assert.equal(modelProfile('anthropic', 'unknown'), undefined);
  assert.equal(fitEffort('minimal', ['low', 'medium', 'high']), 'low');
  assert.equal(fitEffort('xhigh', ['low', 'medium', 'high']), 'high');
});
test('real Anthropic requests fit legacy thinking and output budgets and include all input token categories', async (t) => {
  const root = scratch(t);
  const bodies: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [event, data] of [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'message',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [],
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 5,
              cache_creation: {
                ephemeral_1h_input_tokens: 2,
                ephemeral_5m_input_tokens: 3,
              },
            },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'answer' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const endpoint = settings(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    'anthropic',
  );
  endpoint.auth.model = 'claude-sonnet-4-5';
  endpoint.models = { 'claude-sonnet-4-5': { context_window: 20_000 } };
  saveCredentials({ api_key: 'fake-catalog-key' }, root);
  const catalog = new ModelCatalog(root, { data: slimCatalog(RAW), env: {} });
  const model = new GatewayModel(endpoint, root, undefined, {}, catalog);
  const result = await model.complete({
    system: 'system',
    messages: [{ id: 'user', role: 'user', content: 'question' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  assert.equal(bodies[0]!.max_tokens, 5000);
  assert.deepEqual(bodies[0]!.thinking, {
    type: 'enabled',
    budget_tokens: 2500,
  });
  assert.equal(bodies[0]!.output_config, undefined);
  assert.deepEqual(result.usage, {
    input_tokens: 35,
    output_tokens: 3,
    cache_read_tokens: 20,
    cache_write_tokens: 5,
    cache_write_1h_tokens: 2,
  });
  endpoint.models = {};
  assert.equal(
    model.contextWindow,
    modelProfile('anthropic', model.model)!.max_input_tokens,
  );
  assert.equal(model.outputBudget, 24_192);
  const wrapper = new ExtensionHost({
    workspace: root,
    home: root,
    trusted: false,
  }).model(model);
  endpoint.models = { 'claude-sonnet-4-5': { context_window: 40_000 } };
  assert.equal(wrapper.contextWindow, 40_000);
  assert.equal(wrapper.outputBudget, 10_000);
  const modern = new GatewayModel(
    endpoint,
    root,
    'claude-fable-5',
    {},
    catalog,
  );
  modern.effort = 'minimal';
  await modern.complete({
    system: 'system',
    messages: [{ id: 'user', role: 'user', content: 'question' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  assert.equal(bodies[1]!.max_tokens, 32000);
  assert.deepEqual(bodies[1]!.thinking, { type: 'adaptive' });
  assert.deepEqual(bodies[1]!.output_config, { effort: 'low' });
});
test('saved prices and model identity survive catalog changes and restart instead of repricing previous calls', async (t) => {
  const root = scratch(t);
  const endpoint = settings();
  endpoint.auth.model = 'glm-5.3';
  const updated = structuredClone(RAW);
  updated.zhipuai.models['glm-5.3'].cost.input = 2.8;
  const catalog = new ModelCatalog(root, {
    data: slimCatalog(RAW),
    env: {},
    request: async () => Response.json(updated),
  });
  const model = new ScriptedModel([
    {
      message: { id: 'first', role: 'assistant', content: 'one' },
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_tokens: 0 },
    },
    {
      message: { id: 'second', role: 'assistant', content: 'two' },
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_tokens: 0 },
    },
  ]);
  model.model = 'glm-5.3';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model,
    catalog,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('first');
  const first = structuredClone(runtime.harness.messages.at(-1)!.cost);
  await catalog.refresh();
  await runtime.harness.run('second');
  assert.deepEqual(
    runtime.harness.messages.find((message) => message.id === 'first')!.cost,
    first,
  );
  const prices = runtime.harness.messages
    .filter((message) => message.cost)
    .map((message) => message.cost!.amount!);
  assert.ok(prices[1]! > prices[0]!);
  const totals = runtime.stats().costs;
  const id = runtime.session.id;
  await runtime.close();
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => resumed.close());
  assert.deepEqual(resumed.stats().costs, totals);
});
test('native subagent usage and price receipts remain part of the owning conversation exactly once after restart', async (t) => {
  const root = scratch(t);
  const endpoint = settings();
  endpoint.auth.model = 'priced';
  const catalog = new ModelCatalog(root, {
    data: slimCatalog({
      own: {
        models: {
          priced: { limit: { context: 10000 }, cost: { input: 1, output: 2 } },
        },
      },
    }),
    env: {},
  });
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 };
  const model = new ScriptedModel([
    {
      message: {
        id: 'main-start',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'task', name: 'task', args: { description: 'research' } },
        ],
      },
      usage,
    },
    { message: { id: 'child', role: 'assistant', content: 'report' }, usage },
    {
      message: { id: 'main-end', role: 'assistant', content: 'complete' },
      usage,
    },
  ]);
  model.model = 'priced';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model,
    catalog,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('research');
  const stats = runtime.stats();
  assert.equal(stats.usage.input_tokens, 300);
  assert.equal(stats.costs.calls, 3);
  assert.ok(Math.abs(stats.costs.amounts.USD! - 0.00036) < 1e-12);
  const id = runtime.session.id;
  await runtime.close();
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => resumed.close());
  assert.deepEqual(resumed.stats().usage, stats.usage);
  assert.deepEqual(resumed.stats().costs, stats.costs);
});
