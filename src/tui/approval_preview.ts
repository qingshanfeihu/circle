import { existsSync, readFileSync, statSync } from 'node:fs';
import type { CardLine } from '../ink/components/dialog_card.js';
import type { ApprovalRequest } from '../ink/components/approval_card.js';
import type { Review } from '../approvals.js';
import type { ToolCall } from '../types.js';
// Rows of change an approval card shows before "… +N more lines".
export const APPROVAL_PREVIEW_LINES = 40;
const MAX_CHANGE_CHARS = 256 * 1024;
const MAX_CHANGE_LINES = 2000;
const CONTEXT = 3;
type Row = CardLine;
const row = (text: string, tone?: CardLine['tone']): Row =>
  tone ? { text, tone } : { text };
const text = (args: Record<string, unknown>, ...keys: string[]): unknown =>
  keys.map((key) => args[key]).find((value) => value !== undefined);
/**
 * The card's first lines: the command, the file, or the files a patch changes (the diff
 * follows from `approvalPreview`); other tools list their arguments.
 */
export function approvalBody(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name === 'execute') {
    const body = '$ ' + String(args.command ?? '');
    // it does not end with the call: say so before it is allowed
    return args.background === true
      ? body + '\nruns in the background as a job'
      : body;
  }
  if (name === 'apply_patch') {
    const files = String(args.patchText ?? '')
      .split('\n')
      .map((line) =>
        line.match(/^\*\*\* (?:Add|Update|Delete) File:(.*)$/)?.[1]?.trim(),
      )
      .filter((file): file is string => file !== undefined);
    const more = files.length > 6 ? ` and ${files.length - 6} more` : '';
    return files.length
      ? files.slice(0, 6).join(', ') + more
      : '(a patch with no files)';
  }
  if (['write_file', 'edit_file', 'delete'].includes(name))
    return String(text(args, 'file_path', 'path') ?? '');
  return Object.entries(args)
    .slice(0, 8)
    .map(([key, value]) =>
      `${key}=${JSON.stringify(value) ?? String(value)}`.slice(0, 200),
    )
    .join('\n');
}
/** Lines with their endings, as Python's `splitlines(keepends=True)` cuts them. */
function splitKeep(source: string): string[] {
  return source.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}
