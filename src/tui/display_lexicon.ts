// Tool rows: the short name and one short phrase for the arguments, declared in one place
// so the transcript only looks things up (ported from circle/display_lexicon.py).
import type { ToolCall } from '../types.js';

export const TOOL_SHORT_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  apply_patch: 'Patch',
  delete: 'Delete',
  ls: 'Ls',
  glob: 'Glob',
  grep: 'Grep',
  execute: 'Bash',
  task: 'Agent',
  write_todos: 'TodoWrite',
  webfetch: 'Fetch',
  websearch: 'Search',
  question: 'Question',
  skill: 'Skill',
  lsp: 'Lsp',
  compact_conversation: 'Compact',
  list_jobs: 'Jobs',
  stop_job: 'StopJob',
  wait_jobs: 'WaitJobs',
};

type Style = 'path_tail' | 'first_line' | 'patch_target' | 'text';
// Tool name → (argument, how to shorten it), the first one with a value wins.
const TOOL_ARG_SUMMARY: Record<string, [string, Style][]> = {
  read_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  write_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  edit_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  delete: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  apply_patch: [['patchText', 'patch_target']],
  ls: [['path', 'path_tail']],
  glob: [['pattern', 'text']],
  grep: [['pattern', 'text']],
  execute: [['command', 'first_line']],
  task: [
    ['description', 'first_line'],
    ['subagent_type', 'text'],
  ],
  webfetch: [['url', 'text']],
  websearch: [['query', 'text']],
  question: [['questions', 'first_line']],
  skill: [
    ['name', 'text'],
    ['skill', 'text'],
  ],
  lsp: [
    ['operation', 'text'],
    ['file_path', 'path_tail'],
  ],
  stop_job: [['job_id', 'text']],
};
const SUMMARY_MAX = 60;

export function toolShortName(name: string): string {
  return TOOL_SHORT_NAMES[name] ?? name;
}

function clip(text: string, width = SUMMARY_MAX): string {
  const plain = String(text).split(/\s+/).filter(Boolean).join(' ');
  const chars = Array.from(plain);
  return chars.length > width
    ? chars.slice(0, width - 1).join('') + '…'
    : plain;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'object')
    return '';
  return String(value).trim();
}

function summarize(style: Style, value: unknown): string {
  const text = scalar(value);
  if (!text) return '';
  if (style === 'path_tail') {
    const parts = text.replaceAll('\\', '/').split('/').filter(Boolean);
    const tail = parts.length > 2 ? parts.slice(-2).join('/') : text;
    return clip(tail === text ? tail : `…/${tail}`);
  }
  if (style === 'first_line') return clip(text.split(/\r?\n/)[0] ?? '');
  if (style === 'patch_target') {
    const match = text.match(/\*\*\* (?:Add|Update|Delete) File:\s*(\S+)/);
    return match ? summarize('path_tail', match[1]) : '';
  }
  return clip(text);
}

// A value the model sent as text that did not parse: `"key": "value"` in the raw arguments.
function fromRaw(raw: string | undefined, key: string): string {
  if (!raw) return '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(
    new RegExp(`['"]?${escaped}['"]?\\s*[:=]\\s*['"]([^'"]+)['"]`),
  );
  return match?.[1] ?? '';
}

// One short phrase for the tool row; a tool not in the table shows its first scalar
// argument, and nothing at all rather than an object.
export function toolArgSummary(
  call: Pick<ToolCall, 'name' | 'args' | 'raw_args'>,
): string {
  const name = call.name;
  const values: Record<string, unknown> =
    call.args && typeof call.args === 'object' ? call.args : {};
  const value = (key: string): unknown =>
    scalar(values[key])
      ? values[key]
      : fromRaw(call.raw_args, key) || undefined;
  if (name === 'execute') {
    const command = String(value('command') ?? '');
    const lines = command.split(/\r?\n/);
    const first = lines[0] ?? '';
    if (first.includes('<<')) {
      const head = first.split('<<')[0]!.trim();
      const comment =
        lines
          .slice(1)
          .find((line) => line.trim().startsWith('#'))
          ?.trim()
          .replace(/^#+/, '')
          .trim() ?? '';
      return clip(`${head} · ${comment || 'multiline script'}`);
    }
    return clip(first);
  }
  if (name === 'question') {
    const asked = values.questions;
    if (Array.isArray(asked) && asked[0] && typeof asked[0] === 'object')
      return summarize(
        'first_line',
        (asked[0] as Record<string, unknown>).question,
      );
    return summarize('first_line', fromRaw(call.raw_args, 'question'));
  }
  const table = TOOL_ARG_SUMMARY[name];
  if (table) {
    for (const [key, style] of table) {
      const shown = summarize(style, value(key));
      if (shown) return shown;
    }
    return '';
  }
  for (const key of [
    'file_path',
    'path',
    'name',
    'batch',
    'autoid',
    'query',
    'pattern',
  ]) {
    const found = values[key];
    if (typeof found === 'string' && found)
      return summarize(
        key === 'file_path' || key === 'path' ? 'path_tail' : 'text',
        found,
      );
  }
  for (const found of Object.values(values)) {
    const shown = summarize('text', found);
    if (shown) return shown;
  }
  return '';
}
