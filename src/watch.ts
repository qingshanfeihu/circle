import { setTimeout as delay } from 'node:timers/promises';
export interface WatchOptions {
  interval_s?: number;
  deadline_s?: number;
  result?: unknown;
  on_stop?: () => void | Promise<void>;
}
export class Watch {
  readonly interval: number;
  readonly deadline: number;
  constructor(
    readonly title: string,
    readonly poll: (signal: AbortSignal) => unknown | Promise<unknown>,
    readonly options: WatchOptions = {},
  ) {
    if (!title.trim() || typeof poll !== 'function')
      throw new Error('watch needs a title and poll function');
    this.interval = (options.interval_s ?? 10) * 1000;
    this.deadline = (options.deadline_s ?? 3600) * 1000;
    if (
      !Number.isFinite(this.interval) ||
      this.interval <= 0 ||
      !Number.isFinite(this.deadline) ||
      this.deadline <= 0
    )
      throw new Error('watch interval and deadline must be positive');
  }
}
export async function pollWatch(
  watch: Watch,
  signal: AbortSignal,
): Promise<unknown> {
  while (true) {
    signal.throwIfAborted();
    const result = await abortable(
      Promise.resolve().then(() => watch.poll(signal)),
      signal,
    );
    signal.throwIfAborted();
    if (result !== null && result !== undefined) return result;
    await delay(watch.interval, undefined, { signal });
  }
}
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function stopWatch(watch: Watch): Promise<void> {
  if (!watch.options.on_stop) return;
  const controller = new AbortController();
  try {
    await Promise.race([
      Promise.resolve()
        .then(watch.options.on_stop)
        .catch(() => {}),
      delay(2000, undefined, { signal: controller.signal }).catch(() => {}),
    ]);
  } finally {
    controller.abort();
  }
}
export async function waitWatch(
  watch: Watch,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const stop = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('watch timed out')),
    watch.deadline,
  );
  try {
    signal.throwIfAborted();
    return await pollWatch(watch, controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (controller.signal.aborted) await stopWatch(watch);
  }
}