/** Line-ending-only changes stay visible without putting a newline in a row. */
function diffBody(line: string, boundary = 'EOF'): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2) + ' [CRLF]';
  if (line.endsWith('\n')) return line.slice(0, -1);
  if (line.endsWith('\r')) return line.slice(0, -1) + ' [CR]';
  return `${line} [no newline at ${boundary}]`;
}
type Op = ['=' | '-' | '+', string];
/** A shortest edit script between two lists of lines (common ends trimmed, then LCS). */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const lcs = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
  const ops: Op[] = a.slice(0, start).map((line) => ['=', line]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push(['=', a[start + i]!]);
      i++;
      j++;
    } else if (
      j >= m ||
      (i < n && lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)
    )
      ops.push(['-', a[start + i++]!]);
    else ops.push(['+', b[start + j++]!]);
  }
  for (const line of a.slice(endA)) ops.push(['=', line]);
  return ops;
}
interface Hunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  ops: Op[];
}
/** The edit script cut into hunks with three lines of context, as `difflib.unified_diff`. */
function hunks(ops: Op[]): Hunk[] {
  const changed = ops
    .map((op, index) => (op[0] === '=' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return [];
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const last = ranges.at(-1);
    if (last && index - last[1] <= 2 * CONTEXT + 1) last[1] = index;
    else ranges.push([index, index]);
  }
  return ranges.map(([first, last]) => {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length, last + CONTEXT + 1);
    let oldLine = 0;
    let newLine = 0;
    for (const [kind] of ops.slice(0, from)) {
      if (kind !== '+') oldLine++;
      if (kind !== '-') newLine++;
    }
    const slice = ops.slice(from, to);
    return {
      oldStart: oldLine,
      oldLength: slice.filter(([kind]) => kind !== '+').length,
      newStart: newLine,
      newLength: slice.filter(([kind]) => kind !== '-').length,
      ops: slice,
    };
  });
}
function range(start: number, length: number): string {
  if (length === 1) return String(start + 1);
  return `${length ? start + 1 : start},${length}`;
}
/** The change from `before` to `after` with the file's own line numbers. */
function fileDiff(before: string, after: string): Row[] {
  const oldLines = splitKeep(before);
  const newLines = splitKeep(after);
  if (oldLines.length + newLines.length > MAX_CHANGE_LINES * 2) return [];
  const rows: Row[] = [];
  for (const hunk of hunks(editScript(oldLines, newLines))) {
    rows.push(
      row(
        `@@ -${range(hunk.oldStart, hunk.oldLength)} +${range(hunk.newStart, hunk.newLength)} @@`,
      ),
    );
    let oldNumber = hunk.oldLength ? hunk.oldStart + 1 : hunk.oldStart;
    let newNumber = hunk.newLength ? hunk.newStart + 1 : hunk.newStart;
    for (const [kind, line] of hunk.ops) {
      if (kind === '+')
        rows.push(
          row(
            `+${String(newNumber++).padStart(3)}  ${diffBody(line)}`,
            'added',
          ),
        );
      else if (kind === '-')
        rows.push(
          row(
            `-${String(oldNumber++).padStart(3)}  ${diffBody(line)}`,
            'removed',
          ),
        );
      else {
        rows.push(row(` ${String(newNumber).padStart(3)}  ${diffBody(line)}`));
        oldNumber++;
        newNumber++;
      }
    }
  }
  return limit(rows);
}
function limit(rows: Row[]): Row[] {
  if (rows.length <= MAX_CHANGE_LINES) return rows;
  return [
    ...rows.slice(0, MAX_CHANGE_LINES),
    row(
      `… +${rows.length - MAX_CHANGE_LINES} change lines not captured for display`,
    ),
  ];
}
/** The change as the call states it, when the file itself cannot be read. */
function statedChange(name: string, args: Record<string, unknown>): Row[] {
  if (name === 'write_file') {
    const content = args.content;
    if (typeof content !== 'string') return [];
    if (!content || content.length > MAX_CHANGE_CHARS) return [];
    return limit(
      content
        .split(/\r\n|\n|\r/)
        .slice(0, content.match(/(?:\r\n|\n|\r)$/) ? -1 : undefined)
        .map((line, index) =>
          row(`+${String(index + 1).padStart(3)}  ${line}`, 'added'),
        ),
    );
  }
  if (name === 'edit_file') {
    const old = text(args, 'old_string', 'oldString');
    const replacement = text(args, 'new_string', 'newString');
    if (typeof old !== 'string' || typeof replacement !== 'string') return [];
    if (old.length + replacement.length > MAX_CHANGE_CHARS)
      return [
        row(
          `Replacement exceeds ${MAX_CHANGE_CHARS} characters; preview omitted`,
        ),
      ];
    const oldLines = splitKeep(old);
    const newLines = splitKeep(replacement);
    if (oldLines.length + newLines.length > MAX_CHANGE_LINES * 2)
      return [row('Replacement has too many lines; preview omitted')];
    const parts = hunks(editScript(oldLines, newLines));
    if (!parts.length) return [];
    const rows = [row('@@ replacement @@')];
    // snippet-relative line numbers are not file positions: no numbers here
    for (const hunk of parts)
      for (const [kind, line] of hunk.ops)
        rows.push(
          row(
            (kind === '=' ? ' ' : kind) + diffBody(line, 'end of replacement'),
            kind === '+' ? 'added' : kind === '-' ? 'removed' : undefined,
          ),
        );
    return limit(rows);
  }
  if (name === 'apply_patch') {
    const patch = args.patchText;
    if (typeof patch !== 'string') return [];
    if (patch.length > MAX_CHANGE_CHARS)
      return [
        row(`Patch exceeds ${MAX_CHANGE_CHARS} characters; preview omitted`),
      ];
    const body = patch
      .split('*** Begin Patch')
      .at(-1)!
      .split('*** End Patch')[0]!;
    return limit(
      body
        .split(/\r\n|\n|\r/)
        .filter(Boolean)
        .map((line) =>
          row(
            line,
            line.startsWith('+')
              ? 'added'
              : line.startsWith('-')
                ? 'removed'
                : undefined,
          ),
        ),
    );
  }
  return [];
}
/** The file as it is now; "" when there is none yet; undefined when it cannot be shown. */
function fileText(
  resolve: (path: string) => string,
  path: string,
): string | undefined {
  try {
    const target = resolve(path);
    if (!existsSync(target)) return '';
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > MAX_CHANGE_CHARS) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(
      readFileSync(target),
    );
  } catch {
    return undefined;
  }
}
/**
 * What a file tool asks to change, for its approval card: a count of the lines it adds
 * and removes, then the diff. Against the file as it is now when it can be read (real
 * line numbers and context), else the change as the call states it. Cut after
 * APPROVAL_PREVIEW_LINES rows.
 */
