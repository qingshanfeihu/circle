// Transcript rows for tool calls and thinking, in the single tool-row form: every call is
// one row `{lamp} {Short}({summary})` with its result on `⎿` lines right under it, the row
// and its lines on the tool's type tint (read blue, write green, agent cyan, question
// magenta). A failure the model can fix itself gets no lamp and a muted strikethrough.
// Thinking is one folded row, `∴ Thought 6.3s · title  ctrl+t`, on the thinking tint
// (ported from transcript_view.py, content_blocks.py and tool_display.py).
import { lampSgr, palette, sgrJoin, type LampState } from '../ink/theme.js';
import { pad, stringWidth, truncate } from '../ink/string_width.js';
import {
  markdownRows,
  terminalText,
} from '../ink/components/markdown_renderer.js';
import type { Message, ToolCall } from '../types.js';
import { toolArgSummary, toolShortName } from './display_lexicon.js';
import { formatBusyElapsed } from './status_rows.js';
import { plainJobOutput } from '../jobs.js';

export const PREVIEW_LINES = 6;
const COLLAPSED_WRAP_ROWS = 3;
const WAIT_SUFFIX = '  waiting for you';
// Shown by the plan box, never as a tool row.
export const HIDDEN_TOOLS = new Set(['write_todos']);
const READ_TOOLS = new Set([
  'read_file',
  'ls',
  'glob',
  'grep',
  'lsp',
  'skill',
  'webfetch',
  'websearch',
]);
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete',
  'execute',
]);

// The type tint for a tool's row and its `⎿` lines; '' for none.
export function toolTint(name: string): string {
  const p = palette();
  if (READ_TOOLS.has(name)) return p.read_bg;
  if (WRITE_TOOLS.has(name)) return p.write_bg;
  if (name === 'task') return p.agent_bg;
  if (name === 'question') return p.think_bg;
  return '';
}

// Segments of one row on a background: each segment repeats the background with its own
// colour, and the row is padded to the full width so a tinted block is a rectangle.
export function tintedRow(
  segments: [sgr: string, text: string][],
  bg: string,
  width: number,
): string {
  const p = palette();
  let used = 0;
  let out = '';
  for (const [sgr, text] of segments) {
    out += p.reset + sgrJoin(bg, sgr) + text;
    used += stringWidth(text);
  }
  return (
    out +
    p.reset +
    sgrJoin(bg) +
    ' '.repeat(Math.max(0, width - used)) +
    p.reset
  );
}

export function fitSummary(
  name: string,
  summary: string,
  width: number,
): string {
  const available = Math.max(8, width - stringWidth(name) - 6);
  if (stringWidth(summary) <= available) return summary;
  if (
    ['Read', 'Write', 'Edit', 'Patch'].includes(name) &&
    summary.includes('/')
  ) {
    const tail = '…/' + summary.split('/').at(-1);
    return stringWidth(tail) <= available
      ? tail
      : truncate(tail, available, true);
  }
  return truncate(summary, available);
}

const NUMBERED = /^(\d+): /;
// A `read_file` that came back as numbered lines: how many, and from where to where.
function readWindow(
  output: string,
): { first: number; last: number; count: number } | undefined {
  const lines = output.replace(/\n+$/, '').split('\n');
  const first = lines[0]?.match(NUMBERED);
  const last = lines.at(-1)?.match(NUMBERED);
  if (!first || !last) return undefined;
  return {
    first: Number(first[1]),
    last: Number(last[1]),
    count: lines.length,
  };
}

