import {
  startNativePerformanceCpuProfile,
  stopNativePerformanceCpuProfile,
  captureNativeReadingTrace,
  executedRendererArtifactEvidence,
} from './helpers/native-performance-cpu-profile.mjs';
import {
  installRendererPerformanceDiagnostics,
  installMainPerformanceDiagnostics,
  writePerformanceEvidence,
  readWorkerPerformanceDiagnostics,
} from './helpers/native-performance-diagnostics.mjs';
/** Run serially after build, in both development and packaged app paths.
 * node --import tsx apps/desktop/test/native-performance.mjs
 * Uses real Electron, persisted history, eight scripted streaming AgentRuntimes,
 * native PTY and disk effects. No live model, production account or fake UI state.
 */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  preserveNativeClipboard,
  restoreNativeClipboardWithRecovery,
} from './helpers/native-clipboard.mjs';
import {
  performanceMessages,
  PERFORMANCE_RAW_MESSAGES,
  PERFORMANCE_PROJECTED_MESSAGES,
} from './helpers/native-performance-fixture.mjs';
import {
  executedNativeBuildEvidence,
  verifyNativeBuildManifest,
} from './helpers/native-build-manifest.mjs';
import {
  terminalAxDiagnosticRequired,
  appendNativeEditorText,
  captureNativeEditorInput,
  armNativeFeedback,
  captureNativeTranscriptAnchor,
  terminalObservationRows,
  terminalVisibilityCohorts,
} from './helpers/native-performance-observation.mjs';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { sourceEvidence } from './helpers/evidence.mjs';
import {
  journeyBundledNodeFromApp,
  assertBundledJourneyNode,
  journeyNodeCommand,
} from './helpers/native-journey-platform.mjs';
import { patience } from './helpers/patience.mjs';
const exec = promisify(execFile);
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-performance-'));
const outputBase = resolve(
  process.env.CIRCLE_NATIVE_PERF_OUTPUT ?? join(temp, 'evidence'),
);
const output = join(
  outputBase,
  `attempt-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`,
);
await mkdir(output, { recursive: true });
const workspace = join(temp, 'workspace');
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
await mkdir(workspace);
await mkdir(home, { recursive: true });
const mainSession = 'perf-history';
const otherSession = 'perf-alternate';
const pngBytes = await readFile(
  new URL('./fixtures/performance-original.png', import.meta.url),
);
const png = pngBytes.toString('base64');
const log = Array.from(
  { length: 600 },
  (_, index) =>
    `PERF_LOG_${String(index + 1).padStart(4, '0')} ${'complete original '.repeat(6)}`,
).join('\n');
await writeFile(
  join(workspace, 'README.md'),
  '# PERF_README\n\nperformance source\n',
);
await writeFile(
  join(workspace, 'SECOND.md'),
  '# PERF_SECOND\n\nalternate source\n',
);
await writeFile(
  join(workspace, 'pty-log.cjs'),
  'let n=0;setInterval(()=>console.log("NATIVE_PERF "+Date.now()+" "+n++),50);',
);
await exec('git', ['init', workspace]);
await exec('git', [
  '-C',
  workspace,
  'add',
  'README.md',
  'SECOND.md',
  'pty-log.cjs',
]);
await exec('git', [
  '-C',
  workspace,
  '-c',
  'user.name=Circle test',
  '-c',
  'user.email=circle-test@example.invalid',
  'commit',
  '-m',
  'Create isolated performance fixture',
]);
const settings = trustFolder(defaultSettings(), workspace);
settings.workspace_folder = workspace;
saveSettings(settings, home);
const store = new CheckpointStore(home);
store.create(workspace, 'fixture', 'performance alternate', otherSession);
store.append(otherSession, [
  {
    id: 'alternate-answer',
    role: 'assistant',
    content: 'PERF_ALTERNATE_READY',
  },
]);
store.create(workspace, 'fixture', 'performance history', mainSession);
const messages = performanceMessages({ png, log });
store.append(mainSession, messages);
assert.equal(store.messages(mainSession).length, PERFORMANCE_RAW_MESSAGES);
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId: mainSession }),
);
const fixture = join(temp, 'model.json');
await writeFile(
  fixture,
  JSON.stringify({
    replies: Array.from({ length: 8 }, (_, agent) => ({
      chunks: Array.from(
        { length: 24000 },
        (_, index) => `agent ${agent} progress ${index} `,
      ),
      delayMs: 40,
      message: {
        id: `stream-${agent}`,
        role: 'assistant',
        content: 'performance stream completed',
      },
    })),
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron');
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? desktopRoot);
const samples = {
  inputKeystroke: [],
  inputPaste: [],
  inputClear: [],
  click: [],
  sessionSwitch: [],
  fileSwitch: [],
  save: [],
  eventToFrame: [],
};
const errors = [];
const checks = [];
let app;
let page;
let terminalId;
let taskIds = [];
let clipboardBefore;
let cpuProfile;
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  temp,
  workspace,
  executable,
  appPath,
  workload: {
    persistedMessages: PERFORMANCE_RAW_MESSAGES,
    projectedMessages: PERFORMANCE_PROJECTED_MESSAGES,
    activeStreamingAgents: 8,
    agentChunkIntervalMs: 40,
    ptyIntervalMs: 50,
  },
  fixtureImage: {
    sha256: createHash('sha256').update(pngBytes).digest('hex'),
    bytes: pngBytes.length,
    source: 'synthetic native browser capture, development-attempt12, 375x812',
  },
  samples,
  checks,
  errors,
  metrics: {},
  complete: false,
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
};
async function state() {
  return (await page.evaluate(() => window.circleDesktop.runtimeState()))
    .snapshot;
}
async function call(name, payload = {}, sessionId = mainSession) {
  const reply = await page.evaluate(
    async (input) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        ...input,
      }),
    { name, payload, sessionId },
  );
  if (!reply.ok) throw Error(reply.error);
  return reply.data;
}
const service = (name, method, params = {}, sessionId = mainSession) =>
  call('workspace-service', { service: name, method, params }, sessionId);
