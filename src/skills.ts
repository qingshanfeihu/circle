import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source_label: string;
}
export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = match[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = line.match(/^([^:]+):\s*(.*)$/);
    if (!entry) continue;
    const key = entry[1]!.trim().toLowerCase();
    let value = entry[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())
      )
        block.push(lines[++i]!);
      value = value.startsWith('>')
        ? block
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ')
        : block.join('\n').trim();
    }
    meta[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}
export function skillSources(
  workspace: string,
  home: string,
  userHome = homedir(),
): [string, string][] {
  const sources: [string, string][] = [
    [join(userHome, '.agents/skills'), 'Agents'],
    [join(userHome, '.claude/skills'), 'Claude'],
    [join(userHome, '.config/opencode/skills'), 'OpenCode'],
    [join(userHome, '.pi/agent/skills'), 'Pi'],
    [join(home, 'skills'), 'Circle'],
  ];
  for (let directory = resolve(workspace); ; directory = dirname(directory)) {
    sources.push([
      join(directory, '.agents/skills'),
      directory === resolve(workspace) ? 'Project Agents' : 'Ancestor Agents',
    ]);
    if (existsSync(join(directory, '.git')) || dirname(directory) === directory)
      break;
  }
  for (const [path, label] of [
    ['.opencode/skills', 'Project OpenCode'],
    ['.pi/skills', 'Project Pi'],
    ['.claude/skills', 'Project Claude'],
    ['.circle/skills', 'Project Circle'],
    ['.agent/skills', 'Project'],
  ])
    sources.push([join(workspace, path!), label!]);
  const unique = new Map<string, string>();
  for (const [path, label] of sources)
    try {
      if (statSync(path).isDirectory()) unique.set(realpathSync(path), label);
    } catch {
      /* No skills folder here. */
    }
  return [...unique];
}
// The skill folders are read again on every rebuild of the system prompt, so a folder
// that cannot be read is passed over rather than stopping a model switch or /reload.
// A linked skill folder counts, as in 0.5.0 (`npx skills add` links them).
function folders(directory: string): string[] {
  let found: Dirent[];
  try {
    found = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return found
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => {
      try {
        return statSync(join(directory, name)).isDirectory();
      } catch {
        return false;
      }
    });
}
export function discoverSkills(
  workspace: string,
  home: string,
  userHome = homedir(),
): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const [root, label] of skillSources(workspace, home, userHome)) {
    const directories: string[] = [];
    for (const child of folders(root)) {
      const directory = join(root, child);
      if (existsSync(join(directory, 'SKILL.md'))) directories.push(directory);
      else
        for (const nested of folders(directory))
          if (existsSync(join(directory, nested, 'SKILL.md')))
            directories.push(join(directory, nested));
    }
    for (const directory of directories) {
      let path: string;
      let text: string;
      try {
        path = realpathSync(join(directory, 'SKILL.md'));
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const { meta } = parseFrontmatter(text);
      let name = (meta.name || basename(directory)).toLowerCase().trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        name = basename(directory)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
      if (name)
        byName.set(name, {
          name,
          description: (
            meta.description || `Skill from ${basename(directory)}`
          ).slice(0, 1024),
          path,
          source_label: label,
        });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function loadSkillBody(name: string, catalog: SkillInfo[]): string {
  const skill = catalog.find(
    (skill) => skill.name === name.trim().toLowerCase(),
  );
  if (!skill)
    throw new Error(
      `skill '${name}' not found. Available: ${catalog.map((skill) => skill.name).join(', ') || '(none)'}`,
    );
  return `<skill_content name="${skill.name}">\n${readFileSync(skill.path, 'utf8').trim()}\n\nBase directory for this skill: ${dirname(skill.path)}\nRelative paths in this skill are relative to this base directory.\n</skill_content>`;
}
