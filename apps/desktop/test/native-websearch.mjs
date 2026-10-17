// Real sandboxed Electron → preload → worker → synthetic model/search gateways.
// The proxy permits only the fixtures below, so this never reaches a model or search service.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { tlsCertificates } from '../../../tests/tls-certificates.mjs';
import { patience } from './helpers/patience.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-websearch-'));
const output = resolve(
  root,
  '../../outputs/native-websearch',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
for (const name of ['receipt.json', 'failure.json'])
  await rm(join(output, name), { force: true });
const gateways = [];
const connections = new Set();
const requests = [];
const tunnels = [];
const errors = [];
const checks = [];
const results = new Map();
const caFiles = [];
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
const workspace = join(temp, 'workspace');
const nativeUrl = 'https://synthetic.example/native-source';
const fallbackUrl = 'https://synthetic.example/fallback-source';
let cancelStarted = false;
let cancelClosed = false;
let app;
let page;
let proxy;
const chat = (res, delta, finishReason = 'stop') => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
  );
};
try {
  for (const host of [
    'search.circle.test',
    'lite.duckduckgo.com',
    'html.duckduckgo.com',
  ]) {
    const folder = join(temp, host);
    await mkdir(folder);
    const chain = tlsCertificates(folder, host);
    caFiles.push(chain.ca);
    const server = httpsServer(
      { key: chain.key, cert: chain.cert },
      async (req, res) => {
        try {
          const bytes = Buffer.concat(await Array.fromAsync(req)).toString();
          const body = bytes ? JSON.parse(bytes) : undefined;
          requests.push({ host, path: req.url, body });
          if (host !== 'search.circle.test') {
            assert.equal(req.headers.authorization, undefined);
            assert.equal(
              new URL(req.url, `https://${host}`).searchParams.get('q'),
              'fallback synthetic query',
            );
            res.writeHead(host.startsWith('lite.') ? 202 : 200, {
              'Content-Type': 'text/html',
            });
            res.end(
              host.startsWith('lite.')
                ? '<html><form id="challenge-form" action="/anomaly.js">Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</form></html>'
                : `<html><div class="results"><div class="result"><a class="result__a" href="${fallbackUrl}">Synthetic fallback source</a><a class="result__snippet">Fallback result bytes</a></div></div></html>`,
            );
            return;
          }
          assert.equal(req.headers.authorization, 'Bearer synthetic-key');
          if (req.url === '/v1/responses') {
            assert.equal(body.tools[0].type, 'web_search');
            assert(
              !JSON.stringify(body).includes('private conversation marker'),
            );
            assert(!body.tools.some((tool) => tool.type === 'function'));
            if (body.model === 'cancel-fixture') {
              cancelStarted = true;
              res.on('close', () => {
                cancelClosed = true;
              });
              return;
            }
            if (body.model === 'unsupported-fixture') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: {
                    type: 'invalid_request_error',
                    param: 'tools',
                    message: 'web_search is not supported',
                  },
                }),
              );
              return;
            }
            assert.equal(body.model, 'native-fixture');
            assert.match(JSON.stringify(body.input), /native synthetic query/);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'response-native-search',
                model: 'native-fixture',
                output: [
                  {
                    type: 'web_search_call',
                    id: 'search-executed',
                    status: 'completed',
                    action: {
                      type: 'search',
                      query: 'native synthetic query',
                      sources: [
                        {
                          type: 'url',
                          url: nativeUrl,
                          title: 'Synthetic native source',
                        },
                      ],
                    },
                  },
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      {
                        type: 'output_text',
                        text: 'Synthetic native summary',
                        annotations: [
                          {
                            type: 'url_citation',
                            url: nativeUrl,
                            title: 'Synthetic native source',
                            start_index: 0,
                            end_index: 24,
                          },
                        ],
                      },
                    ],
                  },
                ],
                usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
              }),
            );
            return;
          }
          assert.equal(req.url, '/v1/chat/completions');
          // The session title is asked after the turn. It is not a search turn.
          if (isTitleRequest(body)) {
            answerTitle(res, body);
            return;
          }
          const last = body.messages.at(-1);
          if (last.role === 'tool') {
            results.set(last.tool_call_id, last.content);
            assert.match(last.content, /Provider:/);
            assert(
              last.content.includes(
                last.tool_call_id === 'native-search' ? nativeUrl : fallbackUrl,
              ),
            );
            if (last.tool_call_id === 'fallback-search')
              assert.match(last.content, /duckduckgo/i);
            chat(res, { content: `${last.tool_call_id} complete` });
            return;
          }
          const kind =
            body.model === 'native-fixture'
              ? 'native'
              : body.model === 'unsupported-fixture'
                ? 'fallback'
                : 'cancel';
          chat(
            res,
            {
              tool_calls: [
                {
                  index: 0,
                  id: `${kind}-search`,
                  type: 'function',
                  function: {
                    name: 'websearch',
                    arguments: JSON.stringify({
                      query: `${kind} synthetic query`,
                      num_results: 3,
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        } catch (error) {
          errors.push(String(error));
          res.writeHead(500);
          res.end('synthetic fixture assertion failed');
        }
      },
    );
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    gateways.push({ host, server, port: server.address().port });
  }
  proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url);
    const gateway = gateways.find((item) => req.url === `${item.host}:443`);
    if (!gateway) {
      errors.push(`unexpected outbound connection: ${req.url}`);
      socket.end('HTTP/1.1 502 Fixture Only\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(gateway.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    for (const stream of [socket, upstream]) {
      connections.add(stream);
      stream.on('close', () => connections.delete(stream));
      stream.on('error', () => {
        socket.destroy();
        upstream.destroy();
      });
    }
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  await mkdir(join(home, 'cache'), { recursive: true });
  await mkdir(workspace);
  // Electron initializes Hunspell before creating a window. On a fresh Linux
  // profile that downloads a dictionary from redirector.gvt1.com, even with
  // Chromium's component updater disabled. Keep this fixture's profile offline:
  // an explicit, blocked dictionary avoids locale-dependent initialization.
  // https://www.electronjs.org/docs/latest/tutorial/spellchecker
  await writeFile(
    join(data, 'Preferences'),
    JSON.stringify({
      browser: { enable_spellchecking: false },
      spellcheck: {
        dictionaries: ['en-US'],
        blocked_dictionaries: ['en-US'],
        use_spelling_service: false,
      },
    }),
  );
  await writeFile(
    join(home, 'cache', 'models-dev.json'),
    JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
  );
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({
      version: 1,
      initialized: true,
      update_check: false,
      trusted_folders: [workspace],
      trust_cert_files: caFiles,
      auth: {
        protocol: 'openai',
        base_url: 'https://search.circle.test/v1',
        model: 'native-fixture',
        api_key_ref: 'api_key',
      },
    }),
  );
  await writeFile(
    join(home, 'credentials.json'),
    JSON.stringify({ api_key: 'synthetic-key' }),
  );
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: 'missing-fixture-session' }),
  );
  const env = {
    ...process.env,
    CIRCLE_HOME: home,
    CIRCLE_WORKBENCH_DATA_DIR: data,
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
    HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
    HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
    NO_PROXY: '',
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'CIRCLE_DESKTOP_RUNTIME_FIXTURE',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CIRCLE_TRUST_CERTS',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'ALL_PROXY',
    'all_proxy',
  ])
    delete env[key];
  if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
    env.PATH =
      process.platform === 'win32'
        ? `${process.env.SystemRoot}\\System32`
        : '/usr/bin:/bin:/usr/sbin:/sbin';
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  const profile = await app.evaluate(({ app, session }) => ({
    path: app.getPath('sessionData'),
    spellcheck: session.defaultSession.isSpellCheckerEnabled(),
  }));
  assert.equal(await realpath(profile.path), await realpath(data));
  assert.equal(profile.spellcheck, false);
  checks.push('the isolated Chromium profile disables spellchecker downloads');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const command = (name, payload = {}) =>
    page.evaluate(
      async ({ name, payload }) => {
        const { snapshot } = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: snapshot.activeSessionId,
        });
      },
      { name, payload },
    );
  const waitFor = async (condition) => {
    const deadline = Date.now() + patience(15000);
    while (!(await condition())) {
      assert(
        Date.now() < deadline,
        'timed out waiting for native search effect',
      );
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const configure = async (model) => {
    assert.equal(
      (
        await command('configure', {
          endpoint: 'https://search.circle.test/v1',
          protocol: 'openai',
          model,
          apiKey: 'synthetic-key',
        })
      ).ok,
      true,
    );
  };
  const prompt = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  await prompt('private conversation marker: native fixture');
  await page.getByText('native-search complete', { exact: true }).waitFor();
  await waitFor(async () => (await state()).sessions[0].state === 'idle');
  assert.equal(
    requests.filter((item) => item.host.includes('duckduckgo')).length,
    0,
  );
  const nativeTool = (await state()).sessions[0].messages.find(
    (message) => message.tool?.id === 'native-search',
  ).tool;
  assert.equal(nativeTool.status, 'success');
  assert.equal(nativeTool.output, results.get('native-search'));
  assert.equal((await state()).sessions[0].meters.input, 11);
  assert.equal((await state()).sessions[0].meters.output, 7);
  const answerUsage = (await state()).sessions[0].messages.find(
    (message) => message.text === 'native-search complete',
  ).usage;
  assert.equal(answerUsage.input, 11);
  assert.equal(answerUsage.output, 7);
  assert.equal(answerUsage.cost, null);
  checks.push(
    'native search executes through worker, reaches next model request and turn usage, and avoids DuckDuckGo',
  );

  await configure('unsupported-fixture');
  await prompt('private conversation marker: fallback fixture');
  await page.getByText('fallback-search complete', { exact: true }).waitFor();
  await waitFor(async () => (await state()).sessions[0].state === 'idle');
  assert.deepEqual(
    requests
      .filter((item) => item.host.includes('duckduckgo'))
      .map((item) => item.host),
    ['lite.duckduckgo.com', 'html.duckduckgo.com'],
  );
  checks.push(
    'explicitly unsupported native search falls back, challenge page advances to second endpoint',
  );

  await configure('cancel-fixture');
  const fallbackCount = requests.filter((item) =>
    item.host.includes('duckduckgo'),
  ).length;
  await prompt('private conversation marker: cancellation fixture');
  await waitFor(() => cancelStarted);
  assert.equal((await command('abort')).ok, true);
  await waitFor(async () => (await state()).sessions[0].state === 'idle');
  await waitFor(() => cancelClosed);
  assert.equal(
    requests.filter((item) => item.host.includes('duckduckgo')).length,
    fallbackCount,
  );
  checks.push(
    'cancelling an in-flight native request closes it without starting fallback',
  );

  const info = await page.evaluate(() => window.circleDesktop.info());
  await app.close();
  app = undefined;
  const database = new DatabaseSync(join(home, 'circle.sqlite'), {
    readOnly: true,
  });
  try {
    const messages = database
      .prepare('SELECT message FROM checkpoints')
      .all()
      .map((row) => JSON.parse(row.message))
      .filter(Boolean);
    const native = messages.find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'native-search',
    );
    assert.equal(native.content, results.get('native-search'));
    assert.equal(native.usage.input_tokens, 11);
    assert.equal(native.usage.output_tokens, 7);
    assert.equal(native.model_calls[0].model, 'native-fixture');
    assert.equal(
      messages.find(
        (message) =>
          message.role === 'tool' && message.tool_call_id === 'fallback-search',
      ).content,
      results.get('fallback-search'),
    );
    checks.push(
      'tool result, actual helper model, and usage survive in stored session history',
    );
  } finally {
    database.close();
  }
  assert.deepEqual(errors, []);
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { packaged: info.packaged, checks, requests, tunnels, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ packaged: info.packaged, checks: checks.length, errors }),
  );
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        requests,
        tunnels,
        checks,
        errors,
        snapshot: await page
          ?.evaluate(
            async () => (await window.circleDesktop.runtimeState()).snapshot,
          )
          .catch(() => undefined),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app?.close();
  for (const socket of connections) socket.destroy();
  for (const { server } of gateways) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (proxy) await new Promise((done) => proxy.close(done));
  await rm(temp, { recursive: true, force: true });
}
