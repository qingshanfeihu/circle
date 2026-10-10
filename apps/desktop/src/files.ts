import { readFile, stat, lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeFile, NativeWorkspace } from './contracts';
import { MAX_FILE_BYTES, MAX_TEXT_PREVIEW } from './policy.ts';
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
export async function nativeFile(
  path: string,
  maxTextBytes = MAX_TEXT_PREVIEW,
): Promise<NativeFile> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    throw Error('file exceeds the 4 MB limit or is not a regular file');
  const extension = extname(path).toLowerCase();
  const bytes = await readFile(path);
  const mime =
    imageTypes[extension] ??
    (extension === '.pdf' ? 'application/pdf' : 'text/plain');
  if (imageTypes[extension])
    return {
      id: randomUUID(),
      name: basename(path),
      mime,
      size: bytes.length,
      content: `data:${mime};base64,${bytes.toString('base64')}`,
      kind: 'image',
      truncated: false,
    };
  if (extension === '.pdf')
    return {
      id: randomUUID(),
      name: basename(path),
      mime,
      size: bytes.length,
      content:
        'PDF metadata retained; binary delivery needs the Circle runtime.',
      kind: 'document',
      truncated: false,
    };
  return {
    id: randomUUID(),
    name: basename(path),
    mime,
    size: bytes.length,
    content: bytes.subarray(0, maxTextBytes).toString('utf8'),
    kind: 'file',
    truncated: bytes.length > maxTextBytes,
  };
}
export class WorkspaceGrants {
  private roots = new Map<string, string>();
  private files = new Map<string, { workspaceId: string; path: string }>();
  async open(path: string): Promise<NativeWorkspace> {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory())
      throw Error('workspace is not a folder');
    const id = randomUUID();
    const result: NativeWorkspace = {
      id,
      name: basename(root),
      path: root,
      files: [],
      truncated: false,
    };
    this.roots.set(id, root);
    const walk = async (folder: string, depth: number) => {
      if (depth > 12 || result.files.length >= 2000) {
        result.truncated = true;
        return;
      }
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (result.files.length >= 2000) {
          result.truncated = true;
          break;
        }
        if (
          [
            '.git',
            'node_modules',
            '.circle',
            '.venv',
            'dist',
            'build',
            'coverage',
          ].includes(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const target = join(folder, entry.name);
        if (entry.isDirectory()) await walk(target, depth + 1);
        else if (entry.isFile()) {
          const fileId = randomUUID();
          this.files.set(fileId, { workspaceId: id, path: target });
          const extension = extname(entry.name).slice(1);
          result.files.push({
            id: fileId,
            path: relative(root, target).split('\\').join('/'),
            language:
              (
                {
                  ts: 'typescript',
                  tsx: 'typescript',
                  js: 'javascript',
                  json: 'json',
                  md: 'markdown',
                  py: 'python',
                } as Record<string, string>
              )[extension] ?? 'text',
          });
        }
      }
    };
    await walk(root, 0);
    return result;
  }
  async read(workspaceId: string, fileId: string) {
    const root = this.roots.get(workspaceId);
    const grant = this.files.get(fileId);
    if (!root || !grant || grant.workspaceId !== workspaceId)
      throw Error('file is not granted to this workspace');
    if ((await lstat(grant.path)).isSymbolicLink())
      throw Error('symbolic link was not granted');
    const path = await realpath(grant.path);
    const local = relative(root, path);
    if (local.startsWith('..') || isAbsolute(local))
      throw Error('file moved outside the selected workspace');
    const value = await nativeFile(path);
    return { ...value, id: fileId, name: local.split('\\').join('/') };
  }
}
