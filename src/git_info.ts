import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
export function currentBranch(folder: string): string {
  for (let directory = resolve(folder); ; directory = dirname(directory)) {
    const marker = join(directory, '.git');
    try {
      if (existsSync(marker)) {
        let gitdir = marker;
        if (statSync(marker).isFile()) {
          const pointer = readFileSync(marker, 'utf8').trim();
          if (!pointer.startsWith('gitdir:')) return '';
          const raw = pointer.slice(7).trim();
          gitdir = isAbsolute(raw) ? raw : resolve(directory, raw);
        }
        const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
        return head.startsWith('ref: refs/heads/')
          ? head.slice(16)
          : head.slice(0, 7);
      }
    } catch {
      return '';
    }
    if (dirname(directory) === directory) return '';
  }
}
