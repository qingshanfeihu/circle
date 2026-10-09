// The grep tool, as the Python releases had it from deepagents' filesystem middleware: a
// literal (not regex) search, `output_mode` files_with_matches (the default), content or
// count, and a total cap on matches (`max_count`, 1000 unless the call asks otherwise).
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { glob } from 'glob';
import type { Sandbox } from './sandbox.js';

export const GREP_DEFAULT_MAX_COUNT = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESULT_LIMIT = 20000 * 4;
const TRUNCATION_GUIDANCE =
  '... [results truncated, try being more specific with your parameters]';
export const GREP_TRUNCATION_NOTE =
  'Note: the search stopped early (it hit its time limit or the maximum match count). ' +
  'The matches above are valid but incomplete. Narrow the search (a more specific pattern or a ' +
  'narrower path), or raise max_count, to see the rest.';
const REGEX_HINT =
  'Note: grep matches literal text, not regex, so characters like ' +
  '`|`, `.*`, and `\\.` are searched verbatim. Search for the literal ' +
  'text you need instead; for `|` alternation, run a separate search ' +
  'per alternative.';
const OUTPUT_MODES = ['files_with_matches', 'content', 'count'] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

export const GREP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Text pattern to search for (literal string, not regex).',
    },
    path: {
      type: 'string',
      description:
        'Directory to search in. Defaults to current working directory.',
    },
    glob: {
      type: 'string',
      description:
        "Glob pattern (NOT regex) limiting which files are searched (e.g. '*.py', " +
        "'*.ts'). A pattern without '/' matches the file name at any depth; a pattern " +
        "containing '/' matches the search-root-relative path (e.g. 'src/**/*.py'). " +
        'This is an in-tool file filter, not a call to the separate glob tool. Brace ' +
        "expansion (e.g. '*.{ts,tsx}') is not supported on all backends; run a " +
        'separate search per extension for reliable results.',
    },
    output_mode: {
      type: 'string',
      enum: [...OUTPUT_MODES],
      default: 'files_with_matches',
      description:
        "Shape of the returned text. 'files_with_matches' (default): newline-separated " +
        "matching file paths. 'content': matching lines grouped by file under a " +
        "'<path>:' header, each line indented and formatted '<line_number>: <line text>' " +
        "(only the matched line, no surrounding context). 'count': one " +
        "'<path>: <match_count>' line per file.",
    },
    max_count: {
      type: 'integer',
      minimum: 1,
      description:
        'Optional cap on the total number of matches returned across all files. ' +
        'Leave unset to use the configured default. When the cap is hit, results ' +
        'are truncated and a note says so; narrow the pattern or path to see the rest.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

// A pattern without '/' matches the file name at any depth; one with '/' matches the path
// relative to the search root, and a leading '/' anchors it there.
function includeMatcher(pattern: string): (rel: string) => boolean {
  if (pattern.replaceAll('\\', '/').split('/').includes('..'))
    throw new Error(`Path traversal not allowed in glob pattern '${pattern}'`);
  const anchored = pattern.includes('/');
  const compiled = pattern.replace(/^\/+/, '');
  return (rel) =>
    posix.matchesGlob(anchored ? rel : posix.basename(rel), compiled);
}

function looksLikeRegex(pattern: string): boolean {
  return /\||\.\*|\.\+|\\[.wWdDsSbB(){}[\]|+*?^$]/.test(pattern);
}

function truncate(text: string): string {
  return text.length > RESULT_LIMIT
    ? text.slice(0, RESULT_LIMIT - TRUNCATION_GUIDANCE.length - 1) +
        '\n' +
        TRUNCATION_GUIDANCE
    : text;
}

function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
    ? undefined
    : rel;
}

// How a path is shown to the model: '/' and the path inside the folder Circle works in (or
// inside the data folder's offload root), else the real absolute path.
function pathShower(sandbox: Sandbox): (path: string) => string {
  const roots = [sandbox.offloadRoot, sandbox.workspace]
    .filter((root): root is string => Boolean(root))
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return root; // a root that does not exist yet holds nothing
      }
    });
  return (path) => {
    for (const root of roots) {
      const rel = inside(root, path);
      if (rel !== undefined) return '/' + rel.split(sep).join('/');
    }
    return path.split(sep).join('/');
  };
}

export async function grepSearch(
  sandbox: Sandbox,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (typeof args.pattern !== 'string')
    throw new Error('missing string parameter: pattern');
  const pattern = args.pattern;
  const mode = (args.output_mode ?? 'files_with_matches') as OutputMode;
  if (!OUTPUT_MODES.includes(mode))
    throw new Error(
      `output_mode must be one of ${OUTPUT_MODES.join(', ')}, not ${String(mode)}`,
    );
  const cap =
    args.max_count === undefined || args.max_count === null
      ? GREP_DEFAULT_MAX_COUNT
      : Number(args.max_count);
  if (!Number.isInteger(cap) || cap < 1)
    throw new Error('max_count must be a positive integer');
  const matcher =
    typeof args.glob === 'string' && args.glob
      ? includeMatcher(args.glob)
      : undefined;
  const base = sandbox.resolvePath(
    typeof args.path === 'string' && args.path ? args.path : '.',
  );
  let files: string[] = [];
  let root = base;
  let directory = false;
  try {
    if (statSync(base).isDirectory()) {
      directory = true;
      root = realpathSync(base);
      files = (
        await glob('**/*', {
          cwd: root,
          nodir: true,
          dot: true,
          ignore: ['**/.git/**', '**/node_modules/**'],
          follow: false,
          posix: true,
        })
      ).sort();
      if (matcher) files = files.filter((rel) => matcher(rel));
      files = files.map((rel) => join(root, rel));
    } else files = [base];
  } catch {
    files = []; // a path that does not exist has no matches
  }
  const show = pathShower(sandbox);
  const results = new Map<string, [number, string][]>();
  let total = 0;
  let truncated = false;
  search: for (const file of files) {
    signal.throwIfAborted();
    let text: string;
    let real: string;
    try {
      real = realpathSync(file);
      // A link that leads out of the search root is not followed.
      if (directory && inside(root, real) === undefined) continue;
      sandbox.checkCredentialPath(file);
      sandbox.checkCredentialPath(real);
      if (statSync(real).size > MAX_FILE_BYTES) continue;
      const data = readFileSync(real);
      if (data.includes(0)) continue;
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      continue; // unreadable, binary, not UTF-8 or a credential file
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const shown = show(file);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.replace(/\r$/, '');
      if (!line.includes(pattern)) continue;
      if (total >= cap) {
        truncated = true;
        break search;
      }
      if (!results.has(shown)) results.set(shown, []);
      results.get(shown)!.push([index + 1, line]);
      total++;
    }
  }
  let body: string;
  const paths = [...results.keys()].sort();
  if (!paths.length) body = 'No matches found';
  else if (mode === 'files_with_matches') body = paths.join('\n');
  else if (mode === 'count')
    body = paths
      .map((path) => `${path}: ${results.get(path)!.length}`)
      .join('\n');
  else
    body = paths
      .flatMap((path) => [
        `${path}:`,
        ...results.get(path)!.map(([line, text]) => `  ${line}: ${text}`),
      ])
      .join('\n');
  body = truncate(body);
  if (truncated) return `${body}\n\n${GREP_TRUNCATION_NOTE}`;
  if (!paths.length && looksLikeRegex(pattern))
    return `${body}\n\n${REGEX_HINT}`;
  return body;
}
