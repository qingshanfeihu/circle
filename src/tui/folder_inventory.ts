// What trusting a folder loads from the folder itself, found by the same loaders the session
// uses: its instruction files, skills (up to the git root, as `.agents/skills` is looked
// for), custom commands, extensions and project settings. Your own skills, commands and
// extensions are not the folder's and are left out (ported from circle/trust.py).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { discoverCustomCommands } from '../commands.js';
import { ExtensionHost } from '../extensions.js';
import { memorySourcePaths } from '../memory_sources.js';
import { discoverSkills } from '../skills.js';
import { displayPath } from './status_rows.js';

export interface FolderItem {
  kind: 'instructions' | 'skills' | 'commands' | 'extensions' | 'settings';
  count: number;
  where: string;
  names: string[];
}
// A folder that does not exist: the loaders look there for your own things and find none.
const NOWHERE = '/nonexistent-circle-user-home';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function folderInventory(workspace: string): FolderItem[] {
  const folder = real(workspace);
  const inside = (path: string): boolean => {
    const rel = relative(folder, real(path));
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  const shown = (path: string): string => {
    const rel = relative(folder, real(path));
    return !rel.startsWith('..') && !isAbsolute(rel)
      ? rel || '.'
      : displayPath(path);
  };
  const whereOf = (paths: string[]): string => {
    const roots = [...new Set(paths.map(shown))].sort();
    return roots.length === 1
      ? roots[0]!
      : roots.slice(0, 2).join(', ') + (roots.length > 2 ? ' …' : '');
  };
  const items: FolderItem[] = [];
  const instructions = memorySourcePaths(folder, undefined, NOWHERE).filter(
    inside,
  );
  if (instructions.length)
    items.push({
      kind: 'instructions',
      count: instructions.length,
      where: whereOf(instructions),
      names: instructions.map(shown),
    });
  const skills = discoverSkills(folder, NOWHERE, NOWHERE).filter(
    (skill) =>
      skill.source_label.startsWith('Project') ||
      skill.source_label.startsWith('Ancestor'),
  );
  if (skills.length)
    items.push({
      kind: 'skills',
      count: skills.length,
      where: whereOf(skills.map((skill) => dirname(dirname(skill.path)))),
      names: skills.map((skill) => skill.name),
    });
  const commands = discoverCustomCommands(folder, NOWHERE, NOWHERE).filter(
    (command) => inside(command.source),
  );
  if (commands.length)
    items.push({
      kind: 'commands',
      count: commands.length,
      where: whereOf(commands.map((command) => dirname(command.source))),
      names: commands.map((command) => command.name),
    });
  const extensions = new ExtensionHost({
    home: NOWHERE,
    workspace: folder,
    trusted: true,
  })
    .discover()
    .filter((found) => found.source === 'project');
  if (extensions.length)
    items.push({
      kind: 'extensions',
      count: extensions.length,
      where: whereOf(extensions.map((found) => dirname(dirname(found.path)))),
      names: extensions.map((found) => found.name),
    });
  const settings = join(folder, '.circle', 'settings.json');
  if (existsSync(settings) && statSync(settings).isFile())
    items.push({
      kind: 'settings',
      count: 1,
      where: shown(settings),
      names: [],
    });
  return items;
}

// The row's words: the instruction files by name, settings by where they are, the rest as
// `3 in .circle/skills`.
export function folderItemText(item: FolderItem): string {
  if (item.kind === 'instructions') return item.names.join(', ');
  if (item.kind === 'settings') return item.where;
  return `${item.count} in ${item.where}`;
}
