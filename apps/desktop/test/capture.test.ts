import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFrame } from '../src/capture.ts';

test('first compositor failure retries into a real returned image and discloses the failed attempt', async () => {
  let calls = 0;
  const image = { isEmpty: () => false, content: 'captured image' };
  const result = await captureFrame(async () => {
    if (++calls === 1) throw Error('UnknownVizError');
    return image;
  });
  assert.equal(result.image, image);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.retryErrors, ['UnknownVizError']);
});

test('an empty image cannot become a successful hashed observation', async () => {
  await assert.rejects(
    captureFrame(async () => ({ isEmpty: () => true })),
    /browser frame unavailable: empty browser frame/,
  );
});

test('unavailable compositor frames stop after the bounded attempts with the errors intact', async () => {
  let calls = 0;
  await assert.rejects(
    captureFrame(async () => {
      calls++;
      throw Error('UnknownVizError');
    }),
    /browser frame unavailable/,
  );
  assert.equal(calls, 3);
});

test('unrelated capture failures are returned without repeating the request', async () => {
  let calls = 0;
  await assert.rejects(
    captureFrame(async () => {
      calls++;
      throw Error('browser closed');
    }),
    /browser closed/,
  );
  assert.equal(calls, 1);
});