export function approvalPreview(
  name: string,
  args: Record<string, unknown>,
  resolve?: (path: string) => string,
): CardLine[] {
  if (!['edit_file', 'write_file', 'apply_patch'].includes(name)) return [];
  const path = String(text(args, 'file_path', 'path') ?? '');
  const before = resolve && path ? fileText(resolve, path) : undefined;
  let after: string | undefined;
  if (
    before !== undefined &&
    name === 'write_file' &&
    typeof args.content === 'string'
  )
    after = args.content;
  else if (before && name === 'edit_file') {
    const old = text(args, 'old_string', 'oldString');
    const replacement = text(args, 'new_string', 'newString');
    if (
      typeof old === 'string' &&
      old &&
      typeof replacement === 'string' &&
      before.includes(old)
    )
      // as the tool does it: the first match, or every match with replace_all
      after =
        args.replace_all || args.replaceAll
          ? before.replaceAll(old, () => replacement)
          : before.replace(old, () => replacement);
  }
  let rows: Row[];
  let summary = '';
  if (after !== undefined) {
    rows = fileDiff(before ?? '', after);
    if (!before) {
      const count = splitKeep(after).length;
      summary = `new file, ${count} ${count === 1 ? 'line' : 'lines'}`;
    }
  } else rows = statedChange(name, args);
  if (!rows.length) return [];
  if (!summary) {
    const added = rows.filter((item) => item.tone === 'added').length;
    const removed = rows.filter((item) => item.tone === 'removed').length;
    summary = `+${added} -${removed}`;
  }
  if (rows.length > APPROVAL_PREVIEW_LINES)
    rows = [
      ...rows.slice(0, APPROVAL_PREVIEW_LINES),
      row(`… +${rows.length - APPROVAL_PREVIEW_LINES} more lines`),
    ];
  return [row(summary), ...rows];
}
/** Everything an approval card shows for `call`, from what the policy said about it. */
export function approvalRequest(
  call: ToolCall,
  review: Review,
  resolve?: (path: string) => string,
  origin = '',
): ApprovalRequest {
  const ask = review.verdict === 'ASK';
  return {
    tool: call.name,
    ...(origin ? { origin } : {}),
    body: approvalBody(call.name, call.args),
    preview: approvalPreview(call.name, call.args, resolve),
    policy: review.reason,
    scope: ask && review.pattern ? review.scope || 'this call' : '',
    prefixScope:
      ask && review.prefix.length ? `"${review.prefix.join(' ')} …"` : '',
    warnDelete: review.warn_delete,
  };
}
