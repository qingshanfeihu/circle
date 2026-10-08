import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
const SKIP = new Set(
  '.git node_modules .venv venv __pycache__ .mypy_cache .pytest_cache .tox dist build .next .cache'.split(
    ' ',
  ),
);
export function attachFiles(text: string, root: string): string {
  root = realpathSync(root);
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const match of text.matchAll(/(?<!\S)@([^\s@]+)/g)) {
    const raw = match[1]!.replace(/[.,;:!?)]+$/, '');
    const path = resolve(root, raw);
    try {
      const full = realpathSync(path);
      const rel = relative(root, full);
      if (
        rel === '..' ||
        rel.startsWith('..' + sep) ||
        seen.has(full) ||
        !statSync(full).isFile() ||
        statSync(full).size > 65536
      )
        continue;
      const data = readFileSync(full);
      const body = new TextDecoder('utf-8', { fatal: true }).decode(data);
      seen.add(full);
      blocks.push(
        `<file path="${rel.split(sep).join('/')}">\n${body.trimEnd()}\n</file>`,
      );
    } catch {
      /* Missing, outside, binary, or oversized attachments are omitted. */
    }
  }
  return blocks.length ? text + '\n\n' + blocks.join('\n\n') : text;
}
export function complete(partial: string, root: string, limit = 20): string[] {
  const slash = partial.lastIndexOf('/');
  const folderPart = partial.slice(0, slash + 1);
  const prefix = partial.slice(slash + 1);
  const folder = resolve(root, folderPart || '.');
  const relFolder = relative(root, folder);
  if (relFolder === '..' || relFolder.startsWith('..' + sep)) return [];
  const found: string[] = [];
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    ))
      if (
        !SKIP.has(entry.name) &&
        (!entry.name.startsWith('.') || prefix.startsWith('.')) &&
        entry.name.startsWith(prefix)
      )
        found.push(
          relative(root, join(folder, entry.name)).split(sep).join('/') +
            (entry.isDirectory() ? '/' : ''),
        );
  } catch {
    /* Search by basename below. */
  }
  if (found.length || partial.includes('/') || !partial)
    return found.slice(0, limit);
  let count = 0;
  const walk = (directory: string): void => {
    if (!existsSync(directory) || count >= 5000) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !SKIP.has(entry.name)
      )
        walk(join(directory, entry.name));
      else if (
        entry.isFile() &&
        ++count <= 5000 &&
        entry.name.toLowerCase().includes(partial.toLowerCase())
      )
        found.push(relative(root, join(directory, entry.name)));
    }
  };
  walk(root);
  return found
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}
