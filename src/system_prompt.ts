import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { currentBranch } from './git_info.js';
import type { RunOptions } from './run_options.js';
const prompts = fileURLToPath(new URL('./prompts/', import.meta.url));
export function readPrompt(...parts: string[]): string {
  return readFileSync(join(prompts, ...parts), 'utf8').trim();
}
export function loadToolPrompt(name: string): string {
  const path = join(prompts, 'tools', name + '.md');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : name;
}
export function selectSessionPromptName(model: string): string {
  const name = model.toLowerCase();
  if (name.includes('muse')) return 'meta';
  if (name.includes('beast')) return 'beast';
  if (name.includes('gpt'))
    return name.includes('gpt-6')
      ? 'gpt-astra'
      : name.includes('codex')
        ? 'codex'
        : name.includes('copilot') && name.includes('gpt-5')
          ? 'copilot-gpt-5'
          : 'gpt';
  if (/^o[13]|\/o[13]/.test(name)) return 'gpt';
  if (/gemini/.test(name)) return 'gemini';
  if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return 'anthropic';
  if (name.includes('trinity')) return 'trinity';
  if (/kimi|moonshot/.test(name)) return 'kimi';
  return 'default';
}
export function discoverContextFiles(workspace: string): [string, string][] {
  const files: [string, string][] = [];
  const seen = new Set<string>();
  const root = resolve(workspace);
  for (let directory = root; ; directory = dirname(directory)) {
    for (const name of [
      'AGENTS.override.md',
      'AGENTS.md',
      'AGENTS.MD',
      'CLAUDE.md',
      'CLAUDE.MD',
    ]) {
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        const identity = `${stat.dev}:${stat.ino}`;
        if (!stat.isFile() || seen.has(identity)) continue;
        seen.add(identity);
        files.push([
          path,
          readFileSync(path).subarray(0, 120000).toString('utf8').trim(),
        ]);
      } catch {
        /* No instruction file here. */
      }
    }
    if (
      dirname(directory) === directory ||
      (existsSync(join(directory, '.git')) && directory !== root)
    )
      break;
  }
  return files;
}
export function buildSystemPrompt(
  workspace: string,
  model: string,
  protocol: string,
  options: RunOptions,
): string {
  const replacementPath = join(workspace, '.circle', 'SYSTEM.md');
  const base =
    options.system_prompt ||
    (existsSync(replacementPath) ? readFileSync(replacementPath, 'utf8') : '');
  let session =
    base ||
    readPrompt('session', selectSessionPromptName(model) + '.md')
      .replaceAll('{{MODEL_NAME}}', model)
      .replaceAll('You are circle,', 'You are Circle,')
      .replaceAll('trained by Meta MSL', 'used by Circle');
  for (const [from, to] of [
    ['TodoWrite', 'write_todos'],
    ['WebFetch', 'webfetch'],
    ['WebSearch', 'websearch'],
    ['`Bash`', '`execute`'],
    ['`Read`', '`read_file`'],
    ['`Write`', '`write_file`'],
    ['`Edit`', '`edit_file`'],
    ['`Glob`', '`glob`'],
    ['`Grep`', '`grep`'],
  ])
    session = session.replaceAll(from!, to!);
  const sections = [
    session,
    ...(base
      ? []
      : [readPrompt('circle_guidelines.md'), readPrompt('circle_paths.md')]),
  ];
  if (!options.no_context_files) {
    const files = discoverContextFiles(workspace);
    if (files.length)
      sections.push(
        '<project_context>\n' +
          files
            .map(
              ([path, text]) =>
                `<project_instructions path="${path}">\n${text}\n</project_instructions>`,
            )
            .join('\n\n') +
          '\n</project_context>',
      );
  }
  sections.push(
    `<env>\n  Working directory: ${workspace}\n  Platform: ${platform()}\n  Today's date: ${new Date().toISOString().slice(0, 10)}\n  Is directory a git repo: ${currentBranch(workspace) ? 'yes' : 'no'}\n  Model: ${model}\n  Protocol: ${protocol}\n</env>`,
  );
  const appendPath = join(workspace, '.circle', 'APPEND_SYSTEM.md');
  if (!options.append_system_prompt.length && existsSync(appendPath))
    sections.push(readFileSync(appendPath, 'utf8'));
  sections.push(...options.append_system_prompt);
  return sections.join('\n\n');
}
