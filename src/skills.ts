import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
    if (existsSync(path)) unique.set(realpathSync(path), label);
  return [...unique];
}
export function discoverSkills(
  workspace: string,
  home: string,
  userHome = homedir(),
): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const [root, label] of skillSources(workspace, home, userHome)) {
    const directories: string[] = [];
    for (const child of readdirSync(root, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    ))
      if (child.isDirectory()) {
        const directory = join(root, child.name);
        if (existsSync(join(directory, 'SKILL.md')))
          directories.push(directory);
        else
          for (const nested of readdirSync(directory, { withFileTypes: true }))
            if (
              nested.isDirectory() &&
              existsSync(join(directory, nested.name, 'SKILL.md'))
            )
              directories.push(join(directory, nested.name));
      }
    for (const directory of directories) {
      const path = realpathSync(join(directory, 'SKILL.md'));
      const { meta } = parseFrontmatter(readFileSync(path, 'utf8'));
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