export interface ToolRowOptions {
  width: number;
  // The call has no result yet: running, waiting on you, or not started.
  pending?: 'running' | 'wait' | 'none';
  now?: number;
}
// The call's row: lamp, short name and what it was called with.
export function toolRow(
  call: ToolCall,
  result: Message | undefined,
  options: ToolRowOptions,
): string {
  const p = palette();
  const name = toolShortName(call.name);
  let summary = toolArgSummary(call);
  if (call.name === 'read_file' && result && result.status !== 'error') {
    const window = readWindow(result.content);
    if (summary && window && Number(call.args.offset ?? 0) > 0)
      summary += `:${window.first}-${window.last}`;
  }
  const waiting = !result && options.pending === 'wait';
  summary = fitSummary(
    name,
    summary,
    options.width - (waiting ? WAIT_SUFFIX.length : 0),
  );
  const text = `${name}(${summary})`;
  const bg = toolTint(call.name);
  const lamp: LampState = result
    ? result.status === 'error'
      ? result.recoverable
        ? 'none'
        : 'error'
      : 'ok'
    : (options.pending ?? 'running');
  const light = lampSgr(lamp, options.now);
  const segments: [string, string][] = [
    ['', ' '],
    [light, light ? '●' : ' '],
    ['', ' '],
    [
      result?.status === 'error' && result.recoverable
        ? p.muted_strike
        : p.text,
      text,
    ],
  ];
  if (waiting) segments.push(['', '  '], [p.blue, 'waiting for you']);
  return tintedRow(segments, bg, options.width);
}

// A result as lines: a JSON list of names one per line, a JSON object with its telling
// fields first, anything else as it came.
export function resultContent(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const lines = raw.replace(/\n+$/, '').split('\n');
    return lines.length === 1 && !lines[0] ? ['(no output)'] : lines;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.length ? value : ['(empty)'];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return JSON.stringify(value, null, 2).split('\n');
  const priority = [
    'status',
    'verdict',
    'ok',
    'autoid',
    'error',
    'message',
    'result',
    'stdout',
    'stderr',
    'output',
    'content',
    'violations',
    'advisories',
  ];
  const rank = (key: string): number =>
    priority.includes(key) ? priority.indexOf(key) : priority.length;
  const lines: string[] = [];
  for (const key of Object.keys(value).sort((a, b) => rank(a) - rank(b))) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === 'string' && item.includes('\n'))
      lines.push(`${key}:`, ...item.split('\n').map((part) => `  ${part}`));
    else if (item && typeof item === 'object')
      lines.push(
        `${key}:`,
        ...JSON.stringify(item, null, 2)
          .split('\n')
          .map((part) => `  ${part}`),
      );
    else
      lines.push(
        `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`,
      );
  }
  return lines.length ? lines : ['{}'];
}

// Characters into rows of `width` columns; with `maxRows`, how many characters were left.
function wrapChars(
  text: string,
  width: number,
  maxRows?: number,
): [string[], number] {
  if (!text) return [[''], 0];
  const parts: string[] = [];
  let current = '';
  let used = 0;
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    const size = stringWidth(char);
    if (current && used + size > width) {
      parts.push(current);
      if (maxRows !== undefined && parts.length >= maxRows)
        return [parts, chars.length - index];
      current = '';
      used = 0;
    }
    current += char;
    used += size;
  }
  parts.push(current);
  return [parts, 0];
}

// The `⎿` lines under a call: six lines and `… +N lines · ctrl+o` folded, everything when
// expanded; a file read folds to `Read 31 lines · ctrl+o`. Errors red, a mistake the model
// can fix struck through, the rest faint.
export function resultRows(
  call: ToolCall,
  result: Message,
  options: { width: number; expanded: boolean },
): string[] {
  const p = palette();
  const bg = toolTint(call.name);
  const job = backgroundJob(result);
  if (job) return jobResultRows(job, bg, options);
  const error = result.status === 'error';
  const recoverable = error && Boolean(result.recoverable);
  const output = terminalText(result.content);
  if (call.name === 'read_file' && !error && !options.expanded) {
    const window = readWindow(output);
    if (window)
      return [
        tintedRow(
          [
            ['', '   ⎿ '],
            [
              p.faint,
              `Read ${window.count} line${window.count === 1 ? '' : 's'} · ctrl+o`,
            ],
          ],
          bg,
          options.width,
        ),
      ];
  }
  let lines = resultContent(output);
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.length) lines = ['(no output)'];
  const items = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - items.length;
  const shown = hidden
    ? [...items, `… +${hidden} line${hidden === 1 ? '' : 's'} · ctrl+o`]
    : items;
  const colour = recoverable ? p.muted_strike : error ? p.red : p.faint;
  const rows: string[] = [];
  shown.forEach((item, index) => {
    const prefix = index === 0 ? '   ⎿ ' : '     ';
    const [parts, left] = wrapChars(
      item,
      Math.max(20, options.width - 6),
      options.expanded ? undefined : COLLAPSED_WRAP_ROWS,
    );
    const fold = hidden && index === shown.length - 1;
    parts.forEach((part, at) =>
      rows.push(
        tintedRow(
          [
            ['', at === 0 ? prefix : '     '],
            [fold ? p.faint : colour, part],
          ],
          bg,
          options.width,
        ),
      ),
    );
    if (left)
      rows.push(
        tintedRow(
          [
            ['', '     '],
            [p.faint, `… +${left} chars · ctrl+o`],
          ],
          bg,
          options.width,
        ),
      );
  });
  return rows;
}