async function waitFor(test, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 30));
  }
}
async function arm(kind, selector, condition) {
  await page.evaluate(armNativeFeedback, { kind, selector, condition });
}
async function finish(metric) {
  const value = await page.evaluate(() => window.__circleNativePerfPending);
  assert.ok(Number.isFinite(value));
  samples[metric].push(value);
}
try {
  app = await electron.launch({
    executablePath: executable,
    args: [appPath],
    cwd: desktopRoot,
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.bringToFront();
  if (process.env.CIRCLE_NATIVE_PERF_CPU_PROFILE === '1') {
    cpuProfile = await startNativePerformanceCpuProfile(page, report);
    await page.evaluate(() => {
      window.__circleNativeReadingUnsubscribe = window.circleDesktop.onRuntime(
        (update) => {
          window.__circleNativeReadingBackend =
            update.snapshot?.activeSessionId;
        },
      );
    });
    report.readingTrace = [];
  }
  if (process.env.CIRCLE_NATIVE_PERF_DIAGNOSTICS === '1') {
    await app.evaluate(installMainPerformanceDiagnostics);
    await page.evaluate(installRendererPerformanceDiagnostics, {
      limit: 20000,
    });
  }
  report.driverHead = (
    await exec('git', ['-C', desktopRoot, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const manifestPath = process.env.CIRCLE_NATIVE_PERF_BUILD_MANIFEST;
  if (!manifestPath)
    throw Error(
      'CIRCLE_NATIVE_PERF_BUILD_MANIFEST is required before clipboard or stress actions',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  report.executedBuild = verifyNativeBuildManifest(
    manifest,
    await executedNativeBuildEvidence(app, manifest),
  );
  report.sourceBuildHead = report.executedBuild.sourceBuildHead;
  report.buildManifestPath = manifestPath;
  report.source = await sourceEvidence();
  report.renderer = executedRendererArtifactEvidence(report.executedBuild);
  report.rendererEvidenceSource =
    'actual owned application artifacts already hash-verified against frozen manifest; never driver checkout dist';
  report.appInfo = await page.evaluate(() => window.circleDesktop.info());
  await waitFor(
    async () => {
      const snapshot = await state();
      return (
        snapshot.runtime?.connected &&
        snapshot.activeSessionId === mainSession &&
        snapshot.sessions.find((s) => s.id === mainSession)?.messages.length ===
          PERFORMANCE_PROJECTED_MESSAGES
      );
    },
    '10k history loaded',
    60000,
  );
  report.initialTranscript = await page
    .locator('.transcript')
    .evaluate((node) => {
      const frame = node.getBoundingClientRect();
      const messages = [...node.querySelectorAll('.message')];
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        mountedMessages: messages.length,
        visibleMessages: messages.filter((message) => {
          const rect = message.getBoundingClientRect();
          return (
            rect.height > 0 &&
            rect.bottom > frame.top &&
            rect.top < frame.bottom
          );
        }).length,
        firstMessageRect: messages[0]?.getBoundingClientRect().toJSON(),
      };
    });
  await page.screenshot({ path: join(output, 'initial-transcript.png') });
  report.initialTranscriptPassed = report.initialTranscript.visibleMessages > 0;
  if (!report.initialTranscriptPassed)
    report.initialTranscriptFailure =
      '10k history loaded with no mounted message intersecting the visible transcript; later scrolling is an explicit stress setup, not recovery acceptance';
  report.stressSetup =
    'explicitly navigate transcript top then bottom to reveal the tail of virtualized history';
  await page.locator('.transcript').evaluate(async (node) => {
    node.scrollTo({ top: 0 });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    node.scrollTo({ top: node.scrollHeight });
  });
  await page
    .locator('.transcript')
    .getByText('PERF_HISTORY_READY', { exact: false })
    .waitFor();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  clipboardBefore = await preserveNativeClipboard(app);
  if (process.env.CIRCLE_NATIVE_PERF_PROBE_ONLY === '1') {
    await page.evaluate(() => {
      window.__circleNativePerfTerminalTiming = [];
      window.__circleNativeTerminalTiming = (record) =>
        window.__circleNativePerfTerminalTiming.push(record);
    });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await page
      .locator('#inspector-terminal-terminal')
      .waitFor({ state: 'visible' });
    await page
      .locator('#inspector-terminal-terminal button[aria-label="new terminal"]')
      .click();
    await page
      .locator('#inspector-terminal-terminal .xterm-screen')
      .first()
      .waitFor({ state: 'visible' });
    terminalId = (await service('terminal', 'list'))[0].id;
    const identity = await app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }));
    const probeNode = journeyBundledNodeFromApp(identity);
    await assertBundledJourneyNode(probeNode);
    const probeSource = join(workspace, 'terminal-observation-probe.cjs');
    await writeFile(
      probeSource,
      'console.log("NATIVE_PERF "+Date.now()+" 999");',
    );
    await service('terminal', 'write', {
      id: terminalId,
      data: journeyNodeCommand(probeNode, probeSource),
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.xterm-accessibility-tree')].some((node) =>
        node.textContent.includes('NATIVE_PERF'),
      ),
    );
    await page.waitForFunction(() =>
      window.__circleNativePerfTerminalTiming.some(
        (row) => row.phase === 'write-frame',
      ),
    );
    const probeReplay = await service('terminal', 'replay', {
      id: terminalId,
      afterSequence: 0,
      limit: 1000,
    });
    const probeEvent = probeReplay.events.find(
      (event) =>
        event.kind === 'data' &&
        /NATIVE_PERF\s+\d{13}\s+999/.test(event.data ?? ''),
    );
    assert.ok(probeEvent, 'probe raw record contains actual producer output');
    await page.waitForFunction(
      ({ id, seq }) =>
        window.__circleNativePerfTerminalTiming.some(
          (row) =>
            row.terminalId === id &&
            row.eventSequence === seq &&
            row.phase === 'write-frame',
        ),
      { id: terminalId, seq: probeEvent.sequence },
    );
    report.probeTerminalStages = terminalObservationRows(
      probeReplay.events,
      await page.evaluate(() => window.__circleNativePerfTerminalTiming),
      [],
    );
    assert.ok(
      report.probeTerminalStages.some(
        (row) => Number.isFinite(row.parsedAt) && Number.isFinite(row.frameAt),
      ),
      'probe producer record joins actual parser and frame callbacks',
    );
    report.originalEntryProbe = await page.evaluate(async () => {
      await document.fonts.ready;
      const screen = document.querySelector(
        '#inspector-terminal-terminal .xterm-screen',
      );
      const rows = window.__circleNativePerfTerminalTiming;
      return {
        inspectorVisible: screen.getBoundingClientRect().width > 0,
        screenWidth: screen.getBoundingClientRect().width,
        screenHeight: screen.getBoundingClientRect().height,
        fontStatus: document.fonts.status,
        fontFamily: getComputedStyle(document.querySelector('.xterm'))
          .fontFamily,
        phases: [...new Set(rows.map((row) => row.phase))],
      };
    });
    assert.ok(report.originalEntryProbe.inspectorVisible);
    assert.ok(report.originalEntryProbe.phases.includes('write-parsed'));
    await page.screenshot({ path: join(output, 'original-entry-probe.png') });
    throw Error(
      'native performance probe requested stop after original inspector and parser verification',
    );
  }
  taskIds = Array.from(
    { length: 8 },
    (_, index) => `performance-agent-${index}`,
  );
  await service('tasks', 'settings', {
    limits: { agents: 8, builds: 2, ui: 1, browsers: 1 },
  });
  await service('tasks', 'enqueue', {
    operationId: crypto.randomUUID(),
    tasks: taskIds.map((id) => ({
      id,
      prompt:
        'Stream deterministic progress while the developer edits. Do not change files.',
      access: 'readonly',
      acceptanceCriteria: ['maintain the read-only baseline'],
      dependencies: [],
    })),
  });
  await service('tasks', 'start');
  await waitFor(
    async () => {
      const tasks = await service('tasks', 'list');
      return taskIds.every((id) =>
        tasks.some((task) => task.spec.id === id && task.state === 'running'),
      );
    },
    'eight actual running task attempts',
    60000,
  );
  assert.equal(
    (await state()).activeSessionId,
    mainSession,
    'background task startup must retain the developer conversation',
  );
  await page.evaluate(() => {
    window.__circleNativePerfTerminalTiming = [];
    window.__circleNativeTerminalTiming = (record) => {
      if (window.__circleNativePerfTerminalTiming.length >= 50000) {
        window.__circleNativePerfTimingOverflow = true;
        return;
      }
      window.__circleNativePerfTerminalTiming.push(record);
    };
  });
  await page
    .getByRole('button', { name: 'terminal panel', exact: true })
    .first()
    .click();
  await page
    .locator('#inspector-terminal-terminal button[aria-label="new terminal"]')
    .click();
  await page.locator('#inspector-terminal-terminal .xterm').first().waitFor();
  const terminals = await service('terminal', 'list');
  terminalId = terminals[0].id;
  const appIdentity = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }));
  const bundledNode = journeyBundledNodeFromApp(appIdentity);
  report.producerRuntime = await assertBundledJourneyNode(bundledNode);
  await service('terminal', 'write', {
    id: terminalId,
    data: journeyNodeCommand(bundledNode, join(workspace, 'pty-log.cjs')),
  });
  await page.evaluate(() => {
    window.__circleNativePerfEvents = [];
    const seen = new Set();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scheduled = false;
          const text = [
            ...document.querySelectorAll('.xterm-accessibility-tree'),
          ]
            .map((node) => node.textContent)
            .join('\n');
          for (const match of text.matchAll(
            /NATIVE_PERF\s+(\d{13})\s+(\d+)/g,
          )) {
            const id = match[1] + ':' + match[2];
            if (seen.has(id)) continue;
            seen.add(id);
            window.__circleNativePerfEvents.push({
              sourceAt: Number(match[1]),
              sampleAt: Date.now(),
              ms: Date.now() - Number(match[1]),
            });
          }
        }),
      );
    });
    observer.observe(document.querySelector('.xterm') ?? document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__circleNativePerfObserver = observer;
  });
  const input = page.getByRole('textbox', { name: 'message', exact: true });
  // Empty/nonempty transitions require React-derived Send state, not only
  // the browser's native textarea value. Keystrokes and whole-input paste
  // updates are reported separately; neither waits for a model request.
  await input.fill('');
  await page
    .getByRole('button', { name: 'send message', exact: true })
    .waitFor();
  for (let index = 0; index < 40; index++) {
    const value = index % 2 ? '' : 'x';
    await arm('input', 'textarea[aria-label="message"]', {
      selector: 'textarea[aria-label="message"]',
      value,
      feedback: {
        selector: 'button[aria-label="send message"]',
        disabled: !value,
      },
    });
    await input.press(index % 2 ? 'Backspace' : 'x');
    await finish('inputKeystroke');
  }
  const longPaste = Array.from(
    { length: 600 },
    (_, line) => `full pasted line ${line} ${'developer input '.repeat(4)}`,
  ).join('\n');
  report.inputWorkloads = {
    keystrokes: 40,
    clipboardPastes: 20,
    keyboardClears: 20,
    longPasteLines: 600,
    longPasteCharacters: longPaste.length,
    method:
      'actual system clipboard paste; original bulk .fill failures remain separate engineering diagnostics, not product optimization evidence',
  };
  const localView = (initial = false) =>
    page.evaluate(
      ({ id, initial }) => {
        const entry = JSON.parse(
          localStorage.getItem('circle.workbench.live.views.v1') ?? 'null',
        )?.views?.find(([key]) => key === id)?.[1];
        if (
          !entry ||
          (!Array.isArray(entry.attachments) &&
            !(initial && entry.attachments === undefined))
        )
          throw Error('actual composer view is unavailable');
        return {
          draft: entry.draft ?? '',
          attachments: entry.attachments ?? [],
        };
      },
      { id: mainSession, initial },
    );
  const initialPasteView = await localView(true);
  assert.equal(initialPasteView.draft, '');
  const originalAttachments = initialPasteView.attachments;
  assert.equal(
    await page.locator('.attachment-strip .file-chip').count(),
    originalAttachments.length,
    'initial local attachment view matches actual composer',
  );
  const marker = `[pasted text ${originalAttachments.filter((file) => file.kind === 'paste').length + 1} · 600 lines]`;
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  report.nativePasteObservations = [];
  let pasted;
  for (let index = 0; index < 40; index++) {
    if (index % 2 === 0) {
      await app.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        longPaste,
      );
      await arm('paste', 'textarea[aria-label="message"]', {
        selector: 'textarea[aria-label="message"]',
        value: marker,
        clipboardText: longPaste,
        clipboardAttachment: marker,
        feedback: {
          selector: 'button[aria-label="send message"]',
          disabled: false,
        },
      });
      await input.press(`${modifier}+v`);
      await finish('inputPaste');
      const observation = await page.evaluate(
        () => window.__circleNativePerfClipboardObservation,
      );
      assert.deepEqual(observation, {
        trusted: true,
        exact: true,
        characters: longPaste.length,
      });
      report.nativePasteObservations.push(observation);
      const view = await localView();
      assert.equal(view.draft, marker);
      const added = view.attachments.filter(
        (file) =>
          !originalAttachments.some((original) => original.id === file.id),
      );
      assert.equal(
        added.length,
        1,
        'each actual paste adds exactly one attachment',
      );
      pasted = added[0];
      assert.equal(pasted.kind, 'paste');
      assert.equal(pasted.name, marker);
      assert.equal(pasted.content, longPaste);
      assert.deepEqual(
        view.attachments.filter((file) => file.id !== pasted.id),
        originalAttachments,
      );
      if (index === 0) {
        await page
          .locator('.attachment-strip')
          .getByRole('button', { name: marker, exact: true })
          .click();
        const source = page
          .locator('.inspector .context-source')
          .filter({ has: page.locator('summary', { hasText: marker }) });
        if (!(await source.evaluate((node) => node.open)))
          await source.locator(':scope > summary').click();
        assert.equal(
          await source.locator(':scope > pre').textContent(),
          longPaste,
          'original UI exposes all600lines exactly',
        );
        await page
          .getByRole('button', { name: 'terminal panel', exact: true })
          .click();
      }
    } else {
      assert.equal(
        await input.inputValue(),
        marker,
        'clear starts from a nonempty actual pasted draft',
      );
      await page
        .locator('.attachment-strip')
        .getByRole('button', { name: `remove ${pasted.name}`, exact: true })
        .click();
      await input.press(`${modifier}+a`);
      await arm('keydown', 'textarea[aria-label="message"]', {
        selector: 'textarea[aria-label="message"]',
        value: '',
        feedback: {
          selector: 'button[aria-label="send message"]',
          disabled: originalAttachments.length === 0,
        },
      });
      await input.press('Backspace');
      await finish('inputClear');
      const restored = await localView();
      assert.equal(restored.draft, '');
      assert.deepEqual(
        restored.attachments,
        originalAttachments,
        'clear removes only this iteration attachment and preserves initial context',
      );
    }
  }
  checks.push(
    '20 trusted native clipboard pastes retain exact600line originals and20 keyboard clears restore composer context',
  );
  report.interfaceScope =
    'original topbar panels, inspector and main file view; no dual layout';
  await input.fill('retained developer draft');
  await input.evaluate((node) => {
    node.focus();
    node.setSelectionRange(3, 10);
  });
  const panelAnchor = await page.evaluate(captureNativeTranscriptAnchor);
  for (let index = 0; index < 40; index++) {
    const open = index % 2 === 1;
    await arm('click', 'button[aria-label="terminal panel"]', {
      selector: 'button[aria-label="terminal panel"]',
      attribute: 'aria-pressed',
      equals: String(open),
      panel: { selector: '#inspector-terminal-terminal', visible: open },
    });
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    await finish('click');
    if (open) {
      const restored = await page.evaluate(captureNativeTranscriptAnchor);
      assert.equal(
        restored.id,
        panelAnchor.id,
        'original panel roundtrip retains visible message identity',
      );
      assert.ok(
        Math.abs(restored.offset - panelAnchor.offset) <= 2,
        'original panel roundtrip retains reading anchor',
      );
    }
  }
  assert.deepEqual(
    await input.evaluate((node) => ({
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
    })),
    { value: 'retained developer draft', start: 3, end: 10 },
  );
  checks.push(
    'original terminal panel roundtrips retain draft, selection and reading anchor',
  );

  // Explicit steady-visible window: panel toggle recovery is a separate cohort.
  await page.waitForTimeout(2000);
  const nativeAccessibility = await page.evaluate(async () =>
    window.circleDesktop.nativeAccessibility
      ? await window.circleDesktop.nativeAccessibility()
      : null,
  );
  const axRequired = terminalAxDiagnosticRequired(nativeAccessibility);
  report.accessibilityDiagnostic = {
    actualHost: nativeAccessibility,
    preference: await page.evaluate(
      () => localStorage.getItem('circle-terminal-accessibility') ?? 'auto',
    ),
    status: axRequired ? 'coverage-required' : 'not-active',
  };
  // A user preference can keep AX active even when native detection is off.
  const requireAx =
    axRequired || report.accessibilityDiagnostic.preference === 'always';
  report.accessibilityDiagnostic.status = requireAx
    ? 'coverage-required'
    : 'not-active';
  if (requireAx)
    await waitFor(
      async () =>
        await page.evaluate(() => window.__circleNativePerfEvents.length >= 60),
      '60 accessibility diagnostic observations',
      20000,
    );
  await waitFor(
    async () =>
      await page.evaluate(
        () =>
          window.__circleNativePerfTerminalTiming.filter(
            (row) => row.phase === 'write-frame',
          ).length >= 20,
      ),
    '20 actual xterm parser/frame observations',
    20000,
  );
  const events = await page.evaluate(() => {
    window.__circleNativePerfObserver.disconnect();
    return window.__circleNativePerfEvents;
  });
  report.eventRaw = events;
  report.terminalTiming = await page.evaluate(
    () => window.__circleNativePerfTerminalTiming,
  );
  const rawEvents = [];
  let rawCursor = 0;
  const rawBoundary = (await service('terminal', 'list')).find(
    (item) => item.id === terminalId,
  ).lastSequence;
  while (rawCursor < rawBoundary) {
    const rawPage = await service('terminal', 'replay', {
      id: terminalId,
      afterSequence: rawCursor,
      limit: 1000,
    });
    assert.ok(rawPage.nextSequence > rawCursor, 'raw replay cursor advances');
    rawEvents.push(
      ...rawPage.events.filter((event) => event.sequence <= rawBoundary),
    );
    rawCursor = rawPage.nextSequence;
  }
  assert.equal(
    await page.evaluate(() => Boolean(window.__circleNativePerfTimingOverflow)),
    false,
    'timing evidence buffer must not overflow',
  );
  report.terminalEventStages = terminalObservationRows(
    rawEvents,
    report.terminalTiming,
    events,
  );
  report.eventMeasurement =
    'producer→runtime TerminalEvent.at; actual UI replay response→xterm.write callback parse→two RAF while visible; AX is a separate diagnostic. Raw replay below is only evidence mapping, not a substitute for product parser timestamps.';
  report.eventMixedVisibilityRaw = report.terminalEventStages.slice(10);
  report.eventVisibilityCohorts = terminalVisibilityCohorts(
    report.eventMixedVisibilityRaw,
    report.terminalTiming,
  );
  report.eventHiddenRecovery = report.eventVisibilityCohorts.filter(
    (row) => row.visibilityCohort === 'hidden-recovery',
  );
  samples.eventToFrame.push(
    ...report.eventVisibilityCohorts
      .filter((row) => row.visibilityCohort === 'continuously-visible')
      .map((row) => row.producerToFrameMs),
  );
  report.eventAxDiagnostic = events.slice(10).map((row) => row.ms);
  assert.ok(
    samples.eventToFrame.length >= 20,
    'actual visible xterm write/frame instrumentation required; AX does not substitute',
  );
  const switchSession = async (title) => {
    await input.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+Shift+p',
    );
    await page
      .getByRole('textbox', { name: 'global search', exact: true })
      .fill(title);
    const result = page
      .locator('.search-results button')
      .filter({ hasText: title })
      .first();
    await result.evaluate((node) => (node.dataset.perfTarget = 'switch'));
    await arm('click', '[data-perf-target="switch"]', {
      session: {
        id: title === 'performance history' ? mainSession : otherSession,
        title,
        content:
          title === 'performance history'
            ? 'persisted history'
            : 'PERF_ALTERNATE_READY',
      },
    });
    await result.click();
    await finish('sessionSwitch');
  };
  const sessionAnchor = await page.evaluate(captureNativeTranscriptAnchor);
  if (report.readingTrace) {
    report.sessionAnchor = sessionAnchor;
    report.readingTrace.push(
      await page.evaluate(captureNativeReadingTrace, {
        phase: 'before-session-loop',
        capturedAnchor: sessionAnchor,
      }),
    );
  }
  for (let index = 0; index < 24; index++) {
    if (report.readingTrace)
      report.readingTrace.push(
        await page.evaluate(captureNativeReadingTrace, {
          phase: 'before-switch-' + index,
          expected: index % 2 ? mainSession : otherSession,
        }),
      );
    await switchSession(
      index % 2 ? 'performance history' : 'performance alternate',
    );
    if (index % 2) {
      const restored = await page.evaluate(captureNativeTranscriptAnchor);
      if (report.readingTrace)
        report.readingTrace.push(
          await page.evaluate(captureNativeReadingTrace, {
            phase: 'after-switch-' + index,
            capturedAnchor: restored,
          }),
        );
      assert.equal(
        restored.id,
        sessionAnchor.id,
        'session return retains reading message',
      );
      assert.ok(
        Math.abs(restored.offset - sessionAnchor.offset) <= 2,
        'session return retains reading offset',
      );
    } else if (report.readingTrace)
      report.readingTrace.push(
        await page.evaluate(captureNativeReadingTrace, {
          phase: 'after-switch-' + index,
        }),
      );
  }
  checks.push(
    'session feedback binds backend identity, route, header and visible body; reading anchor checked separately',
  );
  await page
    .locator('.transcript')
    .evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  const sourceSnapshot = await state();
  const sourceSession = sourceSnapshot.sessions.find(
    (item) => item.id === mainSession,
  );
  const sourceDirectory = sourceSnapshot.workspaces.find(
    (item) => item.id === sourceSession.workspaceId,
  )?.path;
  assert.ok(
    sourceDirectory,
    'file metrics require actual parent workspace identity',
  );
  const openSource = async (name, marker) => {
    if (
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .count()
    )
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
    const link = page.locator(`.transcript:visible a[href="${name}#L1"]`);
    await arm('click', `.transcript a[href="${name}#L1"]`, {
      selector: '.monaco-editor .view-lines',
      file: { path: name, sourceDirectory },
      text: marker,
    });
    await link.click();
    await finish('fileSwitch');
  };
  for (let index = 0; index < 24; index++)
    await openSource(
      index % 2 ? 'README.md' : 'SECOND.md',
      index % 2 ? 'PERF_README' : 'PERF_SECOND',
    );
  const activeFile = page.locator('.file-view:visible');
  assert.equal(
    await activeFile.locator('.file-view-filename strong').textContent(),
    'README.md',
  );
  await activeFile.getByRole('button', { name: 'edit', exact: true }).click();
  await activeFile.locator('.monaco-editor:visible .view-lines').waitFor();
  report.editorInputDiagnostics = [];
  for (let index = 0; index < 24; index++) {
    report.editorInputDiagnostics.push(
      await page.evaluate(captureNativeEditorInput, `before-input-${index}`),
    );
    await appendNativeEditorText(
      page,
      activeFile,
      `saved performance ${index}`,
    );
    report.editorInputDiagnostics.push(
      await page.evaluate(captureNativeEditorInput, `after-input-${index}`),
    );
    await waitFor(
      async () =>
        await page
          .locator('.file-view:visible .file-view-toolbar')
          .textContent()
          .then((text) => text.includes('unsaved changes')),
      'unsaved editor buffer',
    );
    const save = activeFile.getByRole('button', {
      name: 'save',
      exact: true,
    });
    await save.evaluate((node) => (node.dataset.perfTarget = 'save'));
    await arm('click', '[data-perf-target="save"]', {
      selector: '.file-view-toolbar',
      file: { path: 'README.md', sourceDirectory },
      text: 'all changes saved',
    });
    await save.click();
    await finish('save');
    assert.ok(
      (await readFile(join(workspace, 'README.md'), 'utf8')).includes(
        `saved performance ${index}`,
      ),
    );
  }
  checks.push(
    'each save completed a real disk write while eight agents stream',
  );
  await page.getByRole('button', { name: 'close file', exact: true }).click();
  const originalImage = page.getByRole('button', {
    name: 'performance-original.png',
    exact: true,
  });
  // Scroll the real viewport, not an overscanned virtual row that can unmount
  // while Playwright is preparing an element-level scroll operation.
  await page
    .locator('.transcript:visible')
    .evaluate((node) =>
      node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }),
    );
  await originalImage.waitFor({ state: 'visible' });
  // Layout-visible overscan rows are not yet a usable target after reopening.
  // Wait for the actual viewport, using the driver's existing readiness deadline.
  await waitFor(
    () =>
      page.evaluate(() => {
        const transcript = document.querySelector('.transcript');
        const button = [...(transcript?.querySelectorAll('button') ?? [])].find(
          (node) => node.textContent.trim() === 'performance-original.png',
        );
        if (!transcript || !button || transcript.closest('[hidden]'))
          return false;
        const viewport = transcript.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= viewport.top &&
          rect.bottom <= viewport.bottom &&
          rect.left >= viewport.left &&
          rect.right <= viewport.right
        );
      }),
    'historical image is inside the restored transcript viewport',
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const imagePreparation = await page.evaluate(async () => {
    const capture = () => {
      const box = document.querySelector('.transcript');
      const button = [...(box?.querySelectorAll('button') ?? [])].find(
        (node) => node.textContent.trim() === 'performance-original.png',
      );
      if (!box || !button) return null;
      const viewport = box.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const message = button.closest('[data-message-id]');
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= viewport.top &&
        rect.bottom <= viewport.bottom &&
        rect.left >= viewport.left &&
        rect.right <= viewport.right;
      const readingNode = visible
        ? [...box.querySelectorAll('[data-message-id]')].find((node) => {
            const bounds = node.getBoundingClientRect();
            return (
              bounds.height > 0 &&
              bounds.bottom > viewport.top &&
              bounds.top < viewport.bottom
            );
          })
        : null;
      return {
        viewport: {
          top: viewport.top,
          bottom: viewport.bottom,
          left: viewport.left,
          right: viewport.right,
        },
        rect: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        },
        readingAnchor: readingNode
          ? {
              id: readingNode.getAttribute('data-message-id'),
              offset: readingNode.getBoundingClientRect().top - viewport.top,
              scrollTop: box.scrollTop,
            }
          : null,
        messageId: message?.getAttribute('data-message-id'),
        offset: message
          ? message.getBoundingClientRect().top - viewport.top
          : null,
        visible,
      };
    };
    const before = capture();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return { before, after: capture() };
  });
  report.historicalImagePreparation = { imagePreparation };
  assert.ok(
    imagePreparation.before?.visible && imagePreparation.after?.visible,
    'the historical image button must be inside the actual transcript viewport',
  );
  assert.ok(
    imagePreparation.before.messageId && imagePreparation.after.messageId,
    'historical image preparation uses a real persisted message identity',
  );
  assert.equal(
    imagePreparation.before.messageId,
    imagePreparation.after.messageId,
    'the virtualized image message remains mounted across two frames',
  );
  assert.ok(
    Math.abs(imagePreparation.before.offset - imagePreparation.after.offset) <=
      2,
    'the historical image row settles before reading-position measurement',
  );
  const imageReadingAnchor = imagePreparation.before.readingAnchor;
  const settledImageAnchor = imagePreparation.after.readingAnchor;
  assert.ok(
    imageReadingAnchor && settledImageAnchor,
    'the in-viewport image preparation must include an actual visible reading anchor',
  );
  assert.equal(settledImageAnchor.id, imageReadingAnchor.id);
  assert.ok(
    Math.abs(settledImageAnchor.offset - imageReadingAnchor.offset) <= 2,
  );
  report.historicalImagePreparation.readingAnchor = settledImageAnchor;
  const scrollBeforeImage = await page
    .locator('.transcript')
    .evaluate((node) => node.scrollTop);
  await originalImage.click();
  const image = page.getByRole('dialog').locator('img');
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), `data:image/png;base64,${png}`);
  assert.equal(
    await image.evaluate(
      (node) =>
        node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
    ),
    true,
    'historical original PNG decodes into visible image pixels',
  );
  await page.getByRole('button', { name: 'close dialog', exact: true }).click();
  assert.ok(
    Math.abs(
      (await page.locator('.transcript').evaluate((node) => node.scrollTop)) -
        scrollBeforeImage,
    ) <= 2,
  );
  const restoredImageAnchor = await page.evaluate(
    captureNativeTranscriptAnchor,
  );
  assert.equal(
    restoredImageAnchor.id,
    settledImageAnchor.id,
    'closing the image restores the actual visible message identity',
  );
  assert.ok(
    Math.abs(restoredImageAnchor.offset - settledImageAnchor.offset) <= 2,
    'closing the image restores the actual reading anchor within two pixels',
  );
  checks.push(
    'historical PNG opens exact persisted original and returns to reading position',
  );
  await page.locator('.tool-summary').last().click();
  await page.locator('.tool-head').last().click();
  await page
    .getByRole('button', { name: 'copy tool output', exact: true })
    .last()
    .click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, log);
  checks.push('all 600 original historical output lines copied exactly');
  const finalTasks = await service('tasks', 'list');
  assert.equal(
    finalTasks.filter(
      (task) => taskIds.includes(task.spec.id) && task.state === 'running',
    ).length,
    8,
  );
  report.actualTaskRecords = finalTasks.filter((task) =>
    taskIds.includes(task.spec.id),
  );
  await page.screenshot({ path: join(output, 'native-performance.png') });
  for (const [metric, budget] of Object.entries({
    inputKeystroke: 100,
    inputPaste: 100,
    inputClear: 100,
    click: 100,
    eventToFrame: 200,
    sessionSwitch: 300,
    fileSwitch: 300,
    save: 500,
  })) {
    assert.ok(samples[metric].length >= 20, `${metric} insufficient samples`);
    report.metrics[metric] = {
      n: samples[metric].length,
      p95: p95(samples[metric]),
      budgetMs: budget,
      passed: p95(samples[metric]) <= budget,
    };
  }
  report.measurement =
    '40 actual keys plus20 trusted system clipboard600line pastes and20 keyboard clears require actual composer and React Send state; original-panel click feedback and session backend/route/header/visible-body require two frames; producer-to-frame uses actual xterm write callback plus two visible RAF opportunities, never a compositor pixel timestamp. AX latency is reported independently.';
  report.complete = true;
  report.passed =
    Object.values(report.metrics).every((metric) => metric.passed) &&
    !errors.length &&
    report.initialTranscriptPassed;
} catch (error) {
  report.failure = String(error.stack ?? error);
  try {
    const actual = await state();
    report.actualStateOnFailure = {
      activeSessionId: actual.activeSessionId,
      runtime: actual.runtime,
      sessions: actual.sessions.map((session) => ({
        id: session.id,
        state: session.state,
        projectedMessages: session.messages.length,
        leafId: session.leafId,
      })),
    };
  } catch (diagnosticError) {
    report.stateReadFailure = String(diagnosticError);
  }
  try {
    if (page) {
      report.actualVisibleOwnerOnFailure = await page.evaluate(() => ({
        url: location.href,
        header: document.querySelector('.session-title')?.textContent,
        selectedSidebar: [
          ...document.querySelectorAll(
            '.sidebar a.active,.sidebar a[aria-current]',
          ),
        ].map((node) => ({
          href: node.getAttribute('href'),
          text: node.textContent,
        })),
        messages: [
          ...document.querySelectorAll('.transcript [data-message-id]'),
        ].map((node) => ({
          id: node.dataset.messageId,
          top: node.getBoundingClientRect().top,
          bottom: node.getBoundingClientRect().bottom,
          text: node.textContent?.slice(0, 160),
        })),
      }));
      await page.screenshot({ path: join(output, 'failure.png') });
    }
  } catch {}
  process.exitCode = 1;
} finally {
  if (page) {
    try {
      (report.editorInputDiagnostics ??= []).push(
        await page.evaluate(captureNativeEditorInput, 'finally'),
      );
    } catch (error) {
      report.editorInputDiagnosticError = String(error);
    }
    try {
      report.feedbackDiagnostics = await page.evaluate(() => ({
        records: window.__circleNativePerfFeedbackDiagnostics ?? [],
        overflow: Boolean(window.__circleNativePerfFeedbackDiagnosticOverflow),
      }));
      await writePerformanceEvidence(
        report,
        join(output, 'feedback-diagnostics.json'),
        JSON.stringify(report.feedbackDiagnostics, null, 2),
      );
    } catch (error) {
      report.feedbackDiagnosticError = String(error);
    }
  }
  await stopNativePerformanceCpuProfile(cpuProfile, output, report);
  if (page && report.readingTrace) {
    try {
      report.readingTrace.push(
        await page.evaluate(captureNativeReadingTrace, {
          phase: 'finally-before-cleanup',
        }),
      );
      await page.evaluate(() => {
        window.__circleNativeReadingUnsubscribe?.();
      });
    } catch (error) {
      report.readingTraceError = String(error);
    }
    await writePerformanceEvidence(
      report,
      join(output, 'reading-trace.json'),
      JSON.stringify(
        { sessionAnchor: report.sessionAnchor, frames: report.readingTrace },
        null,
        2,
      ),
    );
  }
  if (process.env.CIRCLE_NATIVE_PERF_DIAGNOSTICS === '1') {
    report.diagnostics = {
      optIn: true,
      observerOverhead:
        'main 250ms sampling, renderer RAF/longtask/metadata subscription; synchronous bounded worker metadata writes; metrics and eligibility unchanged',
    };
    try {
      report.diagnostics.renderer = await page.evaluate(() =>
        window.__circleNativePerfDiagnostics?.stop(),
      );
    } catch (error) {
      report.diagnostics.rendererError = String(error);
    }
    try {
      report.diagnostics.main = await app.evaluate(() =>
        globalThis.__circleNativePerfMainDiagnostics?.stop(),
      );
    } catch (error) {
      report.diagnostics.mainError = String(error);
    }
    try {
      report.diagnostics.worker = await readWorkerPerformanceDiagnostics(data);
    } catch (error) {
      report.diagnostics.workerUnavailable = String(error);
    }
    await writePerformanceEvidence(
      report,
      join(output, 'stage-diagnostics.json'),
      JSON.stringify(report.diagnostics, null, 2),
    );
  }
  if (page) {
    try {
      report.terminalTiming = await page.evaluate(
        () => window.__circleNativePerfTerminalTiming ?? [],
      );
    } catch {}
  }
  await writePerformanceEvidence(
    report,
    join(output, 'samples-before-cleanup.json'),
    JSON.stringify(
      {
        samples,
        terminalTiming: report.terminalTiming,
        checks,
        errors,
        failure: report.failure,
        initialTranscriptPassed: report.initialTranscriptPassed,
        interfaceScope: report.interfaceScope,
      },
      null,
      2,
    ),
  );
  if (page) {
    for (const id of taskIds)
      try {
        await service('tasks', 'cancel', { id });
      } catch {}
    if (terminalId)
      try {
        await service('terminal', 'close', { id: terminalId });
      } catch {}
    try {
      await page.evaluate(() => {
        window.__circleNativePerfObserver?.disconnect();
        delete window.__circleNativeTerminalTiming;
      });
    } catch {}
  }
  if (app) {
    if (clipboardBefore !== undefined) {
      await restoreNativeClipboardWithRecovery(app, clipboardBefore, {
        retryPath: join(output, 'retry-clipboard'),
        onFailure: async (error) => {
          report.clipboardRestoreFailure = String(error);
          report.clipboardRecovery = {
            pending: true,
            appKeptAlive: true,
            retryPath: join(output, 'retry-clipboard'),
          };
          report.passed = false;
          process.exitCode = 1;
          await writePerformanceEvidence(
            report,
            join(output, 'report.json'),
            JSON.stringify(report, null, 2),
          );
          console.error(
            'Clipboard restoration pending; app and original main-process checkpoint retained. Create retry-clipboard in the attempt directory to retry.',
          );
        },
      });
      report.clipboardRestored = true;
      if (report.clipboardRecovery)
        report.clipboardRecovery = {
          ...report.clipboardRecovery,
          pending: false,
          appKeptAlive: false,
          restoredAt: new Date().toISOString(),
        };
    }
    await app.close().catch(() => {});
    if (process.env.CIRCLE_NATIVE_PERF_DIAGNOSTICS === '1') {
      try {
        report.diagnostics.workerAfterAppClose =
          await readWorkerPerformanceDiagnostics(data);
      } catch (error) {
        report.diagnostics.workerAfterCloseError = String(error);
      }
      await writePerformanceEvidence(
        report,
        join(output, 'stage-diagnostics.json'),
        JSON.stringify(report.diagnostics, null, 2),
      );
    }
  }
  for (const [metric, budget] of Object.entries({
    inputKeystroke: 100,
    inputPaste: 100,
    inputClear: 100,
    click: 100,
    eventToFrame: 200,
    sessionSwitch: 300,
    fileSwitch: 300,
    save: 500,
  })) {
    if (!report.metrics[metric] && samples[metric].length)
      report.metrics[metric] = {
        n: samples[metric].length,
        p95: p95(samples[metric]),
        budgetMs: budget,
        passed: samples[metric].length >= 20 && p95(samples[metric]) <= budget,
        partial: !report.complete,
      };
  }
  report.finishedAt = new Date().toISOString();
  await writePerformanceEvidence(
    report,
    join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        output,
        complete: report.complete,
        passed: report.passed ?? false,
        metrics: report.metrics,
        failure: report.failure,
        diagnosticWriteErrors: report.diagnosticWriteErrors,
      },
      null,
      2,
    ),
  );
  if (report.complete && !report.passed) process.exitCode = 1;
}
