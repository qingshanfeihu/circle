import { webFetch, webSearch } from './websearch.js';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { glob } from 'glob';
import type { Tool, ToolContext } from './types.js';
import { Sandbox } from './sandbox.js';
import { loadToolPrompt } from './system_prompt.js';
import { applyPatch } from './apply_patch.js';
import { QUESTION_SCHEMA } from './questions.js';
import { JobRegistry, jobLine, jobNotice } from './jobs.js';
import { readTextWindow } from './file_read.js';
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface ToolHooks {
  jobs?: JobRegistry;
  jobOwner?: (context: ToolContext) => import('./jobs.js').JobOwner;
  todos?: (todos: Todo[]) => void;
  question?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  plan?: (enabled: boolean, context: ToolContext) => Promise<string>;
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
        offset: {
          type: 'integer',
          default: 0,
          description:
            'Lines to skip, 0 indexed; negative values start at the first line',
        },
        limit: {
          type: 'integer',
          default: 2000,
          description: 'Maximum lines; non-positive values request no lines',
        },
      },
      ['file_path'],
    ),
    async (args, context) => {
      const path = sandbox.resolvePath(
        string(args, 'file_path', 'filePath', 'path'),
      );
      sandbox.checkCredentialPath(path);
      if (statSync(path).isDirectory())
        return readdirSync(path, { withFileTypes: true })
          .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
          .join('\n');
      const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)));
      const limit = Math.max(0, Math.trunc(Number(args.limit ?? 2000)));
      const content = await readTextWindow(path, offset, limit, context.signal);
      read.add(path);
      return content;
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
      sandbox.checkMutablePath(path);
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
      sandbox.checkMutablePath(path);
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
        timeout: integer(
          'Timeout in seconds; 0 disables a background deadline',
          0,
        ),
        background: {
          type: 'boolean',
          description:
            'Run as a background job; a notice arrives when it ends. Do not poll or sleep.',
        },
      },
      ['command'],
    ),
    async (args, context) => {
      if (hooks.jobs) {
        const owner = hooks.jobOwner?.(context) ?? {
          sessionId: context.sessionId,
          startedBy: 'model' as const,
        };
        const command = string(args, 'command');
        if (args.background === true) {
          context.signal.throwIfAborted();
          const job = hooks.jobs.startShell(
            command,
            owner,
            args.timeout === undefined ? undefined : Number(args.timeout),
          );
          return `In background: ${jobLine(job)}. A notice will arrive when it ends; do not poll or sleep.`;
        }
        const result = await hooks.jobs.execute(
          command,
          owner,
          context.signal,
          args.timeout === undefined ? undefined : Number(args.timeout),
        );
        return result.job
          ? result.output
          : `${result.output}\nExit code: ${result.exit_code}`;
      }
      if (args.background === true)
        throw new Error('background commands are not available here');
      const result = await sandbox.execute(
        string(args, 'command'),
        context.signal,
        Math.max(1, Number(args.timeout) || 120) * 1000,
      );
      return `${result.output}\nExit code: ${result.exit_code}`;
    },
  );
  if (hooks.jobs) {
    add('list_jobs', 'read', schema({}), async (_args, context) => {
      const owner = hooks.jobOwner?.(context) ?? {
        sessionId: context.sessionId,
      };
      const mine = hooks.jobs!.list(owner.sessionId);
      const others = hooks
        .jobs!.list()
        .filter(
          (job) =>
            job.sessionId !== owner.sessionId && job.status === 'running',
        );
      return (
        (mine.map(jobLine).join('\n') ||
          'No background jobs in this conversation.') +
        (others.length
          ? `\n${others.length} more running in other conversations.`
          : '')
      );
    });
    add(
      'stop_job',
      'read',
      schema({ job_id: text('Job id, such as j3') }, ['job_id']),
      async (args) => {
        const id = string(args, 'job_id');
        await hooks.jobs!.stop(id);
        return `Stopped ${id}.`;
      },
    );
    tools.at(-1)!.approval = false;
    add(
      'wait_jobs',
      'read',
      schema(
        {
          job_ids: { type: 'array', items: { type: 'string' } },
          timeout_s: { type: 'integer', minimum: 1, maximum: 600 },
        },
        ['job_ids'],
      ),
      async (args, context) => {
        const jobs = await hooks.jobs!.wait(
          args.job_ids as string[],
          Number(args.timeout_s) || 300,
          context.signal,
        );
        const ended = jobs.filter((job) => job.status !== 'running');
        const owner = hooks.jobOwner?.(context) ?? {
          sessionId: context.sessionId,
        };
        hooks.jobs!.takeNotices(
          owner.sessionId,
          ended.map((job) => job.id),
        );
        return ended.length
          ? ended.map(jobNotice).join('\n\n') +
              (jobs.some((job) => job.status === 'running')
                ? '\nStill running: ' +
                  jobs
                    .filter((job) => job.status === 'running')
                    .map((job) => job.id)
                    .join(', ')
                : '')
          : 'Still running: ' + jobs.map(jobLine).join('\n');
      },
    );
  }
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
  if (hooks.question) add('question', 'read', QUESTION_SCHEMA, hooks.question);
  if (hooks.plan) {
    add('plan_enter', 'read', schema({}), async (_args, context) =>
      hooks.plan!(true, context),
    );
    add('plan_exit', 'read', schema({}), async (_args, context) =>
      hooks.plan!(false, context),
    );
  }
  if (hooks.task)
    add(
      'task',
      'read',
      schema(
        {
          description: text('Subagent task'),
          subagent_type: text('general-purpose or explore'),
          background: {
            type: 'boolean',
            description:
              'Run the subagent as a background job and return immediately',
          },
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
    schema(
      {
        url: text('URL to fetch'),
        format: { type: 'string', enum: ['markdown', 'text', 'html'] },
      },
      ['url'],
    ),
    async (args, context) =>
      webFetch(
        string(args, 'url'),
        String(args.format || 'markdown'),
        context.signal,
      ),
  );
  add(
    'websearch',
    'read',
    schema(
      {
        query: text('Search query'),
        num_results: { type: 'integer', minimum: 1, maximum: 10 },
      },
      ['query'],
    ),
    async (args, context) =>
      webSearch(
        string(args, 'query'),
        context.signal,
        Number(args.num_results) || 5,
      ),
  );
  add(
    'delete',
    'write',
    schema({ file_path: text('Path to delete') }, ['file_path']),
    async (args, context) => {
      context.signal.throwIfAborted();
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkMutablePath(path);
      rmSync(path, { recursive: true });
      return `Deleted ${path}`;
    },
  );

  return tools;
}
