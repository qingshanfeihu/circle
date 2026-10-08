import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Sandbox } from './sandbox.js';
interface Change {
  path: string;
  original: string | null;
  content: string | null;
}
export function applyPatch(patch: string, sandbox: Sandbox): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '*** Begin Patch')
    throw new Error('patch must start with *** Begin Patch');
  const end = lines.indexOf('*** End Patch');
  if (end < 0 || lines.slice(end + 1).some((line) => line.trim()))
    throw new Error('patch must end with *** End Patch');
  lines.splice(end);
  const changes: Change[] = [];
  const seen = new Set<string>();
  let i = 0;
  const add = (change: Change): void => {
    sandbox.checkCredentialPath(change.path);
    if (seen.has(change.path))
      throw new Error('a path appears more than once in the patch');
    seen.add(change.path);
    changes.push(change);
  };
  while (i < lines.length) {
    const header = lines[i++]!.match(
      /^\*\*\* (Add File|Update File|Delete File): (.+)$/,
    );
    if (!header) throw new Error('invalid patch header');
    const kind = header[1]!;
    const path = sandbox.resolvePath(header[2]!);
    sandbox.checkCredentialPath(path);
    const original = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (kind === 'Delete File') {
      if (original === null) throw new Error('cannot delete a missing file');
      add({ path, original, content: null });
      continue;
    }
    if (kind === 'Add File') {
      if (original !== null) throw new Error('cannot add an existing file');
      const body: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const line = lines[i++]!;
        if (!line.startsWith('+'))
          throw new Error('added lines must start with +');
        body.push(line.slice(1));
      }
      add({ path, original, content: body.join('\n') + '\n' });
      continue;
    }
    if (original === null) throw new Error('cannot update a missing file');
    let move: string | undefined;
    if (lines[i]?.startsWith('*** Move to: '))
      move = sandbox.resolvePath(lines[i++]!.slice(13));
    const textLines = original.split('\n');
    if (textLines.at(-1) === '') textLines.pop();
    let cursor = 0;
    let applied = false;
    while (
      i < lines.length &&
      !/^\*\*\* (Add File|Update File|Delete File):/.test(lines[i]!)
    ) {
      const heading = lines[i++]!;
      if (heading !== '@@' && !heading.startsWith('@@ '))
        throw new Error('expected @@ hunk header');
      if (heading.length > 3) {
        const anchor = heading.slice(3);
        const index = textLines.indexOf(anchor, cursor);
        if (index < 0) throw new Error('hunk anchor not found');
        cursor = index + 1;
      }
      const old: string[] = [];
      const replacement: string[] = [];
      let eof = false;
      while (
        i < lines.length &&
        !lines[i]!.startsWith('@@') &&
        !/^\*\*\* (Add File|Update File|Delete File):/.test(lines[i]!)
      ) {
        const line = lines[i++]!;
        if (line === '*** End of File') {
          eof = true;
          break;
        }
        if (![' ', '+', '-'].includes(line[0] ?? ''))
          throw new Error('invalid hunk line');
        if (line[0] !== '+') old.push(line.slice(1));
        if (line[0] !== '-') replacement.push(line.slice(1));
      }
      let position = -1;
      for (let at = cursor; at <= textLines.length - old.length; at++) {
        if (
          old.every((line, index) => textLines[at + index] === line) &&
          (!eof || at + old.length === textLines.length)
        ) {
          position = at;
          break;
        }
      }
      if (position < 0) throw new Error('hunk context not found');
      textLines.splice(position, old.length, ...replacement);
      cursor = position + replacement.length;
      applied = true;
    }
    if (!applied) throw new Error('update has no hunks');
    const content = textLines.join('\n') + '\n';
    if (move) {
      if (existsSync(move)) throw new Error('move destination already exists');
      add({ path: move, original: null, content });
      add({ path, original, content: null });
    } else add({ path, original, content });
  }
  if (!changes.length) throw new Error('patch contains no changes');
  const completed: Change[] = [];
  try {
    for (const change of changes) {
      if (change.content === null) unlinkSync(change.path);
      else {
        mkdirSync(dirname(change.path), { recursive: true });
        writeFileSync(change.path, change.content);
      }
      completed.push(change);
    }
  } catch (error) {
    for (const change of completed.reverse()) {
      if (change.original === null) {
        if (existsSync(change.path)) unlinkSync(change.path);
      } else writeFileSync(change.path, change.original);
    }
    throw error;
  }
  return (
    'Success. Updated the following files:\n' +
    changes
      .map(
        (change) =>
          `${change.original === null ? 'A' : change.content === null ? 'D' : 'M'} ${change.path}`,
      )
      .join('\n')
  );
}
