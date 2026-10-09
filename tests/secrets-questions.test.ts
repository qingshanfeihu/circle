import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import {
  createRequest,
  listPending,
  submitAnswer,
  pollAnswer,
  applyToTarget,
  collect,
  requestsDir,
  SecretPromptError,
  SecretPromptTimeout,
} from '../src/secret_prompt.js';
import { panelQuestion, askQuestions } from '../src/questions.js';
import { QuestionCard } from '../src/ink/components/question_card.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { Sandbox } from '../src/sandbox.js';
import { scratch, cleanup } from './helpers.js';
test('secret requests are private, validated and discoverable, and values reach the target without appearing in confirmations', async (t) => {
  const root = scratch(t);
  const target = join(root, 'private', 'device.env');
  const input = {
    question: 'device password',
    key: 'DEVICE_PASSWORD',
    target_file: target,
  };
  const request = createRequest(root, input);
  assert.equal(listPending(root)[0]!.id, request.id);
  if (process.platform !== 'win32')
    assert.equal(
      statSync(join(requestsDir(root), request.id + '.request.json')).mode &
        0o777,
      0o600,
    );
  const pending = pollAnswer(
    root,
    request.id,
    new AbortController().signal,
    1000,
  );
  await submitAnswer(root, request.id, 'password-不能泄漏');
  const value = await pending;
  await applyToTarget(request, value, new AbortController().signal);
  assert.equal(
    readFileSync(target, 'utf8'),
    'DEVICE_PASSWORD=password-不能泄漏\n',
  );
  if (process.platform !== 'win32')
    assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(listPending(root).length, 0);
  assert.deepEqual(readdirSync(requestsDir(root)), []);
  assert.throws(
    () => createRequest(root, { ...input, key: 'bad key' }),
    SecretPromptError,
  );
  const lines = await collect(
    root,
    [input],
    new AbortController().signal,
    async (request) => {
      await submitAnswer(root, request.id, 'another-secret');
    },
    1000,
  );
  assert.ok(!lines.join('\n').includes('another-secret'));
  assert.match(lines.join('\n'), /DEVICE_PASSWORD/);
});
test('secret timeout, cancellation and late answers leave no plaintext rendezvous files', async (t) => {
  const root = scratch(t);
  const request = createRequest(root, {
    question: 'password',
    key: 'KEY',
    target_file: join(root, 'env'),
  });
  await assert.rejects(
    pollAnswer(root, request.id, new AbortController().signal, 50),
    SecretPromptTimeout,
  );
  await assert.rejects(submitAnswer(root, request.id, 'late-secret'), /gone/);
  assert.deepEqual(readdirSync(requestsDir(root)), []);
  const second = createRequest(root, {
    question: 'password',
    key: 'KEY',
    target_file: join(root, 'env'),
  });
  const controller = new AbortController();
  const waiting = pollAnswer(root, second.id, controller.signal);
  const rejected = assert.rejects(waiting, /abort|Interrupted/i);
  controller.abort(new Error('Interrupted'));
  await rejected;
  assert.deepEqual(readdirSync(requestsDir(root)), []);
});
test('answers that arrive while the lock is held past the deadline are cleaned without being consumed', async (t) => {
  const root = scratch(t);
  const request = createRequest(root, {
    question: 'password',
    key: 'KEY',
    target_file: join(root, 'env'),
  });
  const release = await lockfile.lock(requestsDir(root), {
    lockfilePath: join(requestsDir(root), '.node-lock'),
  });
  const waiting = pollAnswer(
    root,
    request.id,
    new AbortController().signal,
    30,
  );
  const rejected = assert.rejects(waiting, SecretPromptTimeout);
  await delay(60);
  writeFileSync(join(requestsDir(root), request.id + '.answer'), 'late', {
    mode: 0o600,
  });
  await release();
  await rejected;
  assert.deepEqual(readdirSync(requestsDir(root)), []);
});
test('target updates preserve unrelated lines, serialize writes and refuse invalid env values', async (t) => {
  const root = scratch(t);
  const target = join(root, 'env');
  writeFileSync(target, '# keep\nHOST=device\nPASSWORD=old\n');
  const request = createRequest(root, {
    question: 'password',
    key: 'PASSWORD',
    target_file: target,
  });
  const signal = new AbortController().signal;
  await applyToTarget(request, 'new-secret', signal);
  assert.equal(
    readFileSync(target, 'utf8'),
    '# keep\nHOST=device\nPASSWORD=new-secret\n',
  );
  await assert.rejects(
    applyToTarget(request, 'bad\nINJECT=yes', signal),
    SecretPromptError,
  );
  assert.equal(
    readFileSync(target, 'utf8'),
    '# keep\nHOST=device\nPASSWORD=new-secret\n',
  );
  await assert.rejects(
    submitAnswer(root, request.id, 'x'.repeat(5000)),
    SecretPromptError,
  );
});
test('question panels support multiple choices, custom text and cancellation without assuming an answer', () => {
  const question = panelQuestion({
    question: 'choose',
    options: ['one', { label: 'two', description: 'details' }],
    multiple: true,
  });
  const card = new QuestionCard([question]);
  card.handle(' ', ' ');
  card.handle('down', '');
  card.handle(' ', ' ');
  assert.deepEqual(card.handle('enter', ''), { answer: [['one', 'two']] });
  // closing the card is not an empty answer: the model is told nothing was answered
  const cancelled = new QuestionCard([question]);
  assert.deepEqual(cancelled.handle('escape', ''), { answer: null });
  const custom = new QuestionCard([
    panelQuestion({ question: 'choose', options: ['one'] }),
  ]);
  custom.handle('down', '');
  custom.handle('enter', '');
  custom.paste('custom answer');
  assert.deepEqual(custom.handle('enter', ''), {
    answer: [['custom answer']],
  });
});
test('headless ordinary questions are returned for chat, while secrets use the file channel and never enter history, requests or events', async (t) => {
  const root = scratch(t);
  const target = join(root, 'device.env');
  const secret = 'test-value-must-not-enter-model';
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'question',
            name: 'question',
            args: {
              questions: [
                {
                  question: 'device password',
                  secret: true,
                  key: 'DEVICE_PASSWORD',
                  target_file: target,
                },
              ],
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'configured' } },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
    secret: async (request) => {
      await submitAnswer(root, request.id, secret);
    },
  });
  cleanup(t, () => runtime.close());
  const events: unknown[] = [];
  runtime.bus.subscribe((event) => events.push(event));
  await runtime.harness.run('configure');
  assert.match(readFileSync(target, 'utf8'), /DEVICE_PASSWORD=/);
  assert.ok(!JSON.stringify(runtime.harness.messages).includes(secret));
  assert.ok(!JSON.stringify(model.requests).includes(secret));
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.match(model.requests[1]!.messages.at(-1)!.content, /SECRET_QUESTIONS/);
  const fallback = await askQuestions(
    root,
    new Sandbox(root),
    { questions: [{ question: 'which mode?', options: ['one', 'two'] }] },
    new AbortController().signal,
  );
  assert.match(fallback, /USER_QUESTIONS/);
  assert.match(fallback, /Do not invent answers/);
});
