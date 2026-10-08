import { spawn, execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { expandUser } from './paths.js';
import {
  classifyCommand,
  DEFAULT_CREDENTIAL_FILES,
  wildcard,
} from './approvals.js';
const HOST_TOP = new Set(
  'Users home private Volumes tmp var opt Library System Applications usr etc bin sbin dev mnt media root proc run boot'.split(
    ' ',
  ),
);
export function isHostAbsolutePath(path: string): boolean {
  return (
    path.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    (path.startsWith('/') &&
      HOST_TOP.has(path.replace(/^\/+/, '').split('/')[0]!))
  );
}
export function shellEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value !== undefined &&
        !name
          .toUpperCase()
          .split(/[^A-Z0-9]+/)
          .some(
            (part) =>
              /^(KEYS?|TOKENS?|SECRETS?|PASS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|COOKIES?|PRIVATE)$/.test(
                part,
              ) || /(PASS|PASSWORD|PASSWD|TOKEN|SECRET|APIKEY)$/.test(part),
          ),
    ),
  );
}
function resolvedTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path
    ? path
    : join(
        resolvedTarget(parent),
        path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
      );
}
export class Sandbox {
  constructor(
    readonly workspace: string,
    readonly offloadRoot?: string,
    readonly credentialFiles = DEFAULT_CREDENTIAL_FILES,
  ) {}
  resolvePath(raw: string): string {
    if (raw.replace(/\\/g, '/').split('/').includes('..'))
      throw new Error('Path traversal not allowed');
    let full: string;
    const virtual = raw.replace(/^\/+/, '').replace(/\\/g, '/');
    const top = virtual.split('/')[0];
    if (
      this.offloadRoot &&
      [
        'conversation_history',
        'large_tool_results',
        'background_jobs',
      ].includes(top ?? '')
    )
      full = resolve(this.offloadRoot, virtual);
    else
      full = isHostAbsolutePath(raw)
        ? resolve(expandUser(raw))
        : resolve(this.workspace, virtual);
    return resolvedTarget(full);
  }
  isInside(raw: string): boolean {
    const rel = relative(this.workspace, this.resolvePath(raw));
    return (
      rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel)
    );
  }
  checkCredentialPath(path: string): void {
    const name = path.replace(/\\/g, '/').split('/').at(-1)!;
    if (this.credentialFiles.some((pattern) => wildcard(pattern, name)))
      throw new Error(
        `Denied by approval policy: '${name}' is a credential file`,
      );
  }
  checkMutablePath(path: string): void {
    this.checkCredentialPath(path);
    if (this.offloadRoot) {
      const rel = relative(
        resolvedTarget(resolve(this.offloadRoot, 'background_jobs')),
        resolvedTarget(path),
      );
      if (
        rel === '' ||
        (rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel))
      )
        throw new Error('Background job output is read-only');
    }
  }
  async execute(
    command: string,
    signal: AbortSignal,
    timeout = 120000,
  ): Promise<{ output: string; exit_code: number; timed_out: boolean }> {
    const found = classifyCommand(command, this.credentialFiles);
    if (found.verdict === 'DENY')
      throw new Error(found.message || found.reason);
    signal.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, {
        cwd: this.workspace,
        env: shellEnvironment(),
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let stopping = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      let windowsKill: Promise<void> | undefined;
      const collect = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        if (output.length > 2_000_000) output = output.slice(-2_000_000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const kill = (force: boolean): void => {
        if (!child.pid) return;
        if (process.platform === 'win32')
          windowsKill = new Promise<void>((resolveKilled) =>
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () =>
              resolveKilled(),
            ),
          );
        else
          try {
            process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            /* Group already gone. */
          }
      };
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        kill(false);
        escalation = setTimeout(() => kill(true), 500);
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        signal.removeEventListener('abort', stop);
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeout);
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', async (code) => {
        if (stopping) kill(true);
        await windowsKill;
        cleanup();
        resolveResult({
          output: signal.aborted
            ? output +
              '\nStopped: the user pressed esc, so the command was ended before it finished.'
            : timedOut
              ? output + '\nCommand timed out.'
              : output,
          exit_code: code ?? 130,
          timed_out: timedOut,
        });
      });
    });
  }
}
