import type { AgentRuntime } from './runtime.js';
/** Gracefully reap jobs when the terminal closes or the application is terminated. */
export function installExitGuard(
  runtime: AgentRuntime,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let exiting = false;
  const stop = (code: number): void => {
    if (exiting) return;
    exiting = true;
    void runtime.close(false).then(
      () => exit(code),
      () => exit(code),
    );
  };
  const term = (): void => stop(143);
  const hup = (): void => stop(129);
  process.on('SIGTERM', term);
  process.on('SIGHUP', hup);
  return () => {
    process.off('SIGTERM', term);
    process.off('SIGHUP', hup);
  };
}
