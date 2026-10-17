// Completion and stream visibility through the sandboxed renderer and real worker/Harness.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  realpath,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-completion-native-'));
const output = resolve(
  root,
  '../../outputs/completion',
  process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development',
);
await mkdir(output, { recursive: true });
const data = join(temp, 'data');
await mkdir(join(data, 'runtime-home', 'cache'), { recursive: true });
await writeFile(
  join(data, 'runtime-home', 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const requestsPath = join(temp, 'requests.jsonl');
const fixturePath = join(temp, 'model.json');
// The first stream stays open after its second thought until this file exists.
const releaseStream = join(temp, 'release-interleaved-stream');
const partial = 'native partial answer';
const failures = [
  {
    id: 'limit',
    code: 'output_limit',
    reason: 'length',
    provider_reason: 'max_tokens',
    text: 'model output limit reached; response incomplete',
    translated: '模型达到输出上限，响应未完成',
    content: partial,
  },
  {
    id: 'missing',
    code: 'missing_finish',
    reason: 'missing',
    text: 'model response ended without a complete finish signal',
    translated: '模型响应缺少完整的结束信号',
    content: 'native missing-finish text',
  },
  {
    id: 'empty',
    code: 'empty_response',
    reason: 'stop',
    provider_reason: 'end_turn',
    text: 'model returned an empty response',
    translated: '模型返回了空响应',
    content: '',
  },
];
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        chunks: [
          { text: 'native thought one', thinking: true },
          'native progress one ',
          { text: ' then thought two', thinking: true },
          { waitForFile: releaseStream },
          'native progress two',
        ],
        delayMs: 150,
        message: {
          id: 'interleaved',
          role: 'assistant',
          content: 'native progress one native progress two',
          thinking: 'native thought one then thought two',
          provider_content: [
            {
              type: 'thinking',
              thinking: 'native thought one then thought two',
              signature: 'synthetic-signature',
            },
          ],
          completion: { reason: 'tool_calls', provider_reason: 'tool_use' },
          tool_calls: [
            {
              id: 'native-read',
              name: 'read_file',
              args: { file_path: 'fixture.txt' },
            },
          ],
        },
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 },
      },
      {
        message: {
          id: 'complete',
          role: 'assistant',
          content: 'native complete answer',
          completion: { reason: 'stop', provider_reason: 'end_turn' },
        },
        usage: { input_tokens: 12, output_tokens: 3, cache_read_tokens: 0 },
      },
      ...failures.map((failure) => ({
        message: {
          id: failure.id,
          role: 'assistant',
          content: failure.content,
          completion: {
            reason: failure.reason,
            provider_reason: failure.provider_reason,
            ...(failure.reason === 'length' ? { output_limit: 32000 } : {}),
          },
          ...(failure.code === 'empty_response'
            ? {
                provider_content: [
                  {
                    type: 'thinking',
                    thinking: '',
                    signature: 'synthetic-empty-signature',
                  },
                ],
              }
            : {
                truncated: true,
                tool_calls: [
                  {
                    id: failure.id + '-write',
                    name: 'write_file',
                    args: {
                      file_path: failure.id + '-must-not-exist.txt',
                      content: 'blocked native side effect',
                    },
                  },
                ],
              }),
        },
        usage: {
          input_tokens: 13,
          output_tokens: failure.code === 'output_limit' ? 32000 : 1,
          cache_read_tokens: 0,
        },
      })),
      { error: 'model ended without an answer' },
      {
        chunks: ['continuation is running ', 'then finished'],
        delayMs: 1500,
        message: {
          id: 'legacy-continued',
          role: 'assistant',
          content: 'continuation is running then finished',
          completion: { reason: 'stop', provider_reason: 'end_turn' },
        },
      },
      {
        chunks: ['independent notice continuation ', 'finished'],
        delayMs: 1500,
        message: {
          id: 'legacy-continued-again',
          role: 'assistant',
          content: 'independent notice continuation finished',
          completion: { reason: 'stop', provider_reason: 'end_turn' },
        },
      },
      {
        message: {
          id: 'custom-empty-hidden',
          role: 'assistant',
          content: '',
          provider_content: [
            {
              type: 'thinking',
              thinking: '',
              signature: 'synthetic-hidden-signature',
            },
          ],
        },
      },
      {
        chunks: ['hidden anchor continuation ', 'finished'],
        delayMs: 1500,
        message: {
          id: 'hidden-anchor-continued',
          role: 'assistant',
          content: 'hidden anchor continuation finished',
          completion: { reason: 'stop', provider_reason: 'end_turn' },
        },
      },
      {
        message: {
          id: 'failed-manual-summary',
          role: 'assistant',
          content: 'partial manual summary',
          completion: {
            reason: 'length',
            provider_reason: 'max_tokens',
            output_limit: 32000,
          },
        },
        usage: { input_tokens: 13, output_tokens: 3, cache_read_tokens: 0 },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const checks = [];
const errors = [];
let app;
const launch = () =>
  electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
try {
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(patience(12000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.frontendOnly, false);
  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const command = (name, payload = {}) =>
    page.evaluate(
      async ({ name, payload }) => {
        const current = await window.circleDesktop.runtimeState();
        return window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId: current.snapshot.activeSessionId,
        });
      },
      { name, payload },
    );
  const until = async (check, description) => {
    const deadline = Date.now() + patience(12000);
    while (!(await check())) {
      assert(Date.now() < deadline, description);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const initial = await state();
  const initialSession = initial.sessions.find(
    (row) => row.id === initial.activeSessionId,
  );
  const workspace = initial.workspaces.find(
    (row) => row.id === initialSession.workspaceId,
  ).path;
  assert(
    (await realpath(workspace)).startsWith(await realpath(temp)),
    'only a synthetic native workspace may be used',
  );
  await writeFile(join(workspace, 'fixture.txt'), 'native read fixture bytes');
  assert.equal((await command('set-mode', { mode: 'auto' })).ok, true);
  await page.evaluate(() => {
    window.completionEvents = [];
    window.circleDesktop.onRuntime((update) => {
      if (update.event) window.completionEvents.push(update);
    });
  });
  const send = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  const completedTurn = async ({
    kind,
    messageId,
    message,
    answer,
    blocked = [],
  }) => {
    await page.waitForFunction(
      ({ sessionId, kind, messageId, message, answer }) =>
        window.completionEvents.some(
          ({ event }) =>
            event.sessionId === sessionId &&
            event.kind === kind &&
            (!messageId || event.payload.completion_message_id === messageId) &&
            (!message || event.payload.message === message) &&
            (!answer || event.payload.answer === answer),
        ),
      { sessionId: initial.activeSessionId, kind, messageId, message, answer },
    );
    let completed;
    await until(async () => {
      const current = await state();
      const target = current.sessions.find(
        (row) => row.id === initial.activeSessionId,
      );
      if (!target || target.state !== 'idle' || target.turn) return false;
      if (
        !blocked.every((id) =>
          target.messages.some(
            (row) => row.tool?.id === id && row.tool.status === 'error',
          ),
        )
      )
        return false;
      completed = current;
      return true;
    }, `completed ${kind} lifecycle with paired blocked results`);
    return completed;
  };
  await send('show interleaved text and thinking');
  // The stream is held open after a thought that followed the text, so both
  // checks see the open response however slowly the window renders it.
  await page.getByText('native progress one', { exact: true }).waitFor();
  await until(
    async () =>
      (await state()).sessions.some((row) =>
        row.messages.some(
          (message) =>
            message.at === 'streaming' &&
            message.text === 'native progress one ' &&
            message.thinking === 'native thought one then thought two',
        ),
      ),
    'visible stream retains text and thinking',
  );
  await writeFile(releaseStream, '');
  await page.getByText('native complete answer', { exact: true }).waitFor();
  let snapshot = await completedTurn({
    kind: 'run_end',
    answer: 'native complete answer',
  });
  let session = snapshot.sessions.find(
    (row) => row.id === snapshot.activeSessionId,
  );
  const combined = session.messages.find(
    (row) => row.text === 'native progress one native progress two',
  );
  assert.equal(combined.thinking, 'native thought one then thought two');
  assert.equal(
    session.messages.filter((row) => row.text === combined.text).length,
    1,
  );
  assert(
    session.messages.some((row) =>
      row.tool?.output.includes('native read fixture bytes'),
    ),
  );
  checks.push(
    'native stream and final history retain interleaved text and thinking around actual tool execution',
  );
  let expectedRequests = 2;
  for (const failure of failures) {
    await send('show ' + failure.code);
    await page.getByText('✖ ' + failure.text, { exact: true }).waitFor();
    snapshot = await completedTurn({
      kind: 'run_error',
      messageId: failure.id,
      blocked: failure.code === 'empty_response' ? [] : [failure.id + '-write'],
    });
    assert.equal(
      snapshot.runtime.error,
      undefined,
      'typed failure uses its transcript diagnostic instead of a duplicate toast',
    );
    assert.equal(
      await page.locator('.toast').filter({ hasText: failure.text }).count(),
      0,
    );
    session = snapshot.sessions.find(
      (row) => row.id === snapshot.activeSessionId,
    );
    assert.equal(
      session.messages.filter((row) => row.completionFailure === failure.code)
        .length,
      1,
    );
    if (failure.code !== 'empty_response') {
      await assert.rejects(
        access(join(workspace, failure.id + '-must-not-exist.txt')),
      );
      assert(
        session.messages.some(
          (row) =>
            row.tool?.id === failure.id + '-write' &&
            row.tool.status === 'error',
        ),
      );
    }
    const requests = (await readFile(requestsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(
      requests.length,
      ++expectedRequests,
      'failed response never starts an automatic continuation',
    );
  }
  const events = await page.evaluate(() =>
    window.completionEvents.map((row) => row.event),
  );
  assert.equal(events.filter((row) => row.kind === 'run_end').length, 1);
  assert.equal(
    events.filter((row) => row.kind === 'run_error').length,
    failures.length,
  );
  assert.equal(
    events.filter((row) => row.kind === 'llm_end').length,
    expectedRequests,
  );
  checks.push(
    'native output-limit, missing-finish and empty responses produce one specific error each, zero blocked tool effects and zero automatic requests',
  );
  await send('trigger legacy empty answer');
  await page
    .getByText('✖ model ended without an answer', { exact: true })
    .waitFor();
  await completedTurn({
    kind: 'run_error',
    message: 'model ended without an answer',
  });
  assert.equal(
    await page
      .locator('.toast')
      .filter({ hasText: 'model ended without an answer' })
      .count(),
    0,
    'a harness failure stays in its source transcript instead of a global toast',
  );
  await send('continue after legacy error');
  await page.getByText('continuation is running', { exact: true }).waitFor();
  snapshot = await state();
  assert.equal(snapshot.runtime.error, undefined);
  assert.equal(
    await page
      .locator('.toast')
      .filter({ hasText: 'model ended without an answer' })
      .count(),
    0,
    'the previous current-error toast clears as soon as continuation starts',
  );
  session = snapshot.sessions.find(
    (row) => row.id === snapshot.activeSessionId,
  );
  const failureIndex = session.messages.findIndex(
    (row) => row.text === '✖ model ended without an answer',
  );
  const continueIndex = session.messages.findIndex(
    (row) => row.role === 'user' && row.text === 'continue after legacy error',
  );
  assert(
    failureIndex >= 0 && failureIndex < continueIndex,
    'the historical failure stays before the continued turn',
  );
  await page
    .getByText('continuation is running then finished', { exact: true })
    .waitFor();
  await completedTurn({
    kind: 'run_end',
    answer: 'continuation is running then finished',
  });
  assert.equal(
    await page
      .getByText('✖ model ended without an answer', { exact: true })
      .count(),
    1,
  );
  expectedRequests += 2;
  assert.equal(
    (await readFile(requestsPath, 'utf8')).trim().split('\n').length,
    expectedRequests,
  );
  checks.push(
    'continuing after the legacy error keeps current state clear, retains the original failure in history and completes without replay',
  );
  const independentNotice = 'unknown command /unrecognized-fixture-command';
  await send('/skill nonexistent-native-fixture-skill');
  await page.locator('.toast').filter({ hasText: 'skill not found' }).waitFor();
  await send('/unrecognized-fixture-command');
  await page.locator('.toast').filter({ hasText: independentNotice }).waitFor();
  // An older identically worded action notice must not erase a newer one while
  // the earlier session-scoped API failure clears on continuation.
  await new Promise((done) => setTimeout(done, 1800));
  await send('/unrecognized-fixture-command');
  await page.locator('.toast').filter({ hasText: independentNotice }).waitFor();
  await send('continue while preserving an independent notice');
  await page
    .getByText('independent notice continuation', { exact: true })
    .waitFor();
  assert.equal((await state()).runtime.error, undefined);
  assert.equal(
    await page.locator('.toast').filter({ hasText: independentNotice }).count(),
    1,
    'clearing the previous runtime error preserves a newer action toast',
  );
  await page
    .getByText('independent notice continuation finished', { exact: true })
    .waitFor();
  await completedTurn({
    kind: 'run_end',
    answer: 'independent notice continuation finished',
  });
  assert.equal(
    await page.locator('.toast').filter({ hasText: independentNotice }).count(),
    1,
    'the older runtime notice timer cannot erase the newer identically worded action toast',
  );
  expectedRequests += 1;
  assert.equal(
    (await readFile(requestsPath, 'utf8')).trim().split('\n').length,
    expectedRequests,
  );
  await page
    .locator('.toast')
    .filter({ hasText: independentNotice })
    .waitFor({ state: 'hidden' });
  checks.push(
    'clearing a session action error and older timers leave a newer identically worded independent action toast intact',
  );
  await send('trigger hidden assistant response');
  await until(async () => {
    const value = await state();
    return (
      value.sessions
        .find((row) => row.id === value.activeSessionId)
        .messages.filter((row) => row.completionFailure === 'empty_response')
        .length === 2
    );
  }, 'custom empty response error');
  await completedTurn({ kind: 'run_error', messageId: 'custom-empty-hidden' });
  await send('continue after hidden assistant');
  await page.getByText('hidden anchor continuation', { exact: true }).waitFor();
  const hiddenOrder = async () => {
    const value = await state();
    const messages = value.sessions.find(
      (row) => row.id === value.activeSessionId,
    ).messages;
    const failure = messages.findLastIndex(
      (row) => row.completionFailure === 'empty_response',
    );
    const continued = messages.findIndex(
      (row) =>
        row.role === 'user' && row.text === 'continue after hidden assistant',
    );
    assert(
      failure >= 0 && failure < continued,
      'an invisible saved assistant cannot pin its historical error below a new turn',
    );
    assert.equal(value.runtime.error, undefined);
  };
  await hiddenOrder();
  await page
    .getByText('hidden anchor continuation finished', { exact: true })
    .waitFor();
  await completedTurn({
    kind: 'run_end',
    answer: 'hidden anchor continuation finished',
  });
  await hiddenOrder();
  expectedRequests += 2;
  assert.equal(
    (await readFile(requestsPath, 'utf8')).trim().split('\n').length,
    expectedRequests,
  );
  checks.push(
    'an error anchored to a saved empty assistant stays in its original history position during and after continuation',
  );
  assert.equal((await command('compact')).ok, true);
  await until(async () => {
    const value = await state();
    return (
      value.sessions
        .find((row) => row.id === value.activeSessionId)
        .messages.filter((row) => row.completionFailure === 'output_limit')
        .length === 2
    );
  }, 'typed manual compaction diagnostic');
  expectedRequests += 1;
  assert.equal(
    (await readFile(requestsPath, 'utf8')).trim().split('\n').length,
    expectedRequests,
  );
  checks.push(
    'a typed manual compaction failure remains visible on its source session without a global error',
  );
  await page.evaluate(() => {
    location.hash = '/page/settings';
  });
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await page.evaluate((id) => {
    location.hash = '/session/' + id;
  }, snapshot.activeSessionId);
  for (const failure of failures) {
    const diagnostics = page.getByText('✖ ' + failure.translated, {
      exact: true,
    });
    await diagnostics.first().waitFor();
    assert.equal(
      await diagnostics.count(),
      ['empty_response', 'output_limit'].includes(failure.code) ? 2 : 1,
    );
  }
  assert.equal(await page.getByText(partial, { exact: true }).count(), 1);
  for (const theme of ['dark', 'light']) {
    await command('save-settings', { settings: { theme } });
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      theme,
    );
    await page.screenshot({
      path: join(output, 'completion-zh-' + theme + '.png'),
    });
  }
  checks.push(
    'typed native diagnostics translate in both palettes while partial model text stays verbatim',
  );
  await app.close();
  app = await launch();
  const reopened = await app.firstWindow();
  reopened.setDefaultTimeout(patience(12000));
  reopened.on('pageerror', (error) => errors.push(String(error)));
  await reopened
    .locator('.transcript-notice')
    .filter({ hasText: /model output limit reached|模型达到输出上限/ })
    .waitFor();
  const restored = await reopened.evaluate(
    async () => (await window.circleDesktop.runtimeState()).snapshot,
  );
  const restoredSession = restored.sessions.find(
    (row) => row.id === restored.activeSessionId,
  );
  assert.equal(
    restoredSession.messages.filter((row) => row.completionFailure).length,
    failures.length,
  );
  assert(restoredSession.messages.some((row) => row.text === partial));
  assert.equal(
    (await readFile(requestsPath, 'utf8')).trim().split('\n').length,
    expectedRequests,
  );
  checks.push(
    'reopened native history keeps specific failure markers and partial text without replaying a failed request',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        checks,
        packaged: info.packaged,
        requests: expectedRequests,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, packaged: info.packaged, output }),
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
