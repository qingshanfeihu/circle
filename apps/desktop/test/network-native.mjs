// Actual sandboxed Electron → preload → worker → local TLS gateways, with two private CAs.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { answerTitle, isTitleRequest } from './helpers/title-requests.mjs';
import { tlsCertificates } from '../../../tests/tls-certificates.mjs';
import { patience } from './helpers/patience.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-network-native-'));
const output = resolve(
  root,
  '../../outputs/network-native',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
const gateways = [];
const connections = new Set();
const seen = [];
let searchDiagnostic;
const caFiles = [];
let app;
let proxy;
try {
  for (const host of ['first.circle.test', 'second.circle.test']) {
    const folder = join(temp, host);
    await mkdir(folder);
    const chain = tlsCertificates(folder, host);
    caFiles.push(chain.ca);
    const server = httpsServer(
      { key: chain.key, cert: chain.cert },
      async (req, res) => {
        const body = JSON.parse(
          Buffer.concat(await Array.fromAsync(req)).toString(),
        );
        assert.equal(req.headers.authorization, 'Bearer synthetic-key');
        // The session title is asked after the turn, through the same proxy.
        if (isTitleRequest(body)) {
          answerTitle(res, body);
          return;
        }
        if (req.url === '/v1/responses') {
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
        seen.push({ host, url: req.url, model: body.model });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const last = body.messages.at(-1);
        if (
          last.role === 'user' &&
          last.content === 'trigger local search failures'
        ) {
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native-search', type: 'function', function: { name: 'websearch', arguments: JSON.stringify({ query: 'private synthetic query' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (last.role === 'tool' && last.tool_call_id === 'native-search') {
          searchDiagnostic = last.content;
          assert.match(searchDiagnostic, /lite\.duckduckgo\.com/);
          assert.match(searchDiagnostic, /html\.duckduckgo\.com/);
          assert(!searchDiagnostic.includes('private synthetic query'));
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'native search failures preserved' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${host} trusted` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      },
    );
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    gateways.push({ host, server, port: server.address().port });
  }
  const tunnels = [];
  proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url);
    const gateway = gateways.find((item) => req.url === `${item.host}:443`);
    if (!gateway) {
      socket.end(
        'HTTP/1.1 502 Synthetic Proxy Failure\r\nContent-Length: 0\r\n\r\n',
      );
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
  const data = join(temp, 'data');
  const home = join(data, 'runtime-home');
  const workspace = join(temp, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace);
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
        base_url: 'https://first.circle.test/v1',
        model: 'fixture-model',
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
    env,
    cwd: root,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const command = (name, payload) =>
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
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const initial = (await state()).runtime.network;
  assert.equal(initial.certificates, 2);
  assert.equal(initial.proxy, true);
  assert.deepEqual(initial.problems, []);
  for (const { host } of gateways) {
    if (host !== gateways[0].host)
      assert.equal(
        (
          await command('configure', {
            endpoint: `https://${host}/v1`,
            protocol: 'openai',
            model: 'fixture-model',
            apiKey: 'synthetic-key',
          })
        ).ok,
        true,
      );
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(`test ${host}`);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
    try {
      await page.getByText(`${host} trusted`, { exact: true }).waitFor();
    } catch (error) {
      const failed = await state();
      console.error(
        JSON.stringify({
          seen,
          tunnels,
          network: failed.runtime.network,
          messages: failed.sessions[0].messages.map((message) => ({
            role: message.role,
            text: message.text,
          })),
        }),
      );
      throw error;
    }
    const deadline = Date.now() + patience(10000);
    while ((await state()).sessions[0].state !== 'idle') {
      assert(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  assert.deepEqual(
    seen.slice(0, 2).map((row) => row.host),
    gateways.map((row) => row.host),
  );
  assert(
    seen.every(
      (row) =>
        row.url === '/v1/chat/completions' && row.model === 'fixture-model',
    ),
  );
  assert(gateways.every((row) => tunnels.includes(`${row.host}:443`)));
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('trigger local search failures');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  try {
    await page
      .getByText('native search failures preserved', { exact: true })
      .waitFor();
  } catch (error) {
    const failed = await state();
    console.error(
      JSON.stringify({
        seen,
        tunnels,
        interactions: failed.interactions,
        messages: failed.sessions[0].messages.map((message) => ({
          role: message.role,
          text: message.text,
          tool: message.tool,
        })),
      }),
    );
    throw error;
  }
  const searchTool = (await state()).sessions[0].messages.find(
    (message) => message.tool?.id === 'native-search',
  ).tool;
  assert.equal(searchTool.status, 'error');
  assert.equal(searchTool.output, searchDiagnostic);
  assert(
    tunnels.includes('lite.duckduckgo.com:443') &&
      tunnels.includes('html.duckduckgo.com:443'),
  );
  assert.deepEqual(errors, []);
  await mkdir(output, { recursive: true });
  const info = await page.evaluate(() => window.circleDesktop.info());
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        packaged: info.packaged,
        versions: await app.evaluate(({ app }) => ({
          node: process.versions.node,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          app: app.getVersion(),
        })),
        checks: 4,
        network: {
          certificates: initial.certificates,
          authorities: initial.authorities,
          proxy: initial.proxy,
        },
        seen,
        tunnels,
        searchDiagnostic,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ packaged: info.packaged, checks: 4, errors }));
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
