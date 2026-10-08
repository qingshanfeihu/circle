import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  webFetch,
  webSearch,
  parseSearchHtml,
  blockedHost,
} from '../src/websearch.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { scratch, cleanup } from './helpers.js';
import type { Message } from '../src/types.js';
const reply = (
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({ id, role: 'assistant', content, tool_calls: calls });
test('web search parses DuckDuckGo result redirects, entity text and snippets with bounded results', () => {
  const html =
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Docs &amp; API</a><div class="result__snippet">A <b>useful</b> result.</div>';
  const result = parseSearchHtml(html, 'query', 1, 2026);
  assert.match(result, /Docs & API/);
  assert.match(result, /https:\/\/example.com\/docs/);
  assert.match(result, /A useful result/);
  assert.match(parseSearchHtml('', 'query'), /No results/);
});
test('web search uses fallback endpoint, honors cancellation and never invents results', async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return new Response('failed', { status: 503 });
    return new Response('<a href="https://example.com/docs">Documentation</a>');
  };
  const result = await webSearch(
    'typescript',
    new AbortController().signal,
    1,
    request,
  );
  assert.equal(urls.length, 2);
  assert.match(result, /Documentation/);
  const controller = new AbortController();
  controller.abort(new Error('Interrupted'));
  await assert.rejects(
    webSearch('query', controller.signal, 1, request),
    /Interrupted/,
  );
  assert.equal(urls.length, 2);
});
test('web fetch upgrades HTTP, preserves JSON and HTML formats, limits streamed bodies and rejects private redirects', async () => {
  let observed = '';
  const request: typeof fetch = async (input) => {
    observed = String(input);
    return new Response(
      '<html><script>bad</script><p>Hello &amp; world</p></html>',
      { headers: { 'content-type': 'text/html' } },
    );
  };
  const result = await webFetch(
    'http://example.com/doc',
    'text',
    new AbortController().signal,
    request,
  );
  assert.ok(observed.startsWith('https:'));
  assert.match(result, /Hello & world/);
  assert.ok(!result.includes('bad'));
  const html = await webFetch(
    'https://example.com/doc',
    'html',
    new AbortController().signal,
    request,
  );
  assert.match(html, /<html>/);
  const json = await webFetch(
    'https://example.com/data',
    'markdown',
    new AbortController().signal,
    async () =>
      new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json' },
      }),
  );
  assert.match(json, /"ok": true/);
  let calls = 0;
  await assert.rejects(
    webFetch(
      'https://example.com/doc',
      'text',
      new AbortController().signal,
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        });
      },
    ),
    /local\/private/,
  );
  assert.equal(calls, 1);
  for (const host of [
    'localhost',
    '127.0.0.2',
    '10.1.1.1',
    '192.168.2.1',
    '172.31.2.1',
    '[::1]',
  ])
    assert.equal(blockedHost(host), true);
  const large = await webFetch(
    'https://example.com/large',
    'text',
    new AbortController().signal,
    async () => new Response('x'.repeat(600000)),
  );
  assert.match(large, /truncated to 500000 bytes/);
  assert.ok(large.length < 501000);
});
test('read-only mode allows plan files and plan-only patches but blocks other effects and leaves the model an explicit boundary', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: reply('plan', '', [
        {
          id: 'plan-write',
          name: 'write_file',
          args: { file_path: '/plan.md', content: 'plan' },
        },
        {
          id: 'normal-write',
          name: 'write_file',
          args: { file_path: 'code.ts', content: 'bad' },
        },
        {
          id: 'mixed-patch',
          name: 'apply_patch',
          args: {
            patchText:
              '*** Begin Patch\n*** Add File: plan\n+ok\n*** Add File: code.ts\n+bad\n*** End Patch',
          },
        },
      ]),
    },
    { message: reply('done', 'planned') },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.setPlanMode(true);
  await runtime.harness.run('plan');
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), 'plan');
  assert.equal(existsSync(join(root, 'code.ts')), false);
  assert.equal(existsSync(join(root, 'plan')), false);
  assert.match(
    JSON.stringify(model.requests[0]!.messages),
    /Plan mode is now ON/,
  );
  assert.equal(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'normal-write',
    )!.status,
    'error',
  );
});
test('delete remains a forced headless approval, and leaving plan mode requires a real affirmative panel answer', async (t) => {
  const root = scratch(t);
  const path = join(root, 'keep.txt');
  writeFileSync(path, 'keep');
  const model = new ScriptedModel([
    {
      message: reply('delete', '', [
        { id: 'delete', name: 'delete', args: { file_path: path } },
      ]),
    },
    { message: reply('done', 'not deleted') },
    {
      message: reply('exit-plan', '', [
        { id: 'exit-plan', name: 'plan_exit', args: {} },
      ]),
    },
    { message: reply('still-plan', 'still planning') },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
    question: async () => JSON.stringify([[]]),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('delete');
  assert.equal(readFileSync(path, 'utf8'), 'keep');
  runtime.setPlanMode(true);
  await runtime.harness.run('finish plan');
  assert.equal(runtime.harness.planMode, true);
});
