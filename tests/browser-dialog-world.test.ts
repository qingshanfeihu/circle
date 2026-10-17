import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';
import { cleanup, cleanupServer } from './helpers.js';
import { BrowserFixture } from './browser-fixture.js';

const executable = findBrowser();
async function until(check: () => boolean, signal: AbortSignal) {
  const end = Date.now() + 2000;
  while (!check()) {
    signal.throwIfAborted();
    if (Date.now() > end) throw Error('actual browser dialog did not open');
    await delay(10, undefined, { signal });
  }
}

test(
  'a real dialog opening while an isolated world is pending returns the tab dialog and never executes a late page command',
  { skip: !executable },
  async (t) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        req.url === '/dialog'
          ? '<title>Dialog page</title><output id="result">untouched</output><script>setTimeout(()=>confirm("actual confirm"),1000)</script>'
          : '<title>Home</title><p>home</p>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    cleanupServer(t, server);
    const base =
      'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
    });
    type Tab = {
      session: string;
      world?: number;
      dialogs: { id: string; type: string }[];
    };
    const internal = chrome as unknown as {
      child?: ChildProcess;
      ownedRoots?: Set<ChildProcess>;
      conversations: Map<string, { tabs: Map<string, Tab> }>;
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ) => Promise<any>;
      evaluate: <T>(
        tab: Tab,
        expression: string,
        signal: AbortSignal,
      ) => Promise<T>;
    };
    let held = 0,
      forceWorld = false;
    const fixture = new BrowserFixture({
      budgetMs: 60000,
      close: () => chrome.close(),
      ownedRoots: () => [...(internal.ownedRoots ?? []), internal.child],
      state: () => ({
        held,
        dialogs: [...internal.conversations.values()].flatMap((c) =>
          [...c.tabs.values()].map((tab) => ({
            session: tab.session,
            dialogs: tab.dialogs.map((d) => d.type),
          })),
        ),
      }),
      report: (record) => t.diagnostic(JSON.stringify(record)),
    });
    cleanup(t, () => fixture.close());
    const signal = AbortSignal.any([t.signal, fixture.signal]);
    await fixture.run(
      { phase: 'home' },
      () => chrome.request('c', 'navigate', { url: base }, signal),
      40000,
    );
    const send = internal.send.bind(chrome);
    internal.send = async (method, params, session) => {
      if (method === 'Page.createIsolatedWorld' && forceWorld) {
        forceWorld = false;
        held++;
        const tab = [...internal.conversations.get('c')!.tabs.values()].find(
          (tab) => tab.session === session,
        )!;
        await until(() => tab.dialogs.length > 0, signal);
      }
      return send(method, params, session);
    };
    forceWorld = true;
    const opened = await fixture.run(
      { phase: 'new tab actual modal blocks isolated world' },
      () =>
        chrome.request(
          'c',
          'tabs',
          { action: 'new', url: base + '/dialog' },
          signal,
        ),
      10000,
    );
    assert.match(opened.text, /confirm/);
    assert.equal(held, 1);
    const tab = internal.conversations.get('c')!.tabs.get('t2')!;
    await chrome.request(
      'c',
      'dialog',
      { id: tab.dialogs[0]!.id, accept: false, site: base },
      signal,
    );
    await delay(50, undefined, { signal });
    // Repeat with a unique mutating expression, so a late completion cannot be
    // hidden by a fresh public snapshot or a harmless title read.
    tab.world = undefined;
    forceWorld = true;
    await send(
      'Runtime.evaluate',
      { expression: 'setTimeout(()=>confirm("second actual confirm"),50)' },
      tab.session,
    );
    await fixture.run(
      { phase: 'pending mutating page call stops on actual modal' },
      () =>
        assert.rejects(
          internal.evaluate(
            tab,
            "document.querySelector('#result').textContent='LATE_MUTATION'",
            signal,
          ),
          /waiting on a dialog/,
        ),
      10000,
    );
    await chrome.request(
      'c',
      'dialog',
      { id: tab.dialogs[0]!.id, accept: false, site: base },
      signal,
    );
    await delay(100, undefined, { signal });
    const snapshot = await chrome.request('c', 'snapshot', {}, signal);
    assert.match(snapshot.text, /untouched/);
    assert.doesNotMatch(snapshot.text, /LATE_MUTATION/);
    assert.equal(held, 2);
  },
);
