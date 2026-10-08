import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { glob } from 'glob';
import type { Tool, ToolContext } from './types.js';
import { Sandbox } from './sandbox.js';
import { loadToolPrompt } from './system_prompt.js';
import { applyPatch } from './apply_patch.js';
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface ToolHooks {
  todos?: (todos: Todo[]) => void;
  question?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  plan?: (enabled: boolean) => Promise<string>;
  task?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  skill?: (name: string) => Promise<string>;
  compact?: (hint: string, context: ToolContext) => Promise<string>;
}
const string = (args: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys)
    if (typeof args[key] === 'string') return args[key] as string;
  throw new Error(`missing string parameter: ${keys.join(' / ')}`);
};
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const text = (description: string) => ({ type: 'string', description });
const integer = (description: string, minimum = 1) => ({
  type: 'integer',
  minimum,
  description,
});
export function buildTools(sandbox: Sandbox, hooks: ToolHooks = {}): Tool[] {
  const read = new Set<string>();
  const tools: Tool[] = [];
  const add = (
    name: string,
    effect: Tool['effect'],
    parameters: Record<string, unknown>,
    run: Tool['run'],
  ): void => {
    tools.push({
      name,
      effect,
      parameters,
      description: loadToolPrompt(name),
      run,
    });
  };
  add(
    'read_file',
    'read',
    schema(
      {
        file_path: text('Path to read'),
        offset: integer('First line, 1 indexed'),
        limit: integer('Maximum lines'),
      },
      ['file_path'],
    ),
    async (args) => {
      const path = sandbox.resolvePath(
        string(args, 'file_path', 'filePath', 'path'),
      );
      sandbox.checkCredentialPath(path);
      if (statSync(path).isDirectory())
        return readdirSync(path, { withFileTypes: true })
          .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
          .join('\n');
      const content = readFileSync(path, 'utf8');
      read.add(path);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Math.min(2000, Number(args.limit) || 2000));
      const lines = content.split('\n');
      return lines
        .slice(offset - 1, offset - 1 + limit)
        .map(
          (line, index) =>
            `${offset + index}: ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`,
        )
        .join('\n');
    },
  );
  add(
    'write_file',
    'write',
    schema(
      { file_path: text('Path to write'), content: text('File contents') },
      ['file_path', 'content'],
    ),
    async (args) => {
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkCredentialPath(path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, string(args, 'content'));
      return `Wrote ${path}`;
    },
  );
  add(
    'edit_file',
    'write',
    schema(
      {
        file_path: text('Path to edit'),
        old_string: text('Exact text to replace'),
        new_string: text('Replacement'),
        replace_all: { type: 'boolean' },
      },
      ['file_path', 'old_string', 'new_string'],
    ),
    async (args) => {
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkCredentialPath(path);
      if (!read.has(path))
        throw new Error('read_file must be called before editing this file');
      const content = readFileSync(path, 'utf8');
      const old = string(args, 'old_string', 'oldString');
      const replacement = string(args, 'new_string', 'newString');
      if (!old) throw new Error('old_string cannot be empty');
      const count = content.split(old).length - 1;
      if (!count) throw new Error('oldString not found in content');
      if (count > 1 && !args.replace_all && !args.replaceAll)
        throw new Error(
          'Found multiple matches for oldString. Provide more surrounding lines or use replaceAll.',
        );
      writeFileSync(
        path,
        args.replace_all || args.replaceAll
          ? content.replaceAll(old, replacement)
          : content.replace(old, replacement),
      );
      return `Edited ${path}`;
    },
  );
  add(
    'apply_patch',
    'write',
    schema({ patchText: text('Patch in Begin Patch / End Patch format') }, [
      'patchText',
    ]),
    async (args) => applyPatch(string(args, 'patchText'), sandbox),
  );
  add('ls', 'read', schema({ path: text('Directory') }), async (args) => {
    const path = sandbox.resolvePath(String(args.path || '.'));
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
      .join('\n');
  });
  add(
    'glob',
    'read',
    schema({ pattern: text('Glob pattern'), path: text('Search directory') }, [
      'pattern',
    ]),
    async (args) => {
      const cwd = sandbox.resolvePath(String(args.path || '.'));
      const matches = await glob(string(args, 'pattern'), {
        cwd,
        nodir: true,
        dot: true,
        ignore: ['**/.git/**', '**/node_modules/**'],
        follow: false,
      });
      return matches
        .sort()
        .slice(0, 5000)
        .map((path) => join(cwd, path))
        .join('\n');
    },
  );
  add(
    'grep',
    'read',
    schema(
      {
        pattern: text('Regular expression'),
        path: text('Search root'),
        glob: text('Filename filter'),
      },
      ['pattern'],
    ),
    async (args, context) => {
      const cwd = sandbox.resolvePath(String(args.path || '.'));
      const regex = new RegExp(string(args, 'pattern'));
      const matches = await glob(String(args.glob || '**/*'), {
        cwd,
        nodir: true,
        dot: true,
        ignore: ['**/.git/**', '**/node_modules/**'],
      });
      const found: string[] = [];
      for (const item of matches.sort()) {
        context.signal.throwIfAborted();
        if (found.length >= 1000) break;
        const path = join(cwd, item);
        try {
          sandbox.checkCredentialPath(path);
          if (statSync(path).size > 2_000_000) continue;
          const buffer = readFileSync(path);
          if (buffer.includes(0)) continue;
          const lines = buffer.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && found.length < 1000; i++)
            if (regex.test(lines[i]!))
              found.push(
                `${relative(sandbox.workspace, path)}:${i + 1}: ${lines[i]!.slice(0, 2000)}`,
              );
        } catch {
          /* Non-readable files are omitted from search. */
        }
      }
      return found.join('\n') || 'No matches found.';
    },
  );
  add(
    'execute',
    'execute',
    schema(
      {
        command: text('Shell command'),
        timeout: integer('Timeout in seconds'),
      },
      ['command'],
    ),
    async (args, context) => {
      const result = await sandbox.execute(
        string(args, 'command'),
        context.signal,
        Math.max(1, Number(args.timeout) || 120) * 1000,
      );
      return `${result.output}\nExit code: ${result.exit_code}`;
    },
  );
  add(
    'write_todos',
    'read',
    schema(
      {
        todos: {
          type: 'array',
          items: schema(
            {
              content: text('Step'),
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            ['content', 'status'],
          ),
        },
      },
      ['todos'],
    ),
    async (args) => {
      if (
        !Array.isArray(args.todos) ||
        args.todos.some(
          (todo) =>
            typeof todo?.content !== 'string' ||
            !['pending', 'in_progress', 'completed'].includes(todo.status),
        )
      )
        throw new Error('invalid todo list');
      hooks.todos?.(args.todos as Todo[]);
      return 'Updated todo list.';
    },
  );
  if (hooks.question)
    add(
      'question',
      'read',
      schema(
        {
          questions: {
            type: 'array',
            items: schema(
              {
                question: text('Question'),
                options: {
                  type: 'array',
                  items: schema(
                    { label: text('Option'), description: text('Details') },
                    ['label'],
                  ),
                },
              },
              ['question'],
            ),
          },
        },
        ['questions'],
      ),
      hooks.question,
    );
  if (hooks.plan) {
    add('plan_enter', 'read', schema({}), async () => hooks.plan!(true));
    add('plan_exit', 'read', schema({}), async () => hooks.plan!(false));
  }
  if (hooks.task)
    add(
      'task',
      'read',
      schema(
        {
          description: text('Subagent task'),
          subagent_type: text('general-purpose or explore'),
        },
        ['description'],
      ),
      hooks.task,
    );
  if (hooks.skill)
    add(
      'skill',
      'read',
      schema({ name: text('Skill name') }, ['name']),
      async (args) => hooks.skill!(string(args, 'name')),
    );
  if (hooks.compact)
    add(
      'compact_conversation',
      'read',
      schema({ hint: text('Summary guidance') }),
      async (args, context) => hooks.compact!(String(args.hint || ''), context),
    );
  add(
    'webfetch',
    'read',
    schema({ url: text('URL to fetch') }, ['url']),
    async (args, context) => {
      const url = new URL(string(args, 'url'));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('use an http(s) URL without credentials');
      const response = await fetch(url, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(20000)]),
        headers: { 'User-Agent': 'Circle/0.1' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 2_000_000)
        throw new Error('response exceeds 2 MB');
      return new TextDecoder()
        .decode(buffer)
        .replace(
          /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,
          '',
        )
        .replace(/<[^>]+>/g, ' ')
        .slice(0, 100000);
    },
  );
  return tools;
}
