// Derived from docs/tools.md at Circle 9b53272. Checked by the coverage test.
export const BUILTIN_TOOL_INFO = [
  {
    name: 'ls',
    description: 'List a folder',
    detail: 'List a folder. Folders end in `/`.',
    kind: 'read',
  },
  {
    name: 'read_file',
    description:
      "Read a text file with line numbers (12: text), a folder's entries, or an image or a PDF",
    detail:
      "Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`.",
    kind: 'read',
  },
  {
    name: 'glob',
    description: 'Find files by pattern.',
    detail: 'Find files by pattern.',
    kind: 'read',
  },
  {
    name: 'grep',
    description:
      'Search file contents for **literal text**, not a regular expression',
    detail:
      'Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched.',
    kind: 'read',
  },
  {
    name: 'lsp',
    description:
      'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations',
    detail:
      'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based.',
    kind: 'read',
  },
  {
    name: 'webfetch',
    description: 'Fetch a URL',
    detail:
      'Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed.',
    kind: 'read',
  },
  {
    name: 'websearch',
    description: 'Search the web through DuckDuckGo',
    detail: 'Search the web through DuckDuckGo. No API key.',
    kind: 'read',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file.',
    detail: 'Create or overwrite a file.',
    kind: 'write',
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in a file',
    detail:
      'Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`.',
    kind: 'write',
  },
  {
    name: 'apply_patch',
    description:
      'Apply a multi-file patch in the *** Begin Patch format: add, update, move and delete files.',
    detail:
      'Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files.',
    kind: 'write',
  },
  {
    name: 'delete',
    description: 'Delete a file or a folder and everything in it.',
    detail: 'Delete a file or a folder and everything in it.',
    kind: 'write',
  },
  {
    name: 'execute',
    description: 'Run a shell command in the workspace',
    detail:
      'Run a shell command in the workspace. With `background: true` it runs as a background job and returns at once. Standard output and standard error come back together, in the order they were written.',
    kind: 'write',
  },
  {
    name: 'write_todos',
    description: 'Keep the plan shown in the plan box.',
    detail: 'Keep the plan shown in the plan box.',
    kind: 'interaction',
  },
  {
    name: 'question',
    description:
      'Ask you one or more questions with options, or ask for a secret',
    detail:
      'Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. See Answer a question and Secrets.',
    kind: 'interaction',
  },
  {
    name: 'plan_enter',
    description: 'Switch to read-only mode, as /plan does.',
    detail: 'Switch to `read-only` mode, as `/plan` does.',
    kind: 'interaction',
  },
  {
    name: 'plan_exit',
    description:
      'Ask you whether to leave read-only mode and implement the plan',
    detail:
      'Ask you whether to leave `read-only` mode and implement the plan. Only you can say yes, so it fails without the full-screen interface.',
    kind: 'interaction',
  },
  {
    name: 'list_jobs',
    description:
      "List this conversation's jobs: id, kind, state, time, what, and the file their output goes to.",
    detail:
      "List this conversation's jobs: id, kind, state, time, what, and the file their output goes to.",
    kind: 'agent / job',
  },
  {
    name: 'stop_job',
    description: 'Stop a running job with everything it started.',
    detail: 'Stop a running job with everything it started.',
    kind: 'agent / job',
  },
  {
    name: 'wait_jobs',
    description:
      'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended',
    detail:
      'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended. Only subagents have it: they cannot be woken by a notice.',
    kind: 'agent / job',
  },
  {
    name: 'skill',
    description: 'Load the full instructions of a skill by name.',
    detail: 'Load the full instructions of a skill by name.',
    kind: 'interaction',
  },
  {
    name: 'task',
    description:
      'Run a subagent (general-purpose, explore, or one an extension adds) and return its answer',
    detail:
      'Run a subagent (`general-purpose`, `explore`, or one an extension adds) and return its answer. Arguments: `description`, `subagent_type`, `background`. With `background: true` the subagent runs as a background job and its report comes as a notice. See How Circle works.',
    kind: 'agent / job',
  },
  {
    name: 'compact_conversation',
    description: 'Summarize older messages now',
    detail: 'Summarize older messages now. See Compaction.',
    kind: 'interaction',
  },
] as const;
