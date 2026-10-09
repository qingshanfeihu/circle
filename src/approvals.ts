import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { circleHome, normalizeWorkspace } from './paths.js';
import { isRecord, readJson, writePrivateJson } from './settings.js';

export type Verdict = 'DENY' | 'ASK' | 'ASK_FORCED';
export interface Review {
  verdict: Verdict;
  reason: string;
  message: string;
  pattern: string;
  scope: string;
  warn_delete: boolean;
  prefix: string[];
  covered_by: string[];
}
const review = (
  verdict: Verdict,
  reason: string,
  extra: Partial<Review> = {},
): Review => ({
  verdict,
  reason,
  message: '',
  pattern: '',
  scope: '',
  warn_delete: false,
  prefix: [],
  covered_by: [],
  ...extra,
});
export const DEFAULT_CREDENTIAL_FILES = [
  '.env',
  '.env.*',
  '*.env',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  'credentials.json',
  'token.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.pem',
  '*.p12',
  '*.pfx',
];
const READERS = new Set(
  'ls cat head tail wc pwd which whoami date uname file stat du df tree basename dirname realpath readlink true diff cmp nl cut grep egrep fgrep rg find cd test jq git'.split(
    ' ',
  ),
);
const PRIVILEGED = new Set('sudo su doas pkexec runas gsudo'.split(' '));
const DELETES = new Set(
  'rm rmdir unlink shred srm trash trash-put del erase rd remove-item ri'.split(
    ' ',
  ),
);
const DISK = new Set(
  'dd truncate wipefs fdisk parted format diskpart cipher sdelete clear-disk format-volume'.split(
    ' ',
  ),
);
const SEPARATORS = new Set([
  ';',
  '&&',
  '||',
  '|',
  '&',
  '|&',
  '(',
  ')',
  '{',
  '}',
]);
const READ_GIT = new Set(
  'status diff log show rev-parse ls-files blame describe shortlog grep ls-tree cat-file branch'.split(
    ' ',
  ),
);
export function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(
    `^${escaped}$`,
    process.platform === 'win32' ? 'i' : '',
  ).test(value);
}
export function commandTokens(command: string): string[] | null {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      if (++i >= command.length) return null;
      word += command[i];
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>(){}]/.test(char) || char === '`') {
      if (started) {
        out.push(word);
        word = '';
        started = false;
      }
      if (char === '\n' || char === '`') out.push(';');
      else if (!/\s/.test(char)) {
        const next = command[i + 1];
        if (next === char && ['&', '|', '<', '>'].includes(char)) {
          out.push(char + next);
          i++;
        } else out.push(char);
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}
function program(token: string): string {
  const name = basename(token.replace(/\\/g, '/'));
  return process.platform === 'win32'
    ? name.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '')
    : name;
}
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const head = program(words[i]!);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    else if (head === 'env') {
      i++;
      while (
        i < words.length &&
        (/^-/.test(words[i]!) || /^[A-Za-z_]\w*=/.test(words[i]!))
      )
        i++;
    } else if (
      [
        'nohup',
        'time',
        'command',
        'builtin',
        'exec',
        'stdbuf',
        'caffeinate',
      ].includes(head)
    )
      i++;
    else if (['nice', 'timeout', 'ionice', 'xargs'].includes(head)) {
      i++;
      while (words[i]?.startsWith('-')) {
        const flag = words[i++]!;
        if (
          ['-n', '-I', '-L', '-P', '-d', '-s', '-a', '-E', '-c'].includes(flag)
        )
          i++;
      }
      if (head === 'timeout') i++;
    } else break;
  }
  return words.slice(i);
}
function segments(tokens: string[]): string[][] {
  const out: string[][] = [[]];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) out.push([]);
    else out.at(-1)!.push(token);
  }
  return out.filter((words) => words.length);
}
function flag(args: string[], short: string, long: string): boolean {
  return args
    .slice(0, args.includes('--') ? args.indexOf('--') : undefined)
    .some(
      (word) =>
        Boolean(long && (word === long || word.startsWith(long + '='))) ||
        Boolean(
          short &&
          word.startsWith('-') &&
          !word.startsWith('--') &&
          word.slice(1).includes(short),
        ),
    );
}
function destructiveGit(args: string[]): boolean {
  let i = 0;
  const valueFlags = new Set([
    '-C',
    '-c',
    '--config-env',
    '--git-dir',
    '--namespace',
    '--super-prefix',
    '--work-tree',
  ]);
  while (args[i]?.startsWith('-')) i += valueFlags.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'reset')
    return flag(rest, '', '--hard') || flag(rest, '', '--merge');
  if (sub === 'clean') return flag(rest, 'f', '--force');
  if (sub === 'push')
    return (
      flag(rest, 'f', '--force') ||
      flag(rest, '', '--force-with-lease') ||
      flag(rest, '', '--mirror') ||
      flag(rest, 'd', '--delete') ||
      rest.some((word) => /^[+:].+/.test(word))
    );
  if (sub === 'branch')
    return (
      flag(rest, 'D', '') ||
      (flag(rest, 'd', '--delete') && flag(rest, 'f', '--force'))
    );
  if (sub === 'stash') return ['drop', 'clear'].includes(rest[0] ?? '');
  if (sub === 'checkout')
    return flag(rest, 'f', '--force') || rest.includes('--') || rest[0] === '.';
  if (sub === 'restore')
    return !flag(rest, 'S', '--staged') || flag(rest, 'W', '--worktree');
  return ['rm', 'filter-branch', 'filter-repo'].includes(sub ?? '');
}
export function classifyCommand(
  command: string,
  patterns = DEFAULT_CREDENTIAL_FILES,
  depth = 0,
): Review {
  if (depth > 3) return review('ASK_FORCED', 'nested too deep to read');
  const tokens = commandTokens(command);
  if (!tokens) return review('ASK_FORCED', 'command could not be parsed');
  let forced: Review | undefined;
  let readOnly = tokens.length > 0 && !/\$\(|`|[<>]/.test(command);
  for (const raw of segments(tokens)) {
    for (const token of raw) {
      for (const candidate of [
        token,
        token.includes('=') ? token.split('=').slice(1).join('=') : '',
      ]) {
        const name = basename(candidate.replace(/\\/g, '/'));
        if (patterns.some((pattern) => wildcard(pattern, name)))
          return review('DENY', `credential file ${name}`, {
            message: `Denied by approval policy: '${name}' is a credential file; commands may not read, copy or change it.`,
          });
      }
    }
    const words = unwrap(raw);
    const head = program(words[0] ?? '');
    const args = words.slice(1);
    if (PRIVILEGED.has(head))
      return review('DENY', 'privilege escalation', {
        message: `Denied by approval policy: '${head}' is not allowed.`,
      });
    const codeAt = args.findIndex((word) => /^-[^-]*c/.test(word));
    if (
      ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(head) &&
      codeAt >= 0 &&
      args[codeAt + 1]
    ) {
      const nested = classifyCommand(args[codeAt + 1]!, patterns, depth + 1);
      if (nested.verdict === 'DENY') return nested;
      if (nested.verdict === 'ASK_FORCED') forced = nested;
    }
    if (/^python\d*(?:\.\d+)*$/.test(head) && codeAt >= 0) {
      const code = args[codeAt + 1] ?? '';
      for (const match of code.matchAll(/['"]([^'"\n]+)['"]/g))
        if (patterns.some((pattern) => wildcard(pattern, basename(match[1]!))))
          return review('DENY', 'credential file in Python code');
      if (
        /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs))\s*\(|\.(?:unlink|rmdir)\s*\(/.test(
          code,
        )
      )
        forced = review('ASK_FORCED', 'python code deletes files', {
          warn_delete: true,
        });
    }
    if (
      DELETES.has(head) ||
      DISK.has(head) ||
      head.startsWith('mkfs') ||
      (head === 'git' && destructiveGit(args)) ||
      (head === 'find' && args.includes('-delete'))
    )
      forced = review('ASK_FORCED', 'destructive operation', {
        warn_delete: true,
      });
    if (head === 'find')
      for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
        const index = args.indexOf(action);
        if (index >= 0) {
          const nested = classifyCommand(
            args
              .slice(index + 1)
              .filter((word) => word !== '{}')
              .join(' '),
            patterns,
            depth + 1,
          );
          if (nested.verdict === 'DENY') return nested;
          if (nested.verdict === 'ASK_FORCED') forced = nested;
        }
      }
    if (head === 'cmd') {
      const index = args.findIndex((word) => /^\/[ckr]/i.test(word));
      if (index >= 0) {
        const nested = classifyCommand(
          [args[index]!.slice(2), ...args.slice(index + 1)].join(' '),
          patterns,
          depth + 1,
        );
        if (nested.verdict === 'DENY') return nested;
        if (nested.verdict === 'ASK_FORCED') forced = nested;
      }
    }
    if (head === 'pwsh' || head === 'powershell') {
      const index = args.findIndex((word) =>
        /^-(?:c|comm|command)$/i.test(word),
      );
      if (args.some((word) => /^-(?:ec|encodedcommand)$/i.test(word)))
        forced = review('ASK_FORCED', 'encoded command');
      else if (index >= 0) {
        const nested = classifyCommand(
          args.slice(index + 1).join(' '),
          patterns,
          depth + 1,
        );
        if (nested.verdict === 'DENY') return nested;
        if (nested.verdict === 'ASK_FORCED') forced = nested;
      }
    }
    if (
      !READERS.has(head) ||
      words[0] !== head ||
      raw.length !== words.length ||
      raw.some((word) => /^[A-Za-z_]\w*=/.test(word))
    )
      readOnly = false;
    if (
      head === 'git' &&
      (!READ_GIT.has(args[0] ?? '') ||
        args.some((word) =>
          /^--(?:output|ext-diff|open-files-in-pager)/.test(word),
        ) ||
        (args[0] === 'branch' &&
          args
            .slice(1)
            .some(
              (word) =>
                ![
                  '-a',
                  '-r',
                  '-v',
                  '-vv',
                  '--list',
                  '--all',
                  '--remotes',
                  '--show-current',
                  '--no-color',
                ].includes(word),
            )))
    )
      readOnly = false;
    if (
      (head === 'find' &&
        args.some((word) =>
          /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(
            word,
          ),
        )) ||
      (head === 'rg' && args.some((word) => word.startsWith('--pre'))) ||
      (head === 'tree' && args.some((word) => word.startsWith('-o'))) ||
      (head === 'file' && args.includes('-C')) ||
      (head === 'date' &&
        args.some((word) => word.startsWith('-s') || word.startsWith('--set')))
    )
      readOnly = false;
  }
  for (const match of command.matchAll(/\$\(([^()]*)\)/g)) {
    const nested = classifyCommand(match[1]!, patterns, depth + 1);
    if (nested.verdict === 'DENY') return nested;
    if (nested.verdict === 'ASK_FORCED') forced = nested;
  }
  if (forced) return forced;
  return readOnly && depth === 0
    ? review('ASK', 'only reads', {
        pattern: 'read-only',
        scope: 'read-only commands (ls, cat, rg, git status, git diff …)',
      })
    : review('ASK', 'runs a shell command');
}
export function commandPrefix(command: string): string[] {
  const words = commandTokens(command);
  if (
    !words?.length ||
    /\$|`|[;&|<>\n(){}]/.test(command) ||
    unwrap(words).length !== words.length
  )
    return [];
  const head = program(words[0]!);
  const rest = words.slice(1);
  if (/^python\d*(?:\.\d+)*$/.test(head))
    return rest[0] === '-m' && rest[1]
      ? words.slice(0, 3)
      : rest[0] && !rest[0].startsWith('-')
        ? words.slice(0, 2)
        : [];
  if (
    [
      'node',
      'ruby',
      'perl',
      'php',
      'bash',
      'sh',
      'zsh',
      'pwsh',
      'powershell',
    ].includes(head)
  )
    return rest[0] && !rest[0].startsWith('-') ? words.slice(0, 2) : [];
  if (
    [
      'git',
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'deno',
      'npx',
      'uv',
      'pip',
      'cargo',
      'go',
      'make',
      'docker',
      'gh',
    ].includes(head)
  )
    return /^[A-Za-z][\w:-]*$/.test(rest[0] ?? '')
      ? words.slice(
          0,
          [
            'run',
            'exec',
            'compose',
            'x',
            'dlx',
            'tool',
            'mod',
            'workspace',
          ].includes(rest[0]!) && rest[1]
            ? 3
            : 2,
        )
      : [];
  if (
    READERS.has(head) ||
    [
      'curl',
      'wget',
      'ssh',
      'scp',
      'rsync',
      'chmod',
      'chown',
      'kill',
      'mv',
      'cp',
      'ln',
      'open',
      'eval',
      'source',
      '.',
      'sed',
      'awk',
      'tee',
    ].includes(head) ||
    PRIVILEGED.has(head)
  )
    return [];
  return words.slice(0, 1);
}
interface Rule {
  tool: string;
  pattern: string;
  label: string;
  at: number;
}
interface StoreData {
  rules: Rule[];
  log: (Rule & { kind: string })[];
}
export class ApprovalStore {
  constructor(readonly root: string) {}
  private path(thread: string): string {
    return join(
      this.root,
      createHash('sha256').update(thread).digest('hex').slice(0, 32) + '.json',
    );
  }
  private load(thread: string): StoreData {
    try {
      const raw = readJson(this.path(thread));
      if (isRecord(raw))
        return {
          rules: Array.isArray(raw.rules) ? (raw.rules as Rule[]) : [],
          log: Array.isArray(raw.log) ? (raw.log as StoreData['log']) : [],
        };
    } catch {
      /* No rules yet. */
    }
    return { rules: [], log: [] };
  }
  private save(thread: string, data: StoreData): void {
    mkdirSync(this.root, { recursive: true });
    writePrivateJson(this.path(thread), { ...data, log: data.log.slice(-200) });
  }
  rules(thread: string): Rule[] {
    return this.load(thread).rules;
  }
  matchesAny(thread: string, tool: string, patterns: string[]): boolean {
    return this.rules(thread).some(
      (rule) =>
        rule.tool === tool &&
        Boolean(rule.pattern) &&
        patterns.includes(rule.pattern),
    );
  }
  record(
    thread: string,
    kind: string,
    tool: string,
    pattern: string,
    label: string,
  ): void {
    const data = this.load(thread);
    const entry = { tool, pattern, label, at: Date.now() / 1000 };
    if (
      kind === 'always' &&
      !data.rules.some((rule) => rule.tool === tool && rule.pattern === pattern)
    )
      data.rules.push(entry);
    data.log.push({ ...entry, kind });
    this.save(thread, data);
  }
  revoke(thread: string, index: number): Rule | undefined {
    const data = this.load(thread);
    const [entry] = data.rules.splice(index, 1);
    if (entry) {
      data.log.push({ ...entry, kind: 'revoke', at: Date.now() / 1000 });
      this.save(thread, data);
    }
    return entry;
  }
}
export class ApprovalPolicy {
  private yolo = new Set<string>();
  constructor(
    readonly store: ApprovalStore,
    readonly workspace: string,
    readonly credentialFiles = DEFAULT_CREDENTIAL_FILES,
    private readonly resolvePath?: (path: string) => string,
  ) {}
  setYolo(thread: string, enabled: boolean): void {
    if (enabled) this.yolo.add(thread);
    else this.yolo.delete(thread);
  }
  yoloEnabled(thread: string): boolean {
    return this.yolo.has(thread);
  }
  review(tool: string, args: Record<string, unknown>): Review {
    if (tool === 'execute') {
      let command = String(args.command || '');
      const found = classifyCommand(command, this.credentialFiles);
      if (found.verdict !== 'ASK' || found.pattern === 'read-only')
        return found;
      const leading = command.match(
        /^\s*cd\s+(?:--\s+)?("[^"$`]*"|'[^']*'|[^\s;&|<>()$`'"]+)\s*(?:&&|;)\s*/,
      );
      if (
        leading &&
        normalizeWorkspace(
          resolve(this.workspace, leading[1]!.replace(/^['"]|['"]$/g, '')),
        ) === normalizeWorkspace(this.workspace)
      )
        command = command.slice(leading[0].length);
      const prefix = commandPrefix(command);
      const words = prefix.length ? (commandTokens(command) ?? []) : [];
      return {
        ...found,
        pattern: 'sha256:' + createHash('sha256').update(command).digest('hex'),
        scope: 'this exact command',
        prefix,
        covered_by: words.map(
          (_, index) => 'prefix:' + JSON.stringify(words.slice(0, index + 1)),
        ),
      };
    }
    if (
      tool === 'delete' ||
      (tool === 'apply_patch' &&
        /^\*\*\* Delete File:/m.test(String(args.patchText || '')))
    )
      return review('ASK_FORCED', 'deletes files', { warn_delete: true });
    if (['write_file', 'edit_file', 'apply_patch'].includes(tool)) {
      const paths =
        tool === 'apply_patch'
          ? [
              ...String(args.patchText || '').matchAll(
                /^\*\*\* (?:Add File|Update File|Move to):\s*(.+)$/gm,
              ),
            ].map((match) => match[1]!)
          : [String(args.file_path || args.path || '')];
      const inside =
        paths.length > 0 &&
        paths.every((path) => {
          const rel = relative(
            this.workspace,
            this.resolvePath
              ? this.resolvePath(path)
              : normalizeWorkspace(resolve(this.workspace, path)),
          );
          return Boolean(path) && rel !== '..' && !rel.startsWith('..' + sep);
        });
      return review(
        'ASK',
        inside
          ? 'changes files in the workspace'
          : 'changes files outside the workspace',
        inside
          ? { pattern: 'workspace', scope: 'file changes inside the workspace' }
          : {},
      );
    }
    return review('ASK', `${tool} can change state`, {
      pattern: '*',
      scope: `every ${tool} call`,
    });
  }
  needsApproval(
    tool: string,
    args: Record<string, unknown>,
    thread: string,
    allowYolo = true,
  ): boolean {
    const found = this.review(tool, args);
    if (found.verdict === 'DENY') return false;
    if (allowYolo && this.yolo.has(thread)) return false;
    if (found.verdict === 'ASK_FORCED') return true;
    return !this.store.matchesAny(thread, tool, [
      found.pattern,
      ...found.covered_by,
    ]);
  }
  remember(
    thread: string,
    tool: string,
    args: Record<string, unknown>,
    decision: string,
  ): boolean {
    const found = this.review(tool, args);
    const pattern =
      decision === 'prefix' && found.prefix.length
        ? 'prefix:' + JSON.stringify(found.prefix)
        : found.pattern;
    if (['always', 'prefix'].includes(decision)) {
      if (found.verdict !== 'ASK' || !pattern) return false;
      this.store.record(thread, 'always', tool, pattern, found.scope);
      return true;
    }
    this.store.record(
      thread,
      decision === 'approve' ? 'once' : 'reject',
      tool,
      pattern,
      found.scope,
    );
    return decision === 'approve';
  }
}
export function defaultPolicy(
  workspace: string,
  home = circleHome(),
  credentials = DEFAULT_CREDENTIAL_FILES,
  resolvePath?: (path: string) => string,
): ApprovalPolicy {
  return new ApprovalPolicy(
    new ApprovalStore(join(home, 'approvals')),
    workspace,
    credentials,
    resolvePath,
  );
}