// A call that went on as a background job, from what it returned: the job, how it got
// there (started there, moved there, or a command that left processes running) and what
// the command printed before. The sentence for the model is not shown. Sessions of the
// Python releases carry the job in the message's `circle_job`.
const JOB_SENTENCE =
  /(?:^|\n)(In background|Command continues in background|Watching in background): (j\d+) · (\w+) · [^\n]*do not poll or sleep\.\s*$/;
const LEGACY_JOB_NOTE = /\[The command[^[\]]*stop_job\.\]\s*$/;
const LEGACY_EXIT =
  /\n*\[Command (?:succeeded|failed) with exit code -?\d+\]\s*$/;
export interface BackgroundJob {
  id: string;
  how: 'started' | 'moved' | 'adopted';
  text: string;
}
export function backgroundJob(result: Message): BackgroundJob | undefined {
  if (result.status === 'error') return undefined;
  const match = result.content.match(JOB_SENTENCE);
  if (match)
    return {
      id: match[2]!,
      how:
        match[1] !== 'Command continues in background'
          ? 'started'
          : match[3] === 'adopted'
            ? 'adopted'
            : 'moved',
      text:
        match[1] === 'Command continues in background'
          ? result.content.slice(0, match.index).trim()
          : '',
    };
  const extra = result.legacy_data?.data.additional_kwargs;
  const legacy =
    extra && typeof extra === 'object'
      ? (extra as Record<string, unknown>).circle_job
      : undefined;
  if (
    !legacy ||
    typeof legacy !== 'object' ||
    typeof (legacy as Record<string, unknown>).id !== 'string'
  )
    return undefined;
  const { id, how } = legacy as Record<string, unknown>;
  return {
    id: id as string,
    how: how === 'moved' ? 'moved' : how === 'adopted' ? 'adopted' : 'started',
    text:
      how === 'started'
        ? ''
        : result.content
            .replace(LEGACY_EXIT, '')
            .trimEnd()
            .replace(LEGACY_JOB_NOTE, '')
            .trim(),
  };
}

// What the command printed before it went on (six lines, folded), then one faint line that
// names the job: `in background · j3`, `moved to background · j4`, `left running · j5`.
function jobResultRows(
  job: BackgroundJob,
  bg: string,
  options: { width: number; expanded: boolean },
): string[] {
  const p = palette();
  const rows: string[] = [];
  const text = plainJobOutput(terminalText(job.text)).trimEnd();
  if (text && text !== '<no output>') {
    const lines = text.split('\n');
    const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
    shown.forEach((line, index) => {
      const [parts] = wrapChars(
        line,
        Math.max(20, options.width - 6),
        options.expanded ? undefined : COLLAPSED_WRAP_ROWS,
      );
      parts.forEach((part, at) =>
        rows.push(
          tintedRow(
            [
              ['', index === 0 && at === 0 ? '   ⎿ ' : '     '],
              [p.faint, part],
            ],
            bg,
            options.width,
          ),
        ),
      );
    });
    const hidden = lines.length - shown.length;
    if (hidden)
      rows.push(
        tintedRow(
          [
            ['', '     '],
            [p.faint, `… +${hidden} line${hidden === 1 ? '' : 's'} · ctrl+o`],
          ],
          bg,
          options.width,
        ),
      );
  }
  const word =
    job.how === 'moved'
      ? 'moved to background'
      : job.how === 'adopted'
        ? 'left running'
        : 'in background';
  rows.push(
    tintedRow(
      [
        ['', rows.length ? '     ' : '   ⎿ '],
        [p.faint, `${word} · ${job.id}`],
      ],
      bg,
      options.width,
    ),
  );
  return rows;
}

