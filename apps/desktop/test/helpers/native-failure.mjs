import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const text = (value, limit = 2000) => {
  const raw = String(value)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(
      /(["']?(?:api[ _-]?key|password|authorization|access[ _-]?token|token)["']?\s*[:=]\s*)[^\r\n]+/gi,
      '$1<redacted>',
    );
  return {
    text: raw.slice(0, limit),
    characters: raw.length,
    truncated: raw.length > limit,
  };
};
const describe = (error) => {
  try {
    return {
      name: text(error?.name ?? 'unknown', 100),
      message: text(error?.message ?? error),
      stack: text(error?.stack ?? '', 4000),
    };
  } catch {
    return { unavailable: 'the thrown value could not be safely inspected' };
  }
};
const emit = (record) => {
  try {
    console.error(JSON.stringify(record));
  } catch {}
};
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'circle:'
      ? `circle://${url.host}${url.pathname}`
      : value === 'about:blank'
        ? value
        : `${url.protocol}<redacted>`;
  } catch {
    return '<unavailable>';
  }
};

// This collects evidence after a failed check. It never retries the check or throws
// over its error. The shared two-second budget bounds waiting for asynchronous
// collection, not execution of remote probes that have already been submitted.
export async function captureNativeFailure(page, error, events, output) {
  const attempt = randomUUID();
  const details = {
    attempt,
    at: new Date().toISOString(),
    phase: page ? 'renderer-check' : 'launch-or-first-window',
    error: describe(error),
    events: events.slice(0, 20).map((event) => text(event, 1000)),
    eventsCount: events.length,
    eventsTruncated: events.length > 20,
    observation:
      'Post-failure samples and events retained after listener registration; absent errors do not prove earlier bootstrap succeeded',
    probes: {},
  };
  emit(details);
  const deadline = Date.now() + 2000;
  const bounded = async (operation) => {
    if (Date.now() >= deadline)
      throw Error('failure evidence deadline exceeded');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Error('failure evidence deadline exceeded')),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const save = async (name, value) => {
    try {
      await bounded(() =>
        writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', {
          flag: 'wx',
        }),
      );
    } catch (secondary) {
      emit({ attempt, evidenceWriteError: describe(secondary) });
    }
  };
  // Immutable and unique: a failed later probe cannot truncate this primary record.
  await save(`failure-${attempt}-primary.json`, details);
  const probe = async (name, operation) => {
    try {
      details.probes[name] = {
        status: 'captured',
        value: await bounded(operation),
      };
    } catch (secondary) {
      details.probes[name] = {
        status: 'unavailable',
        error: describe(secondary),
      };
    }
    if (Date.now() < deadline)
      await save(`failure-${attempt}-${name}.json`, details.probes[name]);
  };
  if (page)
    await Promise.all([
      probe('page', async () => {
        const errorsAvailable = typeof page.pageErrors === 'function';
        const consoleAvailable = typeof page.consoleMessages === 'function';
        const errors = errorsAvailable ? await page.pageErrors() : [];
        const messages = consoleAvailable ? await page.consoleMessages() : [];
        const matching = messages
          .slice(0, 200)
          .filter((message) => message.type() === 'error');
        return {
          url: safeUrl(page.url()),
          errorsAvailable,
          errors: errors.slice(0, 20).map(describe),
          errorsCount: errors.length,
          errorsTruncated: errors.length > 20,
          consoleAvailable,
          consoleErrors: matching
            .slice(0, 20)
            .map((message) => text(message.text())),
          consoleCount: messages.length,
          matchingInspectedConsoleErrors: matching.length,
          consoleTruncated: messages.length > 200 || matching.length > 20,
        };
      }),
      probe('dom', () =>
        page.evaluate(() => ({
          readyState: document.readyState,
          // How far the window's own start-up got (main.tsx), and which of
          // its files loaded: a file named below but not loaded is pending.
          boot: document.documentElement.dataset.boot ?? null,
          files: [
            ...Array.from(document.scripts, (node) => node.src),
            ...Array.from(
              document.querySelectorAll('link[href]'),
              (node) => node.href,
            ),
          ]
            .filter(Boolean)
            .map((url) => url.split('/').pop())
            .slice(0, 20),
          loaded: performance
            .getEntriesByType('resource')
            .slice(0, 40)
            .map((entry) => entry.name.split('/').pop()),
          rootChildren:
            document.getElementById('root')?.childElementCount ?? null,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          inputCount: document.querySelectorAll('input, textarea').length,
          inputsTruncated:
            document.querySelectorAll('input, textarea').length > 30,
          inputs: Array.from(document.querySelectorAll('input, textarea'))
            .slice(0, 30)
            .map((node) => ({
              type: node.type,
              disabled: node.disabled,
            })),
        })),
      ),
      probe('accessibility', async () => {
        const body = page.locator('body');
        if (typeof body.ariaSnapshot !== 'function')
          return { available: false };
        const snapshot = await body.ariaSnapshot({
          timeout: Math.max(1, deadline - Date.now()),
        });
        const roles = snapshot
          .slice(0, 40000)
          .split('\n')
          .map((line) => /^\s*-\s+([a-z][a-z0-9-]*)\b/.exec(line)?.[1])
          .filter(Boolean);
        return {
          available: true,
          projection: 'roles only; names and values excluded',
          characters: snapshot.length,
          textTruncated: snapshot.length > 40000,
          inspectedRoleCount: roles.length,
          truncated: roles.length > 200,
          roles: roles.slice(0, 200),
        };
      }),
      probe('screenshot', async () => {
        const file = `failure-${attempt}.png`;
        await page.screenshot({
          path: join(output, file),
          mask: [page.locator('input, textarea, [contenteditable]')],
          timeout: Math.max(1, deadline - Date.now()),
        });
        return {
          file,
          masked: 'all input, textarea and contenteditable fields',
        };
      }),
    ]);
  // A stalled probe may consume the budget. Finished probe files and this bounded
  // final log still disclose the successful observations without another wait budget.
  emit(details);
  await save(`failure-${attempt}-details.json`, details);
}

export async function cleanupNativeTest(operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return true;
  emit({ phase: 'native-test-cleanup', errors: errors.map(describe) });
  // The entry preserves a pending primary throw and marks successful checks red
  // through its exit code when cleanup fails.
  return false;
}
