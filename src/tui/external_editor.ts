import { statSync } from 'node:fs';
import { splitArguments } from '../commands.js';
import { findExecutable } from '../lsp_tool.js';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
/**
 * The editor /editor (ctrl+g) runs, as the words of a command, in 0.5.0's order: $VISUAL,
 * $EDITOR, the first of nvim, vim and nano on PATH, then notepad on Windows. Undefined when
 * there is none. A program that exists as written is one word (a path with spaces); anything
 * else is split as a shell would, so `code -w` works.
 */
export function editorCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (command: string) => string | undefined = (command) =>
    findExecutable(command, env),
): string[] | undefined {
  const editor =
    env.VISUAL?.trim() ||
    env.EDITOR?.trim() ||
    ['nvim', 'vim', 'nano'].find((name) => find(name)) ||
    (platform === 'win32' ? 'notepad' : '');
  if (!editor) return undefined;
  if (find(editor) || isFile(editor)) return [editor];
  return splitArguments(editor);
}