// An extension's own lines for a result, folded like a built-in result: six of them and
// `… +N lines · ctrl+o`, all of them once ctrl+o shows everything. No lines: undefined, and
// the built-in rows are drawn instead (a renderer that failed returns none).
export function extensionRows(
  lines: string[] | undefined,
  call: ToolCall,
  options: { width: number; expanded: boolean },
): string[] | undefined {
  if (!lines?.length) return undefined;
  const p = palette();
  const bg = toolTint(call.name);
  const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const rows = shown.map((line) => tintedRow([['', line]], bg, options.width));
  const hidden = lines.length - shown.length;
  if (hidden)
    rows.push(
      tintedRow(
        [
          ['', '     '],
          [p.faint, `… +${hidden} line${hidden === 1 ? '' : 's'} · ctrl+o`],
        ],
        bg,
        options.width,
      ),
    );
  return rows;
}

// A finished job's notice, where it wakes the model: ` ◆ j3 done · npm test · 12s`, one row
// per job. The glyph is green when it is done, red when it failed and dim when it was
// stopped; the words are dim.
export function noticeRows(display: string, width: number): string[] {
  const p = palette();
  return plainJobOutput(display)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const words = line.replace(/^◆\s*/, '');
      const status = words.match(/^\S+ (\S+)/)?.[1];
      const colour =
        status === 'done' ? p.green : status === 'failed' ? p.red : p.dim;
      return ` ${colour}◆${p.reset} ${p.dim}${truncate(words, Math.max(1, width - 3))}${p.reset}`;
    });
}

// A leading `**Title**` paragraph of the reasoning is its title; the rest is the body.
export function reasoningSummary(text: string): {
  title?: string;
  body: string;
} {
  const content = text.trim();
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (!match) return { body: content };
  const title = match[1]!
    .replace(/[\x00-\x1f\x7f]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  if (!title || /^\d+$/.test(title) || /^[0-9a-f]{7,64}$/i.test(title))
    return { body: content };
  return { title, body: content.slice(match[0].length).trimEnd() };
}

// `∴ Thinking · title` while it runs, `∴ Thought 6.3s · title` when settled, with `ctrl+t`
// when its text is folded away; expanded, the text follows in faint.
export function thinkingRows(
  text: string,
  options: {
    done: boolean;
    seconds?: number;
    expanded: boolean;
    width: number;
  },
): string[] {
  const p = palette();
  const { title, body } = reasoningSummary(text);
  let header = options.done ? '∴ Thought' : '∴ Thinking';
  if (options.done && options.seconds !== undefined)
    header += ` ${formatBusyElapsed(options.seconds)}`;
  if (title) header += ` · ${title}`;
  const style = sgrJoin(options.expanded ? p.reason_dim : p.reason, '\x1b[3m');
  const head: [string, string][] = [
    ['', ' '],
    [style, truncate(header, Math.max(1, options.width - 10))],
  ];
  if (body && !options.expanded) head.push(['', '  '], [p.faint, 'ctrl+t']);
  const rows = [tintedRow(head, p.think_bg, options.width)];
  if (options.expanded && body)
    for (const line of markdownRows(body, Math.max(20, options.width - 3), {
      base: p.faint,
      background: p.think_bg,
    }))
      rows.push(
        sgrJoin(p.think_bg, p.faint) +
          pad('   ' + line, options.width) +
          p.reset,
      );
  return rows;
}
