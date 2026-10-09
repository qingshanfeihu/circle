import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
interface TestContext {
  after(fn: () => void | Promise<void>): void;
}
interface Resources {
  roots: string[];
  cleanup: (() => void | Promise<void>)[];
}
const resources = new WeakMap<TestContext, Resources>();
function owned(t: TestContext): Resources {
  let state = resources.get(t);
  if (!state) {
    state = { roots: [], cleanup: [] };
    resources.set(t, state);
    t.after(async () => {
      const errors: unknown[] = [];
      for (const cleanup of state!.cleanup.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const root of state!.roots.reverse()) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'test resource cleanup failed');
    });
  }
  return state;
}
export function scratch(t: TestContext, prefix = 'circle-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  owned(t).roots.push(root);
  return root;
}
export function cleanup(
  t: TestContext,
  action: () => void | Promise<void>,
): void {
  owned(t).cleanup.push(action);
}
