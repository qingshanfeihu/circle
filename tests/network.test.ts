import { scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import {
  configureNetwork,
  extraCertificates,
  isCertificateError,
  TLS_HINT,
} from '../src/net.js';
import { resolveEndpoint } from '../src/probe.js';
import { webFetch } from '../src/websearch.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';

const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const NO_OPENSSL =
  OPENSSL.status === 0 ? false : 'openssl is not on PATH to make a test CA';

// A CA of its own and a certificate it signed for the made-up hosts the tests use.
function certificates(t: TestContext): {
  ca: string;
  key: string;
  cert: string;
} {
  const dir = scratch(t, 'circle-net-ca-');
  const config = (name: string, lines: string[]): void =>
    writeFileSync(
      join(dir, name),
      ['[req]', 'distinguished_name = dn', 'prompt = no', ...lines, ''].join(
        '\n',
      ),
    );
  config('ca.cnf', [
    '[dn]',
    'CN = Circle Test CA',
    '[ext]',
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
  ]);
  config('server.cnf', [
    '[dn]',
    'CN = circle-model.test',
    '[ext]',
    'subjectAltName = DNS:circle-model.test,DNS:circle-web.test,IP:127.0.0.1',
    'basicConstraints = CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
  ]);
  const run = (command: string): void => {
    const result = spawnSync('openssl', command.split(' '), {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  run(
    'req -x509 -newkey rsa:2048 -nodes -days 2 -keyout ca.key -out ca.pem -config ca.cnf -extensions ext',
  );
  run(
    'req -new -newkey rsa:2048 -nodes -keyout server.key -out server.csr -config server.cnf',
  );
  run(
    'x509 -req -in server.csr -CA ca.pem -CAkey ca.key -set_serial 2 -days 2 -out server.pem -extfile server.cnf -extensions ext',
  );
  return {
    ca: join(dir, 'ca.pem'),
    key: readFileSync(join(dir, 'server.key'), 'utf8'),
    cert: readFileSync(join(dir, 'server.pem'), 'utf8'),
  };
}

async function listen(t: TestContext, server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

interface Upstream {
  port: number;
  // Host header and path of each request the HTTPS server answered
  seen: string[];
  bodies: Record<string, unknown>[];
}

// The HTTPS server behind the proxy: an OpenAI-style model on circle-model.test, which asks
// for a webfetch of circle-web.test and then answers "done", and the page itself.
async function upstream(
  t: TestContext,
  key: string,
  cert: string,
): Promise<Upstream> {
  const state: Upstream = { port: 0, seen: [], bodies: [] };
  const server = createHttpsServer({ key, cert }, async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    state.seen.push(`${request.headers.host}${request.url}`);
    if (request.url === '/page') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('page behind the proxy');
      return;
    }
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gateway' }] }));
      return;
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    state.bodies.push(body);
    const first = state.bodies.length === 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (data: unknown): void => {
      response.write('data: ' + JSON.stringify(data) + '\n\n');
    };
    chunk({
      choices: [
        {
          index: 0,
          delta: first
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'fetch',
                    type: 'function',
                    function: {
                      name: 'webfetch',
                      arguments: JSON.stringify({
                        url: 'https://circle-web.test/page',
                        format: 'text',
                      }),
                    },
                  },
                ],
              }
            : { content: 'done' },
          finish_reason: first ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  state.port = await listen(t, server as unknown as Server);
  return state;
}

// An HTTP proxy that records what it is asked for and tunnels every CONNECT to `target`.
async function proxy(
  t: TestContext,
  target: number,
): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createHttpServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(502).end();
  });
  server.on('connect', (request, socket, head) => {
    seen.push(`CONNECT ${request.url}`);
    const tunnel = connect(target, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnel.write(head);
      tunnel.pipe(socket);
      socket.pipe(tunnel);
    });
    tunnel.on('error', () => socket.destroy());
    socket.on('error', () => tunnel.destroy());
  });
  const port = await listen(t, server);
  return { url: `http://127.0.0.1:${port}`, seen };
}

// What Node.js trusts, by fingerprint: it rewrites the PEM text of a list it is given.
const fingerprints = (): Set<string> =>
  new Set(
    tls
      .getCACertificates('default')
      .map((pem) => new X509Certificate(pem).fingerprint256),
  );

// The environment without any proxy or certificate setting of the machine running the tests
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (
      /^(https?_proxy|all_proxy|no_proxy|ssl_cert_(file|dir)|node_extra_ca_certs|node_use_env_proxy)$/i.test(
        name,
      )
    )
      delete env[name];
  return env;
}

test(
  'the CLI sends model requests and webfetch through HTTPS_PROXY and trusts the CA in SSL_CERT_FILE',
  {
    skip: NO_OPENSSL,
  },
  async (t) => {
    const { ca, key, cert } = certificates(t);
    const origin = await upstream(t, key, cert);
    const relay = await proxy(t, origin.port);
    const home = scratch(t);
    const workspace = scratch(t);
    let settings = defaultSettings();
    settings.initialized = true;
    settings.update_check = false;
    settings.auth = {
      ...settings.auth,
      base_url: 'https://circle-model.test/v1',
      model: 'gateway',
    };
    settings = trustFolder(settings, workspace);
    saveSettings(settings, home);
    saveCredentials({ api_key: 'test-key' }, home);
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', '-p', 'fetch', workspace, '--yolo'],
        {
          cwd: process.cwd(),
          env: {
            ...cleanEnvironment(),
            CIRCLE_HOME: home,
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_NO_UPDATE_CHECK: '1',
            HTTPS_PROXY: relay.url,
            SSL_CERT_FILE: ca,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      child.once('error', reject);
      child.once('close', (code) => resolveRun({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'done\n');
    // The hosts do not exist: the server is reached only through the proxy's tunnels, which
    // a later request may reuse.
    assert.deepEqual([...new Set(relay.seen)].sort(), [
      'CONNECT circle-model.test:443',
      'CONNECT circle-web.test:443',
    ]);
    assert.deepEqual(origin.seen, [
      'circle-model.test/v1/chat/completions',
      'circle-web.test/page',
      'circle-model.test/v1/chat/completions',
    ]);
    const messages = origin.bodies[1]!.messages as {
      role: string;
      content: string;
    }[];
    assert.match(
      messages.find((message) => message.role === 'tool')!.content,
      /page behind the proxy/,
    );
  },
);

test(
  'NO_PROXY bypasses the proxy, the CA is added to the ones Node.js trusts, and restore puts both back',
  {
    skip: NO_OPENSSL,
  },
  async (t) => {
    const { ca, key, cert } = certificates(t);
    const origin = await upstream(t, key, cert);
    const relay = await proxy(t, origin.port);
    const direct = `https://127.0.0.1:${origin.port}/page`;
    const before = fingerprints();
    const models = `https://127.0.0.1:${origin.port}/v1`;
    const refused = await fetch(direct).catch((error: unknown) => error);
    assert.ok(isCertificateError(refused), String(refused));
    const untrusted = await resolveEndpoint(models, 'key', {
      protocol: 'openai',
    });
    assert.equal(untrusted.status, 'failed');
    assert.equal(untrusted.detail, TLS_HINT);
    const setup = configureNetwork({
      HTTPS_PROXY: relay.url,
      NO_PROXY: '127.0.0.1',
      SSL_CERT_FILE: ca,
    });
    t.after(() => setup.restore());
    assert.deepEqual(setup.problems, []);
    assert.equal(setup.certificates, 1);
    assert.equal(setup.proxy, true);
    const trusted = fingerprints();
    assert.ok([...before].every((print) => trusted.has(print)));
    assert.equal(trusted.size, before.size + 1);
    assert.equal(await (await fetch(direct)).text(), 'page behind the proxy');
    const listed = await resolveEndpoint(models, 'key', { protocol: 'openai' });
    assert.deepEqual(listed.models, ['gateway']);
    assert.deepEqual(relay.seen, []);
    const page = await webFetch(
      'https://circle-web.test/page',
      'text',
      new AbortController().signal,
    );
    assert.match(page, /page behind the proxy/);
    assert.deepEqual(relay.seen, ['CONNECT circle-web.test:443']);
    setup.restore();
    assert.deepEqual(fingerprints(), before);
  },
);

test(
  'SSL_CERT_DIR is read like SSL_CERT_FILE and a setting that cannot be used is reported, not thrown',
  {
    skip: NO_OPENSSL,
  },
  (t) => {
    const { ca } = certificates(t);
    const folder = scratch(t);
    mkdirSync(join(folder, 'nested'));
    writeFileSync(join(folder, '5a1b2c3d.0'), readFileSync(ca));
    writeFileSync(join(folder, 'README'), 'not a certificate');
    const found = extraCertificates({ SSL_CERT_DIR: folder });
    assert.deepEqual(found.problems, []);
    assert.equal(found.certificates.length, 1);
    const missing = configureNetwork({
      SSL_CERT_FILE: join(folder, 'missing.pem'),
      SSL_CERT_DIR: join(folder, 'nested'),
      HTTPS_PROXY: 'http://bad\nproxy',
    });
    t.after(() => missing.restore());
    assert.equal(missing.certificates, 0);
    assert.equal(missing.proxy, false);
    assert.equal(missing.problems.length, 3);
    assert.match(missing.problems[0]!, /SSL_CERT_FILE cannot be read/);
    assert.match(missing.problems[1]!, /SSL_CERT_DIR has no PEM certificate/);
    assert.match(missing.problems[2]!, /proxy setting cannot be used/);
  },
);
