import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from './skills.js';
import type { Sandbox } from './sandbox.js';
export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  source: string;
  agent: string;
  model: string;
  argument_hint: string;
}
export function discoverCustomCommands(
  workspace: string,
  home: string,
  userHome = homedir(),
): CustomCommand[] {
  const roots = [
    join(userHome, '.config/opencode/commands'),
    join(userHome, '.pi/agent/prompts'),
    join(home, 'commands'),
    join(home, 'prompts'),
    ...[
      '.opencode/commands',
      '.pi/commands',
      '.pi/prompts',
      '.circle/commands',
      '.circle/prompts',
    ].map((path) => join(workspace, path)),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const root of roots)
    if (existsSync(root))
      for (const file of readdirSync(root)
        .sort()
        .filter((file) => file.endsWith('.md'))) {
        const source = join(root, file);
        const raw = readFileSync(source, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const name = (meta.name || basename(file, '.md'))
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!name) continue;
        // pi's fallback description: the first line that has text, cut at 60 characters.
        const first = Array.from(
          body
            .split('\n')
            .find((line) => line.trim())
            ?.trim() ?? '',
        );
        byName.set(name, {
          name,
          description: (
            meta.description ||
            (first.length > 60
              ? first.slice(0, 60).join('') + '...'
              : first.join('')) ||
            `Custom command ${name}`
          ).slice(0, 200),
          template: body.trim() || raw.trim(),
          source,
          agent: meta.agent || '',
          model: meta.model || '',
          argument_hint: meta['argument-hint'] || '',
        });
      }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function splitArguments(args: string): string[] {
  let quote = '';
  let word = '';
  let started = false;
  const out: string[] = [];
  for (const char of args) {
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        out.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return args.split(/\s+/).filter(Boolean);
  if (started) out.push(word);
  return out;
}
export function substituteArguments(template: string, args: string): string {
  const parts = splitArguments(args);
  const all = parts.join(' ');
  return template.replace(
    /\$\{(@|ARGUMENTS):-(.*?)\}|\$\{(\d+):-(.*?)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      every: string,
      allDefault: string,
      number: string,
      numDefault: string,
      start: string,
      length: string,
      bare: string,
    ) =>
      every
        ? all || allDefault
        : number
          ? parts[Number(number) - 1] || numDefault
          : start
            ? parts
                .slice(
                  Math.max(1, Number(start)) - 1,
                  length
                    ? Math.max(1, Number(start)) - 1 + Number(length)
                    : undefined,
                )
                .join(' ')
            : bare === '@' || bare === 'ARGUMENTS'
              ? all
              : parts[Number(bare) - 1] || '',
  );
}
export async function expandCommandTemplate(
  template: string,
  args: string,
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<string> {
  let text = substituteArguments(template, args);
  const matches = [...text.matchAll(/!`([^`]+)`/g)];
  for (const match of matches.reverse()) {
    const result = await sandbox.execute(match[1]!, signal, 30000);
    text =
      text.slice(0, match.index) +
      result.output.trim() +
      text.slice(match.index! + match[0].length);
  }
  return text;
}
