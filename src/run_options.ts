import { existsSync, readFileSync, statSync } from 'node:fs';
import { expandUser } from './paths.js';
export const TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  bash: 'execute',
  find: 'glob',
};
export function toolNames(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => TOOL_ALIASES[value] ?? value);
}
export function promptText(value: string): string {
  try {
    const path = expandUser(value);
    if (!value.includes('\n') && existsSync(path) && statSync(path).isFile())
      return readFileSync(path, 'utf8');
  } catch {
    /* A literal prompt need not be a path. */
  }
  return value;
}
export interface RunOptions {
  system_prompt?: string;
  append_system_prompt: string[];
  no_context_files: boolean;
  tools: string[] | null;
  exclude_tools: string[];
  session_name: string;
  no_session: boolean;
  models: string[];
}
export const defaultRunOptions = (): RunOptions => ({
  append_system_prompt: [],
  no_context_files: false,
  tools: null,
  exclude_tools: [],
  session_name: '',
  no_session: false,
  models: [],
});
export function limitsTools(options: RunOptions): boolean {
  return options.tools !== null || options.exclude_tools.length > 0;
}
