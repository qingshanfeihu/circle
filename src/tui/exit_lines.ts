// What the terminal gets once the full screen is gone (0.5.0's run(): the stopped jobs, then
// `_resume_hint`): `2 background jobs stopped`, then the command that opens the conversation
// again, `To resume this session: circle --session circle-3f9a1c2e`, with the folder when
// Circle was started from another one.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRuntime } from '../runtime.js';

// `text` as one word of a command typed into your shell: cmd or PowerShell on Windows, a
// POSIX shell elsewhere (Python's subprocess.list2cmdline and shlex.quote).
export function shellWord(text: string, platform = process.platform): string {
  if (platform === 'win32') {
    const quote = !text || /[ \t]/.test(text);
    let word = '';
    let slashes = 0;
    for (const char of text) {
      if (char === '\\') slashes++;
      else if (char === '"') {
        word += '\\'.repeat(slashes * 2) + '\\"';
        slashes = 0;
      } else {
        word += '\\'.repeat(slashes) + char;
        slashes = 0;
      }
    }
    word += '\\'.repeat(quote ? slashes * 2 : slashes);
    return quote ? `"${word}"` : word;
  }
  if (!text) return "''";
  if (/^[\w@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

function samePlace(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

// The command, or '' when there is nothing to open again: an in-memory run (--no-session), or
// a conversation where nothing was said or named.
export function resumeHint(
  runtime: AgentRuntime,
  workspace: string,
  cwd = process.cwd(),
  platform = process.platform,
): string {
  if (runtime.runOptions.no_session) return '';
  const session = runtime.store.get(runtime.session.id);
  if (!session || (!session.title && !runtime.store.tree(session.id).length))
    return '';
  let command = `circle --session ${session.id}`;
  if (!samePlace(cwd, workspace))
    command += ' ' + shellWord(workspace, platform);
  return `To resume this session: ${command}`;
}

// The jobs still running are stopped as Circle closes; the count is read before that.
export function runningJobs(runtime: AgentRuntime): number {
  return runtime.jobs.list().filter((job) => job.status === 'running').length;
}

export function stoppedJobsLine(count: number): string {
  return count
    ? `${count} background job${count === 1 ? '' : 's'} stopped`
    : '';
}
