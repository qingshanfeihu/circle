import { Lexer, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import { palette, sgrJoin } from '../theme.js';
import { stringWidth, stripAnsi, wrap } from '../string_width.js';
export interface MarkdownStyle {
  base?: string;
  background?: string;
}
interface Span {
  text: string;
  style: string;
}
/** Strip terminal instructions before parsing; styles below are generated locally. */
export function terminalText(text: string): string {
  return stripAnsi(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replaceAll('\t', '    ');
}
function protectTableCodePipes(source: string): string {
  const lines = source.split('\n');
  let fence: { marker: string; length: number } | undefined;
  let table = false;
  const separator = (line: string): boolean => {
    if (!line.includes('|') || /^ {4}/.test(line)) return false;
    return line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .every((cell) => /^\s*:?-+:?\s*$/.test(cell));
  };
  return lines
    .map((line, index) => {
      const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (run) {
        if (!fence) fence = { marker: run[1]![0]!, length: run[1]!.length };
        else if (
          run[1]![0] === fence.marker &&
          run[1]!.length >= fence.length &&
          !run[2]!.trim()
        )
          fence = undefined;
        table = false;
        return line;
      }
      if (fence) return line;
      if (separator(lines[index + 1] ?? '')) table = true;
      else if (!line.includes('|') || !line.trim()) table = false;
      if (!table) return line;
      return line.replace(
        /(?<!`)(`+)(?!`)(.*?)(?<!`)\1(?!`)/g,
        (span: string) => span.replace(/(?<!\\)\|/g, '\\|'),
      );
    })
    .join('\n');
}
function inline(tokens: Token[], style = ''): Span[] {
  const p = palette();
  const result: Span[] = [];
  for (const token of tokens) {
    if (token.type === 'checkbox') continue;
    const text = decodeHTML(
      String(('text' in token ? token.text : undefined) ?? token.raw ?? ''),
    );
    if (
      token.type === 'strong' ||
      token.type === 'em' ||
      token.type === 'del'
    ) {
      const modifier =
        token.type === 'strong'
          ? '\x1b[1m'
          : token.type === 'em'
            ? '\x1b[3m'
            : '\x1b[9m';
      result.push(...inline(token.tokens ?? [], sgrJoin(style, modifier)));
    } else if (token.type === 'codespan')
      result.push({ text, style: sgrJoin(style, p.panel_bg, p.text) });
    else if (token.type === 'br') result.push({ text: '\n', style });
    else if (token.type === 'link') {
      result.push(
        ...inline(token.tokens ?? [], sgrJoin(style, p.blue, '\x1b[4m')),
      );
      if (text !== token.href)
        result.push({
          text: ` (${decodeHTML(String(token.href))})`,
          style: sgrJoin(style, p.dim),
        });
    } else if (token.type === 'image')
      result.push({
        text: `[image: ${text}] (${String(token.href)})`,
        style: sgrJoin(style, p.dim),
      });
    else if (token.type === 'text' && token.tokens)
      result.push(...inline(token.tokens, style));
    else result.push({ text, style });
  }
  return result;
}
function rowsFor(
  spans: Span[],
  width = 80,
  options: MarkdownStyle,
  wordWrap = true,
): string[] {
  const p = palette();
  const base = (options.background ?? '') + (options.base ?? p.text);
  const glyphs = spans.flatMap((span) =>
    [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        terminalText(span.text),
      ),
    ].map(({ segment }) => ({
      text: segment,
      style: span.style,
      width: stringWidth(segment),
    })),
  );
  const rows: (typeof glyphs)[] = [];
  let line: typeof glyphs = [];
  let used = 0;
  const flush = (): void => {
    rows.push(line);
    line = [];
    used = 0;
  };
  for (const glyph of glyphs) {
    if (glyph.width > width) {
      glyph.text = '�';
      glyph.width = 1;
    }
    if (glyph.text === '\n') {
      flush();
      continue;
    }
    if (used + glyph.width > width && line.length) {
      const space = wordWrap
        ? line.map((item) => item.text).lastIndexOf(' ')
        : -1;
      if (space > 0) {
        const tail = line.slice(space + 1);
        line = line.slice(0, space);
        flush();
        line = tail;
        used = tail.reduce((sum, item) => sum + item.width, 0);
      } else flush();
      if (glyph.text === ' ' && wordWrap) continue;
    }
    line.push(glyph);
    used += glyph.width;
  }
  flush();
  return rows.map((row) => {
    let style = '';
    let text = p.reset + base;
    for (const glyph of row) {
      if (glyph.style !== style) {
        style = glyph.style;
        text += p.reset + base + style;
      }
      text += glyph.text;
    }
    return text + p.reset;
  });
}
function blocks(
  tokens: Token[],
  width: number,
  options: MarkdownStyle,
): string[] {
  const p = palette();
  const rows: string[] = [];
  for (const token of tokens) {
    if (token.type === 'space') {
      if (rows.length && rows.at(-1) !== '') rows.push('');
    } else if (
      token.type === 'paragraph' ||
      token.type === 'text' ||
      token.type === 'heading'
    )
      rows.push(
        ...rowsFor(
          inline(
            token.tokens ??
              Lexer.lexInline(String(token.text ?? ''), { gfm: true }),
            token.type === 'heading' ? '\x1b[1m' : '',
          ),
          width,
          options,
        ),
        ...(token.type === 'heading' ? [''] : []),
      );
    else if (token.type === 'hr')
      rows.push(p.line + '─'.repeat(width) + p.reset);
    else if (token.type === 'code') {
      const code = token as Tokens.Code;
      const room = Math.max(1, width - 2);
      const content = wrap(code.text, room);
      rows.push(
        ...content.map(
          (line) =>
            p.panel_bg +
            p.text +
            ' ' +
            line +
            ' '.repeat(Math.max(0, width - 1 - stringWidth(line))) +
            p.reset,
        ),
      );
    } else if (token.type === 'blockquote')
      rows.push(
        ...blocks(token.tokens ?? [], Math.max(1, width - 2), options).map(
          (row) => p.dim + '│ ' + p.reset + row,
        ),
      );
    else if (token.type === 'list') {
      const list = token as Tokens.List;
      list.items.forEach((item, index) => {
        const marker = item.task
          ? item.checked
            ? '☑ '
            : '☐ '
          : list.ordered
            ? `${Number(list.start) + index}. `
            : '• ';
        const body = blocks(
          item.tokens,
          Math.max(1, width - stringWidth(marker)),
          options,
        );
        rows.push(
          ...body.map(
            (row, at) =>
              p.reset +
              (options.background ?? '') +
              (options.base ?? p.text) +
              (at ? ' '.repeat(stringWidth(marker)) : marker) +
              row,
          ),
        );
      });
    } else if (token.type === 'table') {
      const table = token as Tokens.Table;
      const columns = table.header.length;
      const overhead = columns * 3 + 1;
      if (width < overhead + columns) {
        for (const row of [table.header, ...table.rows])
          rows.push(
            ...rowsFor(
              row.flatMap((cell, index) => [
                ...(index ? [{ text: ' | ', style: p.dim }] : []),
                ...inline(cell.tokens),
              ]),
              width,
              options,
            ),
          );
        continue;
      }
      const values = [table.header, ...table.rows].map((row) =>
        row.map((cell) => inline(cell.tokens)),
      );
      const desired = table.header.map((_cell, index) =>
        Math.max(
          1,
          ...values.map((row) =>
            stringWidth(row[index]!.map((span) => span.text).join('')),
          ),
        ),
      );
      const sizes = [...desired];
      let available = width - overhead;
      while (sizes.reduce((a, b) => a + b, 0) > available) {
        const at = sizes.indexOf(Math.max(...sizes));
        sizes[at]!--;
      }
      const border = (left: string, middle: string, right: string): string =>
        p.line +
        left +
        sizes.map((size) => '─'.repeat(size + 2)).join(middle) +
        right +
        p.reset;
      rows.push(border('┌', '┬', '┐'));
      values.forEach((cells, index) => {
        const contents = cells.map((cell, at) =>
          rowsFor(cell, sizes[at]!, options),
        );
        const height = Math.max(...contents.map((lines) => lines.length));
        for (let line = 0; line < height; line++) {
          let row = p.line + '│';
          contents.forEach((lines, at) => {
            const text = lines[line] ?? '';
            const padding = Math.max(0, sizes[at]! - stringWidth(text));
            const align = table.align[at];
            const before =
              align === 'right'
                ? padding
                : align === 'center'
                  ? Math.floor(padding / 2)
                  : 0;
            row +=
              ' ' +
              ' '.repeat(before) +
              text +
              ' '.repeat(padding - before) +
              ' ' +
              p.line +
              '│';
          });
          rows.push(row + p.reset);
        }
        if (!index) rows.push(border('├', '┼', '┤'));
      });
      rows.push(border('└', '┴', '┘'));
    } else if (token.type === 'html')
      rows.push(
        ...rowsFor([{ text: String(token.text), style: '' }], width, options),
      );
    else if (token.type !== 'def' && token.type !== 'checkbox')
      rows.push(
        ...rowsFor([{ text: token.raw ?? '', style: '' }], width, options),
      );
  }
  return rows;
}
export function markdownRows(
  text: string,
  width = 80,
  options: MarkdownStyle = {},
): string[] {
  const room = Math.max(1, width);
  return blocks(
    Lexer.lex(protectTableCodePipes(terminalText(text)), { gfm: true }),
    room,
    options,
  );
}
