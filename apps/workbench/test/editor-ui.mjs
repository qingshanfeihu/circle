import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceServices } from '../../desktop/src/workspace/workspace-services.ts';
const workspace = mkdtempSync(join(tmpdir(), 'circle-editor-ui-'));
const initial =
  'import { amount } from "./lib";\nconst label = "amount";\nconsole.log(amount, label);\n';
writeFileSync(join(workspace, 'main.ts'), initial);
writeFileSync(join(workspace, 'lib.ts'), 'export const amount = 1;\n');
const rules = '# isolated project instructions\nfollow the rules\n';
writeFileSync(join(workspace, 'AGENTS.md'), rules);
const languageControls = [];
const languageData = mkdtempSync(
  join(tmpdir(), 'circle-editor-language-journal-'),
);
const documentsModule =
  process.env.CIRCLE_EDITOR_DOCUMENT_SERVICE ??
  fileURLToPath(
    new URL('../../desktop/src/workspace/documents.ts', import.meta.url),
  );
if (process.env.CIRCLE_EDITOR_DOCUMENT_SERVICE && !existsSync(documentsModule))
  throw Error('requested document service module does not exist');
const documents = existsSync(documentsModule)
  ? new (await import(pathToFileURL(documentsModule).href)).WorkspaceDocuments(
      workspace,
    )
  : null;
const streams = new Set();
const journal = [];
let pauseEvents = false;
let holdNextRead = false;
// Text another program writes while the next save is still in flight.
let externalDuringSave;
let releaseHeldRead;
let mainReads = 0;
let interruptNextBatch = false;
let holdNextHistory = false;
let releaseHistory;
let heldHistory = 0;
let failNextCopy = false;
const diagnosticCopies = [];
const batchCalls = [];
const batchCommitCounts = new Map();
let seq = 0,
  externalWrites = 0;
const event = (data, service = 'documents', resourceId = 'files') => {
  const payload = {
    workspaceId: 'fixture',
    sessionId: 'fixture',
    service,
    resourceId,
    epoch: 'editor-fixture',
    seq: ++seq,
    cursor: { seq, offset: seq * 100 },
    at: new Date().toISOString(),
    data,
  };
  journal.push(payload);
  for (const stream of pauseEvents ? [] : streams)
    stream.write(`data: ${JSON.stringify(payload)}\n\n`);
};
const language = new WorkspaceServices({
  workspaceRoot: workspace,
  workspaceId: 'fixture',
  dataDir: languageData,
  nodeExecutable: process.execPath,
  runtimeExecutable: process.execPath,
  adapterPath: 'unused',
  ghPath: 'unused',
  languageServers: {},
  emit: (record) => {
    if (record.service === 'language')
      event(record.data, 'language', record.resourceId);
  },
});
const files = () =>
  readdirSync(workspace)
    .filter((name) => name.endsWith('.ts'))
    .map((path) => ({
      id: path,
      path,
      mtime: statSync(join(workspace, path)).mtimeMs,
      size: statSync(join(workspace, path)).size,
    }));
