import { setTimeout } from 'node:timers/promises';

/** A newly visible native view may not have published its first compositor frame yet. */
export async function captureFrame<T extends { isEmpty(): boolean }>(
  capture: () => Promise<T>,
) {
  const retryErrors: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const image = await capture();
      if (image.isEmpty()) throw Error('empty browser frame');
      return { image, attempts: attempt, retryErrors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UnknownVizError|^empty browser frame$/.test(message)) throw error;
      retryErrors.push(message);
      if (attempt === 3)
        throw Error('browser frame unavailable: ' + retryErrors.join('; '), {
          cause: error,
        });
      await setTimeout(50);
    }
  }
  throw Error('browser frame unavailable');
}
