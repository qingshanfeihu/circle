import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The parent of a live process, from the platform's own process table. */
export async function parentOf(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`,
      ],
      { windowsHide: true },
    );
    return Number(stdout.trim()) || undefined;
  }
  const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
  return Number(stdout.trim()) || undefined;
}

/**
 * Whether `pid` is `root` or runs under it. A command's root is its shell, which
 * stays the parent on Windows (cmd /c) and where a POSIX shell forks instead of exec.
 */
export async function runsUnder(pid, root, depth = 4) {
  let current = pid;
  for (let level = 0; level <= depth && current; level++) {
    if (current === root) return true;
    current = await parentOf(current);
  }
  return false;
}

/** The command line of the process that has `pid` now, or undefined if none has. */
export async function commandLineOf(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ],
      { windowsHide: true },
    );
    return stdout.trim() || undefined;
  }
  try {
    const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)]);
    return stdout.trim() || undefined;
  } catch (error) {
    // ps exits 1 when no process has the id.
    if (error.code === 1) return undefined;
    throw error;
  }
}