const changed = async (changes) => {
  await language.call('fixture', 'language', 'refresh', {});
  if (documents) {
    const snapshot = await documents.refresh();
    event({ kind: 'files', snapshot });
  } else
    event({
      kind: 'files',
      snapshot: {
        version: seq + 1,
        files: files(),
        changes: changes.map(([kind, path]) => ({
          kind,
          file: { id: path, path, mtime: 0, size: 0 },
        })),
        truncated: false,
      },
    });
};
if (documents) await documents.refresh();
const readDocument = (path) => {
  if (
    !['main.ts', 'lib.ts', 'moved.ts', 'tsconfig.json', 'AGENTS.md'].includes(
      path,
    )
  )
    throw Error('outside fixture');
  const content = readFileSync(join(workspace, path), 'utf8');
  return {
    path,
    content,
    revision: createHash('sha256').update(content).digest('hex'),
  };
};
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  plugins: [
    {
      name: 'circle-editor-test-adapter',
      configureServer(server) {
        server.middlewares.use('/__editor_events', (request, response) => {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(': ready\n\n');
          streams.add(response);
          request.on('close', () => streams.delete(response));
        });
        server.middlewares.use(
          '/__editor_workspace',
          async (request, response) => {
            try {
              if (request.url.includes('copy-diagnostics=1')) {
                if (failNextCopy) {
                  failNextCopy = false;
                  throw Error('isolated clipboard unavailable');
                }
                let body = '';
                for await (const chunk of request) body += chunk;
                diagnosticCopies.push(body);
                response.end('{}');
                return;
              }
              if (request.url.includes('fail-copy=1')) {
                failNextCopy = true;
                response.end('{}');
                return;
              }
              if (request.url.includes('hold-history=1')) {
                holdNextHistory = true;
                response.end('{}');
                return;
              }
              if (request.url.includes('release-history=1')) {
                releaseHistory?.();
                response.end('{}');
                return;
              }
              if (request.url.includes('history-pending=1')) {
                response.end(JSON.stringify({ heldHistory }));
                return;
              }
              if (request.url.includes('external-during-save=1')) {
                externalDuringSave = '// written during the save\n';
                response.end('{}');
                return;
              }
              if (request.url.includes('hold-read=1')) {
                holdNextRead = true;
                event({ kind: 'save', paths: ['main.ts'] });
                response.end('{}');
                return;
              }
              if (request.url.includes('release-read=1')) {
                releaseHeldRead?.();
                response.end('{}');
                return;
              }
              if (request.url.includes('resume-events=1')) {
                pauseEvents = false;
                for (const stream of streams)
                  for (const payload of journal)
                    stream.write(`data: ${JSON.stringify(payload)}\n\n`);
                response.end('{}');
                return;
              }
              if (request.url.includes('touch=1')) {
                const time = new Date(Date.now() + 1000);
                utimesSync(join(workspace, 'main.ts'), time, time);
                await changed([['changed', 'main.ts']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('external=1')) {
                writeFileSync(
                  join(workspace, 'main.ts'),
                  initial + `// external write ${++externalWrites}\n`,
                );
                await changed([['changed', 'main.ts']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('rename=1')) {
                renameSync(
                  join(workspace, 'main.ts'),
                  join(workspace, 'moved.ts'),
                );
                await changed([
                  ['removed', 'main.ts'],
                  ['added', 'moved.ts'],
                ]);
                response.end('{}');
                return;
              }
              if (request.url.includes('delete=1')) {
                unlinkSync(join(workspace, 'moved.ts'));
                await changed([['removed', 'moved.ts']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('badconfig=1')) {
                writeFileSync(
                  join(workspace, 'tsconfig.json'),
                  '{"compilerOptions":{"target":,}}',
                );
                await changed([['added', 'tsconfig.json']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('goodconfig=1')) {
                writeFileSync(
                  join(workspace, 'tsconfig.json'),
                  JSON.stringify({
                    compilerOptions: {
                      target: 'ES2022',
                      module: 'ESNext',
                      moduleResolution: 'Bundler',
                    },
                    include: ['*.ts'],
                  }),
                );
                await changed([['changed', 'tsconfig.json']]);
                response.end('{}');
                return;
              }
              let body = '';
              for await (const chunk of request) body += chunk;
              const command = JSON.parse(body),
                { service, method, params } = command.payload;
              let data;
              if (service === 'events' && method === 'replay') {
                const historyRead = params.limit === 32;
                const events = journal
                  .filter((event) => event.seq > (params.after?.seq ?? 0))
                  .slice(0, historyRead ? 3 : (params.limit ?? 256));
                data = {
                  events,
                  cursor: events.at(-1)?.cursor ??
                    params.after ?? { seq: 0, offset: 0 },
                  hasMore: journal.some(
                    (event) =>
                      event.seq >
                      (events.at(-1)?.seq ?? params.after?.seq ?? 0),
                  ),
                };
                if (historyRead && holdNextHistory) {
                  holdNextHistory = false;
                  heldHistory++;
                  await new Promise((resolve) => {
                    releaseHistory = resolve;
                  });
                }
              } else if (service === 'language') {
                if (
                  method === 'request' &&
                  ['status', 'stop', 'restart'].includes(params.method)
                )
                  languageControls.push({
                    method: params.method,
                    path: params.path,
                  });
                data = await language.call(
                  'fixture',
                  'language',
                  method,
                  params,
                );
              } else if (service === 'documents' && method === 'read') {
                if (params.path === 'AGENTS.md')
                  await new Promise((resolve) => setTimeout(resolve, 200));
                data = documents
                  ? await documents.read(params.path)
                  : readDocument(params.path);
                if (params.path === 'main.ts') {
                  mainReads++;
                  if (holdNextRead) {
                    holdNextRead = false;
                    pauseEvents = true;
                    await new Promise((resolve) => {
                      releaseHeldRead = resolve;
                    });
                  }
                }
              } else if (service === 'documents' && method === 'applyEdits') {
                assert.ok(
                  documents,
                  'batch recovery uses real WorkspaceDocuments',
                );
                batchCalls.push(params.edits.map((edit) => edit.path));
                const signal = new AbortController();
                const readTarget = documents.readTarget;
                if (interruptNextBatch) {
                  interruptNextBatch = false;
                  const first = params.edits[0];
                  documents.readTarget = async function (...args) {
                    const document = await readTarget.apply(this, args);
                    if (
                      args[1] === first.path &&
                      document.content === first.content
                    )
                      signal.abort();
                    return document;
                  };
                }
                try {
                  data = await documents.applyEdits(params.edits, {
                    signal: signal.signal,
                  });
                } finally {
                  documents.readTarget = readTarget;
                }
                for (const path of data.committedPaths)
                  batchCommitCounts.set(
                    path,
                    (batchCommitCounts.get(path) ?? 0) + 1,
                  );
                await changed(
                  data.committedPaths.map((path) => ['changed', path]),
                );
              } else if (service === 'documents' && method === 'save') {
                if (documents)
                  data = await documents.save(
                    params.path,
                    params.content,
                    params.expectedRevision,
                  );
                else {
                  const current = existsSync(join(workspace, params.path))
                    ? readDocument(params.path)
                    : null;
                  if ((current?.revision ?? null) !== params.expectedRevision)
                    throw Error('file changed on disk');
                  writeFileSync(join(workspace, params.path), params.content);
                  data = readDocument(params.path);
                }
                await changed([['changed', params.path]]);
                if (externalDuringSave !== undefined) {
                  writeFileSync(
                    join(workspace, params.path),
                    params.content + externalDuringSave,
                  );
                  externalDuringSave = undefined;
                  await changed([['changed', params.path]]);
                }
                await new Promise((resolve) => setTimeout(resolve, 400));
              } else throw Error('unsupported fixture operation');
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ ok: true, data }));
            } catch (error) {
              response.end(JSON.stringify({ ok: false, error: error.message }));
            }
          },
        );
      },
    },
  ],
  root,
  cacheDir: join(languageData, 'vite-cache'),
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
let browser;
try {
  const historicalContent = Array.from(
    { length: 800 },
    (_, index) => `const bad${index}: number = "wrong";`,
  ).join('\n');
  await language.call('fixture', 'language', 'change', {
    path: 'main.ts',
    content: historicalContent,
    version: 21,
  });
  const historicalDiagnostics = await language.call(
    'fixture',
    'language',
    'request',
    { method: 'diagnostics', path: 'main.ts' },
  );
  assert.equal(historicalDiagnostics.length, 800);
  const historicalBatch = journal.find(
    (row) => row.service === 'language' && row.data.kind === 'diagnostics',
  );
  assert.ok(
    historicalBatch.data.count > 3,
    'real diagnostic result spans multiple replay pages',
  );
  await language.call('fixture', 'language', 'change', {
    path: 'main.ts',
    content: 'const amount: number = "review this value";\n',
    version: 22,
  });
  const shortDiagnostics = await language.call(
    'fixture',
    'language',
    'request',
    { method: 'diagnostics', path: 'main.ts' },
  );
  assert.equal(shortDiagnostics.length, 1);
  const shortBatch = journal.findLast(
    (row) => row.service === 'language' && row.data.kind === 'diagnostics',
  );
  await language.call('fixture', 'language', 'change', {
    path: 'main.ts',
    content: initial,
    version: 23,
  });
  assert.deepEqual(
    await language.call('fixture', 'language', 'request', {
      method: 'diagnostics',
      path: 'main.ts',
    }),
    [],
  );
  await language.releaseSession('fixture');
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const historyPage = await browser.newPage({
    viewport: { width: 760, height: 900 },
  });
  historyPage.on('pageerror', (error) => errors.push(error.message));
  await historyPage.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer`,
  );
  await historyPage.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.includes('console.log'),
  );
  await historyPage
    .getByText('all changes saved', { exact: true })
    .waitFor({ state: 'attached' });
  await historyPage.locator('.editor-project-diagnostics > summary').click();
  await historyPage.getByText('diagnostic history', { exact: true }).click();
  const historyBatch = historyPage.locator(
    `[data-diagnostic-batch="${historicalBatch.data.batchId}"]`,
  );
  await historyBatch.locator(':scope > summary').click();
  await historyBatch
    .getByText('diagnostic batch incomplete; read more', { exact: true })
    .waitFor();
  assert.equal(
    await historyBatch
      .getByRole('button', { name: 'copy complete diagnostics', exact: true })
      .isDisabled(),
    true,
  );
  let historyPages = 0;
  while (
    await historyPage
      .getByRole('button', {
        name: 'read more diagnostic history',
        exact: true,
      })
      .count()
  ) {
    const more = historyPage.getByRole('button', {
      name: 'read more diagnostic history',
      exact: true,
    });
    await more.click();
    await historyPage
      .getByRole('button', { name: 'reading diagnostic history', exact: true })
      .waitFor({ state: 'hidden' });
    assert.ok(++historyPages < 50, 'history cursor makes bounded progress');
  }
  assert.ok(historyPages > 1, 'history was read through multiple real pages');
  await historyBatch
    .getByRole('button', { name: 'copy complete diagnostics', exact: true })
    .click();
  await historyPage.waitForFunction(
    () => document.documentElement.dataset.diagnosticCopies === '1',
  );
  assert.equal(diagnosticCopies.at(-1), JSON.stringify(historicalDiagnostics));
  await historyPage.evaluate(() => fetch('/__editor_workspace?fail-copy=1'));
  await historyBatch
    .getByRole('button', { name: 'copy complete diagnostics', exact: true })
    .click();
  await historyPage
    .getByText('could not copy diagnostics', { exact: true })
    .waitFor();
  assert.equal(
    diagnosticCopies.length,
    1,
    'failed clipboard write never claims another copy',
  );
  assert.equal(
    await historyBatch
      .getByRole('button', { name: 'copy complete diagnostics', exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(await historyBatch.locator('li').count(), 800);
  assert.equal(
    await historyBatch.locator('pre').isVisible(),
    false,
    'raw diagnostic JSON stays folded',
  );
  assert.equal(
    await historyPage.locator('.squiggly-error').count(),
    0,
    'historical errors never replace cleared current markers',
  );
  await historyBatch.locator(':scope > summary').click();
  const shortHistoryBatch = historyPage.locator(
    `[data-diagnostic-batch="${shortBatch.data.batchId}"]`,
  );
  await shortHistoryBatch.locator(':scope > summary').click();
  assert.equal(await shortHistoryBatch.locator('li').count(), 1);
  assert.match(
    await shortHistoryBatch.locator('li').innerText(),
    /typescript error.*line 1.*not assignable/s,
  );
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR) {
    mkdirSync(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, { recursive: true });
    for (const width of [760, 375]) {
      await historyPage.setViewportSize({ width, height: 900 });
      for (const theme of ['dark', 'light']) {
        await historyPage.evaluate(
          async (theme) => (await import('/src/theme.ts')).applyTheme(theme),
          theme,
        );
        await historyPage.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        await shortHistoryBatch
          .getByRole('button', {
            name: 'copy complete diagnostics',
            exact: true,
          })
          .scrollIntoViewIfNeeded();
        await historyPage.screenshot({
          path: join(
            process.env.CIRCLE_EDITOR_EVIDENCE_DIR,
            `diagnostic-history-${theme}-${width}.png`,
          ),
        });
      }
    }
    await historyPage.setViewportSize({ width: 760, height: 900 });
  }
  const savedLanguage = await language.replay();
  assert.ok(
    savedLanguage.events.some(
      (row) => row.data.batchId === historicalBatch.data.batchId,
    ),
  );
  await historyPage
    .getByRole('button', { name: 'open lib', exact: true })
    .click();
  await historyPage
    .locator('.file-view-heading strong')
    .getByText('lib.ts', { exact: true })
    .waitFor();
  await historyPage
    .getByRole('button', { name: 'read more diagnostic history', exact: true })
    .waitFor();
  while (
    await historyPage
      .getByRole('button', {
        name: 'read more diagnostic history',
        exact: true,
      })
      .count()
  ) {
    await historyPage
      .getByRole('button', {
        name: 'read more diagnostic history',
        exact: true,
      })
      .click();
    await historyPage
      .getByRole('button', { name: 'reading diagnostic history', exact: true })
      .waitFor({ state: 'hidden' });
  }
  await historyPage.evaluate(() => fetch('/__editor_workspace?hold-history=1'));
  await historyPage
    .getByRole('button', { name: 'open main', exact: true })
    .click();
  await historyPage.waitForFunction(
    async () =>
      (await (await fetch('/__editor_workspace?history-pending=1')).json())
        .heldHistory === 1,
  );
  await historyPage
    .getByRole('button', { name: 'open lib', exact: true })
    .click();
  await historyPage
    .locator('.file-view-heading strong')
    .getByText('lib.ts', { exact: true })
    .waitFor();
  await historyPage.evaluate(() =>
    fetch('/__editor_workspace?release-history=1'),
  );
  await historyPage
    .getByRole('button', { name: 'reading diagnostic history', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(
    await historyPage
      .locator(`[data-diagnostic-batch="${historicalBatch.data.batchId}"]`)
      .count(),
    0,
    'late main-file history never leaks into lib',
  );
  await historyPage
    .getByRole('button', { name: 'open main', exact: true })
    .click();
  await historyPage
    .locator('.file-view-heading strong')
    .getByText('main.ts', { exact: true })
    .waitFor();
  await historyPage.close();
  const referencesPage = await browser.newPage();
  referencesPage.on('pageerror', (error) => errors.push(error.message));
  await referencesPage.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1`,
  );
  await referencesPage
    .getByRole('button', { name: 'edit', exact: true })
    .click();
  const referenceLines = referencesPage
    .locator('.native-code-editor .view-lines')
    .first();
  await referencesPage.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.includes('console.log'),
  );
  await referenceLines.click();
  const referenceModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await referencesPage.keyboard.press(`${referenceModifier}+a`);
  await referencesPage.keyboard.press('ArrowLeft');
  for (let index = 0; index < 10; index++)
    await referencesPage.keyboard.press('ArrowRight');
  await referencesPage.keyboard.press('Shift+F12');
  const referenceWidget = referencesPage.locator('.reference-zone-widget');
  await referenceWidget.waitFor({ state: 'visible', timeout: 10000 });
  await referenceWidget
    .locator('.monaco-list-row')
    .filter({ hasText: 'import { amount }' })
    .waitFor();
  await referenceWidget
    .locator('.monaco-list-row')
    .filter({ hasText: 'console.log(amount, label);' })
    .waitFor();
  assert.equal(
    await referenceWidget.locator('.head .dirname').textContent(),
    '.',
    'reference widget shows a relative root instead of its internal workspace URI segment',
  );
  assert.equal(
    await referenceWidget.locator('.head .filename').textContent(),
    'main.ts',
    'display labels preserve the actual reference file identity',
  );
  console.log('Keyboard references widget shows actual import and usage rows');
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR) {
    mkdirSync(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, { recursive: true });
    await referencesPage.screenshot({
      path: join(
        process.env.CIRCLE_EDITOR_EVIDENCE_DIR,
        'editor-keyboard-references.png',
      ),
    });
  }
  // Selecting a usage schedules the SDK active-node update; closing immediately
  // must dispose that pending update without an unhandled cancellation rejection.
  await referenceWidget
    .locator('.monaco-list-row')
    .filter({ hasText: 'console.log(amount, label);' })
    .click();
  await referencesPage.keyboard.press('Escape');
  await referenceLines.click();
  await referencesPage.keyboard.press(`${referenceModifier}+a`);
  await referencesPage.keyboard.insertText(
    'const object = { uniqueMember: 42, uniqueOther: 7 };\nobject.uni',
  );
  await referencesPage.keyboard.press('Control+Space');
  await referencesPage
    .locator('.suggest-widget.visible .monaco-list-row')
    .filter({ hasText: 'uniqueMember' })
    .waitFor();
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR)
    await referencesPage.screenshot({
      path: join(
        process.env.CIRCLE_EDITOR_EVIDENCE_DIR,
        'editor-keyboard-completion.png',
      ),
    });
  await referencesPage
    .locator('.suggest-widget.visible .monaco-list-row')
    .filter({ hasText: 'uniqueOther' })
    .waitFor();
  assert.equal(
    await referencesPage
      .locator('.suggest-widget.visible .monaco-list-row')
      .count(),
    2,
  );
  await referencesPage.keyboard.press('ArrowDown');
  await referencesPage
    .locator('.suggest-widget.visible .monaco-list-row.focused')
    .filter({ hasText: 'uniqueOther' })
    .waitFor({ state: 'visible' });
  await referencesPage.keyboard.press('ArrowUp');
  await referencesPage
    .locator('.suggest-widget.visible .monaco-list-row.focused')
    .filter({ hasText: 'uniqueMember' })
    .waitFor({ state: 'visible' });
  await referencesPage.keyboard.press('Enter');
  await referencesPage.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('object.uniqueMember'),
  );
  assert.equal(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    initial,
    'keyboard completion remains unsaved',
  );
  await referencesPage.keyboard.press(`${referenceModifier}+s`);
  for (
    let tries = 0;
    tries < 100 &&
    readFileSync(join(workspace, 'main.ts'), 'utf8') !==
      'const object = { uniqueMember: 42, uniqueOther: 7 };\nobject.uniqueMember';
    tries++
  )
    await referencesPage.waitForTimeout(30);
  assert.equal(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    'const object = { uniqueMember: 42, uniqueOther: 7 };\nobject.uniqueMember',
  );
  console.log('Keyboard completion accepts uniqueMember with exact disk save');
  await referencesPage.close();
  writeFileSync(join(workspace, 'main.ts'), initial);
  await page.goto(`${server.resolvedUrls.local[0]}test/editor-ui.html`);
  await page.locator('.monaco-editor').waitFor();
  await page
    .getByRole('button', { name: 'repeat source location', exact: true })
    .click();
  await page
    .locator('.monaco-editor')
    .evaluate((node) => (window.sourceLocationEditor = node));
  await page
    .getByRole('button', { name: 'repeat source location', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.sourceLocationEditor),
    true,
    'repeated source location must not destroy active editor widgets',
  );

  await page
    .getByRole('button', { name: 'other source location', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.sourceLocationEditor),
    true,
    'new source locations reposition without view disposal',
  );
  await page.waitForFunction(() => {
    const input = document.querySelector(
      '.native-edit-context, textarea.inputarea',
    );
    const state = input.editContext ?? input;
    return state.selectionStart === 0 && state.selectionEnd === 5;
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// human edit');
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+s`);
  await page.waitForFunction(
    () =>
      document.querySelector('output[aria-label="saves"]').textContent === '1',
  );
  await page.getByRole('button', { name: 'toggle diff', exact: true }).click();
  await page.locator('.monaco-diff-editor').waitFor();
  await page.getByRole('button', { name: 'toggle diff', exact: true }).click();
  await page
    .getByRole('button', { name: 'toggle editor', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'toggle editor', exact: true })
    .click();
  await page.locator('.monaco-editor').waitFor();
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// human edit'),
  );
  await page.getByRole('button', { name: 'toggle theme', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'light' &&
      document.querySelector('.monaco-editor.vs'),
  );
  await page.getByRole('button', { name: 'toggle theme', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.querySelector('.monaco-editor.vs-dark'),
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--code-size', '16px'),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.view-lines')).fontSize ===
      '16px',
  );
  assert.equal(
    await page.evaluate(() => {
      const editor = document.querySelector('.monaco-editor');
      const probe = document.createElement('span');
      editor.append(probe);
      probe.style.backgroundColor = 'var(--vscode-menu-background)';
      const actual = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = 'var(--surface)';
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return actual === expected;
    }),
    true,
    'Monaco popup surface follows the original Circle palette',
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--code-size', '13px'),
  );
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// restored after reload');
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      ?.textContent.includes('// restored after reload'),
  );
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// language undo');
  // EditContext input and React's onChange projection settle asynchronously.
  // Capture the already-confirmed dirty content, never a pre-input output.
  await page.waitForFunction(
    () =>
      document
        .querySelector('output[aria-label="content"]')
        ?.textContent.includes('// language undo') &&
      document
        .querySelector('.native-code-editor .view-lines')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('// language undo'),
  );
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page
    .locator('.monaco-editor')
    .evaluate((node) => (window.localeEditorView = node));
  const editorBeforeLocale = await page
    .locator('output[aria-label="content"]')
    .textContent();
  await page.waitForFunction(() => {
    const node = document.querySelector(
      '.native-code-editor .native-edit-context, .native-code-editor textarea.inputarea',
    );
    const state = node?.editContext ?? node;
    return state && state.selectionStart !== state.selectionEnd;
  });
  const rangeBeforeLocale = await page
    .locator('.native-edit-context, textarea.inputarea')
    .first()
    .evaluate((node) =>
      node.editContext
        ? [node.editContext.selectionStart, node.editContext.selectionEnd]
        : [node.selectionStart, node.selectionEnd],
    );
  assert.notEqual(rangeBeforeLocale[0], rangeBeforeLocale[1]);

  await page
    .getByRole('button', { name: 'toggle language', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.localeEditorView),
    true,
    'locale switch keeps active Monaco view',
  );
  assert.equal(
    await page.locator('output[aria-label="content"]').textContent(),
    editorBeforeLocale,
  );
  assert.deepEqual(
    await page
      .locator('.native-edit-context, textarea.inputarea')
      .first()
      .evaluate((node) =>
        node.editContext
          ? [node.editContext.selectionStart, node.editContext.selectionEnd]
          : [node.selectionStart, node.selectionEnd],
      ),
    rangeBeforeLocale,
  );
  await page.locator('.view-lines').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制/ }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'toggle language', exact: true })
    .click();
  await page.locator('.view-lines').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// language undo'),
  );
  const chinese = await browser.newPage();
  await chinese.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?lang=zh-CN`,
  );
  await chinese.locator('.monaco-editor').waitFor();
  await chinese.locator('.view-lines').first().click({ button: 'right' });
  await chinese.getByRole('menuitem', { name: /^复制/ }).waitFor();
  await chinese.close();
  const switched = await browser.newPage();
  switched.on('pageerror', (error) => errors.push(error.message));
  await switched.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1`,
  );
  await switched.getByRole('button', { name: 'edit', exact: true }).click();
  const appendTo = async (text) => {
    await switched.locator('.native-code-editor .view-lines').first().click();
    await switched.keyboard.press(`${modifier}+End`);
    await switched.keyboard.insertText(text);
  };
  const diskUntil = async (path, predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (predicate(readFileSync(join(workspace, path), 'utf8'))) return;
      await switched.waitForTimeout(20);
    }
    throw Error(
      `disk timeout ${path}: ${readFileSync(join(workspace, path), 'utf8')}`,
    );
  };
  const replaceDraft = async (text) => {
    await switched.locator('.native-code-editor .view-lines').first().click();
    await switched.keyboard.press(`${modifier}+a`);
    await switched.keyboard.insertText(text);
    await switched.getByText('unsaved changes', { exact: true }).waitFor();
  };
  const settle = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await switched.waitForTimeout(20);
    }
    throw Error(label);
  };
  for (const { externalChange, pendingReply } of [
    { externalChange: false, pendingReply: true },
    { externalChange: false, pendingReply: false },
    { externalChange: true, pendingReply: false },
  ]) {
    releaseHeldRead = undefined;
    await switched.evaluate(() =>
      fetch('/__editor_workspace?hold-read=1', { method: 'POST' }),
    );
    await settle(
      () => !!releaseHeldRead,
      'real pre-save document read is held',
    );
    await replaceDraft(initial + '// first owned save\n');
    await switched.getByRole('button', { name: 'save', exact: true }).click();
    if (pendingReply) {
      await diskUntil(
        'main.ts',
        (text) => text === initial + '// first owned save\n',
      );
      await switched
        .getByRole('button', { name: 'saving file', exact: true })
        .waitFor();
      await switched.evaluate(() =>
        fetch('/__editor_workspace?release-read=1', { method: 'POST' }),
      );
    }
    await switched.getByText('all changes saved', { exact: true }).waitFor();
    assert.equal(
      readFileSync(join(workspace, 'main.ts'), 'utf8'),
      initial + '// first owned save\n',
    );
    await replaceDraft(initial + '// next manual draft\n');
    const readsBeforeRelease = mainReads;
    if (externalChange)
      writeFileSync(
        join(workspace, 'main.ts'),
        initial + '// actual external writer\n',
      );
    if (!pendingReply) {
      await switched.evaluate(() =>
        fetch('/__editor_workspace?release-read=1', { method: 'POST' }),
      );
      await settle(
        () => mainReads > readsBeforeRelease,
        'a stale snapshot after own save must cause a fresh disk read',
      );
    }
    if (externalChange) {
      await switched
        .getByRole('button', { name: 'review disk changes', exact: true })
        .waitFor();
      assert(
        await switched
          .getByRole('button', { name: 'save', exact: true })
          .isDisabled(),
      );
      assert.equal(
        readFileSync(join(workspace, 'main.ts'), 'utf8'),
        initial + '// actual external writer\n',
      );
      await switched
        .getByRole('button', { name: 'review disk changes', exact: true })
        .click();
    } else {
      await settle(
        async () =>
          await switched
            .getByRole('button', { name: 'save', exact: true })
            .isEnabled(),
        'old own snapshot must not create a conflict',
      );
      assert.equal(
        await switched
          .getByRole('button', { name: 'review disk changes', exact: true })
          .count(),
        0,
      );
    }
    await switched.getByRole('button', { name: 'save', exact: true }).click();
    await switched.getByText('all changes saved', { exact: true }).waitFor();
    assert.equal(
      readFileSync(join(workspace, 'main.ts'), 'utf8'),
      initial + '// next manual draft\n',
    );
    await switched.evaluate(() =>
      fetch('/__editor_workspace?resume-events=1', { method: 'POST' }),
    );
    await switched.getByRole('button', { name: 'edit', exact: true }).click();
    await replaceDraft(initial);
    await switched.getByRole('button', { name: 'save', exact: true }).click();
    await switched.getByText('all changes saved', { exact: true }).waitFor();
    assert.equal(readFileSync(join(workspace, 'main.ts'), 'utf8'), initial);
  }
  console.log(
    'Delayed pre-save snapshots re-read current disk; external bytes still conflict and manual drafts survive',
  );
  // A clean buffer takes a change written while its save was in flight.
  await replaceDraft(initial + '// saved first\n');
  await switched.evaluate(() =>
    fetch('/__editor_workspace?external-during-save=1', { method: 'POST' }),
  );
  await switched.getByRole('button', { name: 'save', exact: true }).click();
  await settle(
    async () =>
      (
        await switched
          .locator('.native-code-editor .view-lines')
          .first()
          .textContent()
      )
        .replaceAll('\u00a0', ' ')
        .includes('written during the save'),
    'a clean buffer refreshes to a write made during its save',
  );
  await switched.getByText('all changes saved', { exact: true }).waitFor();
  assert.equal(
    await switched
      .getByRole('button', { name: 'review disk changes', exact: true })
      .count(),
    0,
  );
  await switched.getByRole('button', { name: 'edit', exact: true }).click();
  await replaceDraft(initial);
  await switched.getByRole('button', { name: 'save', exact: true }).click();
  await switched.getByText('all changes saved', { exact: true }).waitFor();
  assert.equal(readFileSync(join(workspace, 'main.ts'), 'utf8'), initial);
  console.log('A clean buffer refreshes to a write made during its own save');
  await appendTo('x');
  await switched.evaluate(() =>
    fetch('/__editor_workspace?touch=1', { method: 'POST' }),
  );
  await switched
    .getByText('all changes saved', { exact: true })
    .waitFor({ state: 'hidden' });
  await switched.waitForFunction(
    () =>
      !document.querySelector('.file-view footer button:last-child')?.disabled,
  );

  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text.endsWith('x'));
  await switched.keyboard.press(`${modifier}+z`);
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text === initial);
  // Another program writes the moment the second save reaches the disk.
  const mainText = () =>
    switched
      .locator('.native-code-editor .view-lines')
      .first()
      .evaluate((node) => node.textContent.replaceAll('\u00a0', ' '));
  // This fixture has no file watcher: announce writes made here.
  writeFileSync(join(workspace, 'main.ts'), initial + '// external clean\n');
  await changed([['changed', 'main.ts']]);
  await settle(
    async () => (await mainText()).includes('external clean'),
    'a clean buffer refreshes to a write made just after its save',
  );
  await switched.getByText('all changes saved', { exact: true }).waitFor();
  assert.equal(
    await switched
      .getByText('file changed on disk; your changes are kept')
      .count(),
    0,
    'no conflict is left showing once the buffer took the change',
  );
  writeFileSync(join(workspace, 'main.ts'), initial);
  await changed([['changed', 'main.ts']]);
  await settle(
    async () => !(await mainText()).includes('external clean'),
    'and to the next one',
  );
  await switched.getByText('all changes saved', { exact: true }).waitFor();
  await appendTo('// dirty file A\n');
  await switched
    .getByRole('button', { name: 'open rules', exact: true })
    .click();
  await switched.getByText('loading file', { exact: true }).waitFor();
  assert.equal(
    await switched.locator('.native-code-editor').count(),
    0,
    'pending B must not mount an A-seeded editor',
  );
  await switched
    .locator('.file-view-heading strong')
    .getByText('AGENTS.md', { exact: true })
    .waitFor();
  await switched.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('isolated project instructions'),
  );
  assert.ok(
    !(
      await switched
        .locator('.native-code-editor .view-lines')
        .first()
        .textContent()
    ).includes('import'),
  );
  await switched.getByRole('button', { name: 'edit', exact: true }).click();
  await appendTo('rules B saved\n');
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('AGENTS.md', (text) => text.includes('rules B saved'));
  await switched
    .getByRole('button', { name: 'open main', exact: true })
    .click();
  await switched.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('dirty file A'),
  );
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text.includes('dirty file A'));
  await switched.getByText('all changes saved', { exact: true }).waitFor();
  assert.doesNotMatch(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /isolated project instructions|rules B saved/,
  );
  assert.doesNotMatch(
    readFileSync(join(workspace, 'AGENTS.md'), 'utf8'),
    /import|dirty file A/,
  );
  await switched.close();
  const beforeBatch = new Map(
    ['main.ts', 'lib.ts', 'AGENTS.md'].map((path) => [
      path,
      readFileSync(join(workspace, path), 'utf8'),
    ]),
  );
  for (const locale of ['en', 'zh-CN']) {
    const batch = await browser.newPage();
    batch.on('pageerror', (error) => errors.push(error.message));
    await batch.goto(
      `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1&lang=${locale}`,
    );
    const zh = locale === 'zh-CN';
    const drafts = new Map();
    for (const [path, open] of [
      ['main.ts', 'open main'],
      ['lib.ts', 'open lib'],
      ['AGENTS.md', 'open rules'],
    ]) {
      await batch.getByRole('button', { name: open, exact: true }).click();
      await batch
        .locator('.file-view-heading strong')
        .getByText(path, { exact: true })
        .waitFor();
      await batch
        .getByRole('button', { name: zh ? '编辑' : 'edit', exact: true })
        .click();
      await batch.locator('.native-code-editor .view-lines').first().click();
      await batch.keyboard.press(`${modifier}+End`);
      const suffix = `\n// partial batch ${locale} ${path}\n`;
      await batch.keyboard.insertText(suffix);
      drafts.set(path, beforeBatch.get(path) + suffix);
    }
    // SaveAll commits A first while A is also the currently viewed document.
    await batch.getByRole('button', { name: 'open main', exact: true }).click();
    await batch
      .locator('.file-view-heading strong')
      .getByText('main.ts', { exact: true })
      .waitFor();
    await batch
      .getByText(zh ? '未保存的修改' : 'unsaved changes', { exact: true })
      .waitFor();
    batchCalls.length = 0;
    batchCommitCounts.clear();
    interruptNextBatch = true;
    const saveAll = batch.getByRole('button', {
      name: zh ? '全部保存' : 'save all',
      exact: true,
    });
    await saveAll.click();
    const summary = zh
      ? '已保存：main.ts；未保存：lib.ts, AGENTS.md'
      : 'saved: main.ts; not saved: lib.ts, AGENTS.md';
    const notice = batch
      .locator('.editor-notice[role="alert"]')
      .getByText(summary);
    await notice.waitFor();
    await batch
      .getByRole('button', {
        name: zh ? '正在保存文件' : 'saving file',
        exact: true,
      })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await batch
        .getByRole('button', {
          name: zh ? '审阅磁盘改动' : 'review disk changes',
          exact: true,
        })
        .count(),
      0,
      'the committed current document must not conflict with its own new revision',
    );
    assert.equal(
      await batch
        .getByRole('button', {
          name: zh ? '保存' : 'save',
          exact: true,
        })
        .isDisabled(),
      false,
    );
    assert.equal(
      readFileSync(join(workspace, 'main.ts'), 'utf8'),
      drafts.get('main.ts'),
    );
    assert.equal(
      readFileSync(join(workspace, 'lib.ts'), 'utf8'),
      beforeBatch.get('lib.ts'),
    );
    assert.equal(
      readFileSync(join(workspace, 'AGENTS.md'), 'utf8'),
      beforeBatch.get('AGENTS.md'),
    );
    const prefix = await documents.read('main.ts');
    // The recovery list is persistent inline content, not the transient toast.
    await batch
      .getByRole('button', { name: zh ? '差异' : 'diff', exact: true })
      .click();
    await notice.waitFor();
    await batch
      .getByRole('button', { name: zh ? '编辑' : 'edit', exact: true })
      .click();
    await saveAll.click();
    await saveAll.waitFor({ state: 'hidden' });
    await batch
      .getByText(zh ? '所有修改已保存' : 'all changes saved', {
        exact: true,
      })
      .waitFor();
    for (const [path, content] of drafts) {
      assert.equal(readFileSync(join(workspace, path), 'utf8'), content);
      assert.equal(
        batchCommitCounts.get(path),
        1,
        `${path} commits exactly once`,
      );
    }
    assert.deepEqual(batchCalls, [
      ['main.ts', 'lib.ts', 'AGENTS.md'],
      ['lib.ts', 'AGENTS.md'],
    ]);
    assert.equal((await documents.read('main.ts')).revision, prefix.revision);
    assert.equal(await notice.count(), 0);
    await batch.locator('.native-code-editor .view-lines').first().click();
    await batch.keyboard.press(`${modifier}+End`);
    await batch.keyboard.insertText('// unsaved after partial batch\n');
    const external = `// real external write after partial ${locale}\n`;
    writeFileSync(join(workspace, 'main.ts'), external);
    // No watcher notification: the real save must still reject the stale CAS.
    await batch.keyboard.press(`${modifier}+s`);
    await batch
      .getByRole('button', {
        name: zh ? '审阅磁盘改动' : 'review disk changes',
        exact: true,
      })
      .waitFor();
    assert.equal(readFileSync(join(workspace, 'main.ts'), 'utf8'), external);
    assert.match(
      (
        await batch
          .locator('.native-code-editor .view-lines')
          .first()
          .textContent()
      ).replaceAll('\u00a0', ' '),
      /unsaved after partial batch/,
    );
    assert.equal(batchCommitCounts.get('main.ts'), 1);
    await batch.close();
    for (const [path, content] of beforeBatch)
      writeFileSync(join(workspace, path), content);
    await changed([...beforeBatch.keys()].map((path) => ['changed', path]));
  }
  console.log(
    'Partial SaveAll keeps bilingual inline recovery paths; retry writes only remaining dirty files and preserves the committed prefix revision',
  );
  writeFileSync(join(workspace, 'main.ts'), initial);
  writeFileSync(join(workspace, 'AGENTS.md'), rules);
  await changed([
    ['changed', 'main.ts'],
    ['changed', 'AGENTS.md'],
  ]);
  const viewer = await browser.newPage();
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1`,
  );
  await viewer.getByRole('button', { name: 'edit', exact: true }).click();
  await viewer
    .getByRole('button', { name: 'external write', exact: true })
    .click();
  await viewer.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('external write 1'),
  );
  await viewer.getByText('all changes saved', { exact: true }).waitFor();
  await viewer.locator('.view-lines').first().click();
  await viewer.keyboard.press(`${modifier}+End`);
  await viewer.keyboard.type('// human draft');
  await viewer
    .getByRole('button', { name: 'external write', exact: true })
    .click();
  await viewer
    .getByText('file changed on disk; your changes are kept', { exact: true })
    .waitFor();
  await viewer
    .getByRole('button', { name: 'review disk changes', exact: true })
    .waitFor();
  assert.match(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /external write/,
  );
  assert.doesNotMatch(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /human draft/,
  );
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR) {
    mkdirSync(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, { recursive: true });
    await viewer.screenshot({
      path: join(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, 'editor-conflict.png'),
    });
  }
  await viewer
    .getByRole('button', { name: 'review disk changes', exact: true })
    .click();
  await viewer.locator('.monaco-diff-editor').waitFor();
  await viewer.getByRole('button', { name: 'save', exact: true }).click();
  await viewer.getByText('all changes saved', { exact: true }).waitFor();
  assert.match(readFileSync(join(workspace, 'main.ts'), 'utf8'), /human draft/);
  await viewer
    .getByRole('button', { name: 'external rename', exact: true })
    .click();
  await viewer
    .getByRole('button', {
      name: 'open possible moved file: moved.ts',
      exact: true,
    })
    .click();
  await viewer
    .locator('.file-view-heading strong')
    .getByText('moved.ts', { exact: true })
    .waitFor();
  await viewer.getByRole('button', { name: 'edit', exact: true }).click();
  await viewer.locator('.view-lines').first().click();
  await viewer.keyboard.press(`${modifier}+End`);
  await viewer.keyboard.type('// recovered deleted draft');
  await viewer
    .getByRole('button', { name: 'external delete', exact: true })
    .click();
  await viewer
    .getByText('file deleted on disk; your changes are kept', { exact: true })
    .waitFor();
  assert.equal(existsSync(join(workspace, 'moved.ts')), false);
  await viewer
    .getByRole('button', {
      name: 'restore file with your changes',
      exact: true,
    })
    .click();
  await viewer.getByText('all changes saved', { exact: true }).waitFor();
  assert.match(
    readFileSync(join(workspace, 'moved.ts'), 'utf8'),
    /recovered deleted draft/,
  );
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR)
    await viewer.screenshot({
      path: join(
        process.env.CIRCLE_EDITOR_EVIDENCE_DIR,
        'editor-recovered.png',
      ),
    });
  await viewer
    .getByRole('button', { name: 'break project config', exact: true })
    .click();
  await viewer.locator('.editor-project-diagnostics > summary').waitFor();
  assert.equal(
    await viewer.locator('.editor-project-diagnostics').getAttribute('open'),
    null,
  );
  await viewer.locator('.editor-project-diagnostics > summary').click();
  await viewer
    .getByRole('button', { name: 'tsconfig.json', exact: true })
    .first()
    .click();
  await viewer
    .locator('.file-view-heading strong')
    .getByText('tsconfig.json', { exact: true })
    .waitFor();
  await viewer
    .getByRole('button', { name: 'fix project config', exact: true })
    .click();
  await viewer
    .locator('.editor-project-diagnostics > summary')
    .getByText('code checks', { exact: true })
    .waitFor();
  assert.equal(
    await viewer.locator('.editor-project-diagnostics').getAttribute('role'),
    null,
  );
  await viewer.getByText('typescript · running', { exact: true }).waitFor();
  assert.equal(
    await viewer.getByRole('button', { name: 'stop', exact: true }).count(),
    0,
  );
  assert.equal(await viewer.getByText(/^process id:/).count(), 0);
  const refreshes = languageControls.filter(
    (row) => row.method === 'restart',
  ).length;
  await viewer.getByRole('button', { name: 'refresh', exact: true }).click();
  await viewer.waitForFunction(
    () =>
      document
        .querySelector(
          '.editor-project-diagnostics [aria-label="code checks status"]',
        )
        ?.getAttribute('aria-busy') === 'false',
  );
  assert.equal(
    languageControls.filter((row) => row.method === 'restart').length,
    refreshes + 1,
  );
  assert.equal(languageControls.at(-1).path, 'tsconfig.json');
  await viewer.locator('.editor-project-diagnostics > summary').click();
  await viewer.waitForTimeout(1100);
  const controlsWhileClosed = languageControls.length;
  await viewer.waitForTimeout(1100);
  assert.equal(
    languageControls.length,
    controlsWhileClosed,
    'closed details do not poll language status',
  );
  await viewer.close();
  assert.deepEqual(errors, []);
  console.log(
    'Monaco input/Undo/Redo/save/diff/remount/themes/draft recovery, live menu locale, clean/dirty watcher, move/delete recovery passed; document backend: ' +
      (documents ? 'WorkspaceDocuments' : 'standalone fixture adapter'),
  );
} catch (error) {
  console.error(
    'language project at failure',
    await language.call('fixture', 'language', 'request', {
      method: 'project',
    }),
  );
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      console.error(
        'page alerts',
        await page.locator('[role=alert]').allTextContents(),
      );
  throw error;
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await server.close();
  documents?.close();
  await language.dispose();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(languageData, { recursive: true, force: true });
}
