import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { expandUser } from './paths.js';
import { isRecord } from './settings.js';
export const SCHEMA = 'circle.secret-request.v1';
export interface SecretRequest {
  schema: typeof SCHEMA;
  id: string;
  created_at: number;
  question: string;
  key: string;
  target_file: string;
  mask: boolean;
}
export class SecretPromptError extends Error {}
export class SecretPromptTimeout extends SecretPromptError {}
export const requestsDir = (home: string): string =>
  join(home, 'secret_requests');
function validId(id: string): void {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new SecretPromptError('invalid request ID');
}
const requestPath = (home: string, id: string): string => {
  validId(id);
  return join(requestsDir(home), id + '.request.json');
};
const answerPath = (home: string, id: string): string => {
  validId(id);
  return join(requestsDir(home), id + '.answer');
};
async function locked<T>(home: string, operation: () => T): Promise<T> {
  const directory = requestsDir(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    lockfilePath: join(directory, '.node-lock'),
    retries: { retries: 100, minTimeout: 10, maxTimeout: 30 },
    stale: 10000,
  });
  try {
    return operation();
  } finally {
    await release();
  }
}
function privateMode(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function shred(path: string): void {
  if (!existsSync(path)) return;
  let fd: number | undefined;
  try {
    const bytes = readFileSync(path);
    fd = openSync(path, 'r+');
    writeSync(fd, Buffer.alloc(bytes.byteLength));
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
  }
}
export function createRequest(
  home: string,
  input: { question: string; key: string; target_file: string; mask?: boolean },
): SecretRequest {
  const key = input.key.trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key))
    throw new SecretPromptError(
      'invalid variable name: use capital letters, digits and _',
    );
  if (!input.question.trim())
    throw new SecretPromptError('the question is empty');
  if (!input.target_file.trim())
    throw new SecretPromptError('the request names no target_file to write to');
  mkdirSync(requestsDir(home), { recursive: true, mode: 0o700 });
  const request: SecretRequest = {
    schema: SCHEMA,
    id: randomUUID().replaceAll('-', ''),
    created_at: Date.now() / 1000,
    question: input.question.trim().slice(0, 200),
    key,
    target_file: input.target_file,
    mask: input.mask !== false,
  };
  const path = requestPath(home, request.id);
  writeFileSync(path, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
  privateMode(path);
  return request;
}
export function listPending(home: string): SecretRequest[] {
  const directory = requestsDir(home);
  if (!existsSync(directory)) return [];
  const requests: SecretRequest[] = [];
  for (const name of readdirSync(directory).filter((name) =>
    /^[a-f0-9]{32}\.request\.json$/.test(name),
  )) {
    try {
      const value: unknown = JSON.parse(
        readFileSync(join(directory, name), 'utf8'),
      );
      if (
        isRecord(value) &&
        value.schema === SCHEMA &&
        typeof value.id === 'string' &&
        name === value.id + '.request.json' &&
        typeof value.question === 'string' &&
        typeof value.key === 'string' &&
        /^[A-Z][A-Z0-9_]*$/.test(value.key) &&
        typeof value.target_file === 'string'
      )
        requests.push(value as unknown as SecretRequest);
    } catch {
      /* A malformed request cannot trigger secret entry. */
    }
  }
  return requests.sort((a, b) => a.created_at - b.created_at);
}
export async function submitAnswer(
  home: string,
  id: string,
  value: string,
): Promise<void> {
  const bytes = Buffer.from(value);
  if (!bytes.byteLength) throw new SecretPromptError('the value is empty');
  if (bytes.byteLength > 4096)
    throw new SecretPromptError('the value is too long');
  await locked(home, () => {
    if (!existsSync(requestPath(home, id)))
      throw new SecretPromptError(
        'the request is gone (it timed out or was cancelled)',
      );
    const path = answerPath(home, id);
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      privateMode(temporary);
      if (!existsSync(requestPath(home, id)))
        throw new SecretPromptError('the request is gone');
      renameSync(temporary, path);
      privateMode(path);
      if (!existsSync(requestPath(home, id))) {
        shred(path);
        throw new SecretPromptError('the request is gone');
      }
    } finally {
      if (existsSync(temporary)) shred(temporary);
    }
  });
}
export async function cancelRequest(home: string, id: string): Promise<void> {
  await locked(home, () => {
    shred(answerPath(home, id));
    const path = requestPath(home, id);
    if (existsSync(path)) unlinkSync(path);
  });
}
export async function pollAnswer(
  home: string,
  id: string,
  signal: AbortSignal,
  timeoutMs = 600000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const answer = await locked(home, () => {
        signal.throwIfAborted();
        if (Date.now() >= deadline)
          throw new SecretPromptTimeout(
            'no value was entered before the deadline',
          );
        const path = answerPath(home, id);
        if (existsSync(path)) {
          let bytes: Buffer;
          try {
            bytes = readFileSync(path);
          } finally {
            shred(path);
            const request = requestPath(home, id);
            if (existsSync(request)) unlinkSync(request);
          }
          if (!bytes.byteLength || bytes.byteLength > 4096)
            throw new SecretPromptError(
              'the answer file was empty or too long',
            );
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        if (!existsSync(requestPath(home, id)))
          throw new SecretPromptError('the request was cancelled');
        return undefined;
      });
      if (answer !== undefined) return answer;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, {
        signal,
      });
    }
    throw new SecretPromptTimeout(
      'no value was entered before the deadline; ask again if it is still needed',
    );
  } finally {
    await cancelRequest(home, id);
  }
}
export async function applyToTarget(
  request: SecretRequest,
  value: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (
    !/^[A-Z][A-Z0-9_]*$/.test(request.key) ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    /[\r\n\0]/.test(value)
  )
    throw new SecretPromptError('the value is not valid for an env file');
  const path = expandUser(request.target_file);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(parent, {
    lockfilePath: join(parent, '.secret-target-lock'),
    retries: { retries: 100, minTimeout: 10, maxTimeout: 30 },
    stale: 10000,
  });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    signal.throwIfAborted();
    const lines = existsSync(path)
      ? readFileSync(path, 'utf8').split(/\r?\n/)
      : [];
    const kept = lines.filter(
      (line) =>
        !line.trim() ||
        line.trimStart().startsWith('#') ||
        line.split('=', 1)[0]!.trim() !== request.key,
    );
    while (kept.at(-1) === '') kept.pop();
    kept.push(`${request.key}=${value}`);
    writeFileSync(temporary, kept.join('\n') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    privateMode(temporary);
    signal.throwIfAborted();
    renameSync(temporary, path);
    privateMode(path);
    return path;
  } finally {
    if (existsSync(temporary)) shred(temporary);
    await release();
  }
}
export async function collect(
  home: string,
  requests: { question: string; key: string; target_file: string }[],
  signal: AbortSignal,
  present?: (request: SecretRequest, signal: AbortSignal) => Promise<void>,
  timeoutMs = 600000,
): Promise<string[]> {
  const results: string[] = [];
  for (const input of requests) {
    signal.throwIfAborted();
    const request = createRequest(home, input);
    let value = '';
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const answering = pollAnswer(home, request.id, combined, timeoutMs);
    let presentation: Promise<void> | undefined;
    try {
      if (present)
        presentation = present(request, combined).catch((error) => {
          controller.abort(error);
          throw error;
        });
      const fulfilled = await Promise.all([answering, presentation]);
      value = fulfilled[0] as string;
      combined.throwIfAborted();
      const path = await applyToTarget(request, value, combined);
      results.push(
        `  - ${request.key} → collected and written to ${path} (the value is not in the conversation)`,
      );
    } catch (error) {
      if (!controller.signal.aborted) controller.abort();
      await Promise.allSettled([answering, presentation]);
      if (signal.aborted) throw signal.reason;
      throw error instanceof SecretPromptError
        ? error
        : new SecretPromptError('the secret was not collected');
    } finally {
      value = '';
      controller.abort();
      await cancelRequest(home, request.id);
    }
  }
  return results;
}
