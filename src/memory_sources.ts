import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export function fileIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    return undefined;
  }
}
export function memorySourcePaths(
  workspace: string,
  home?: string,
  userHome = homedir(),
): string[] {
  const names = ['AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'agents.md'];
  const candidates: string[] = [];
  if (home) {
    for (const name of names) candidates.push(join(home, name));
    candidates.push(join(home, 'memory', 'AGENTS.md'));
  }
  for (const name of names) candidates.push(join(userHome, '.agents', name));
  candidates.push(join(userHome, '.deepagents', 'AGENTS.md'));
  for (const name of names) candidates.push(join(workspace, name));
  for (const path of [
    '.agent/AGENTS.md',
    '.circle/AGENTS.md',
    '.deepagents/AGENTS.md',
  ])
    candidates.push(join(workspace, path));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of candidates) {
    const identity = fileIdentity(path);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(realpathSync(path));
  }
  return result;
}
export function formatMemorySources(
  workspace: string,
  home?: string,
  excluded: string[] = [],
  noContextFiles = false,
  userHome = homedir(),
): string {
  const seen = new Set(
    excluded
      .map(fileIdentity)
      .filter((value): value is string => value !== undefined),
  );
  const blocks: string[] = [];
  for (const path of memorySourcePaths(workspace, home, userHome)) {
    const identity = fileIdentity(path);
    if (!identity || seen.has(identity)) continue;
    const name = path.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase();
    if (
      noContextFiles &&
      ['agents.md', 'agents.override.md', 'claude.md'].includes(name)
    )
      continue;
    seen.add(identity);
    try {
      blocks.push(
        `<memory_file path="${path}">\n${readFileSync(path).subarray(0, 120000).toString('utf8').trim()}\n</memory_file>`,
      );
    } catch {
      /* A removed memory file must not break the request. */
    }
  }
  return blocks.length
    ? '<memory>\n' + blocks.join('\n\n') + '\n</memory>'
    : '';
}
