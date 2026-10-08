import { stripAnsi } from '../ink/string_width.js';
export class TranscriptFind {
  query = '';
  matches: number[] = [];
  at = -1;
  refresh(rows: string[], top = 0): void {
    const needle = this.query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    this.matches = needle
      ? rows.flatMap((row, index) =>
          stripAnsi(row)
            .toLocaleLowerCase()
            .replace(/\s+/g, ' ')
            .includes(needle)
            ? [index]
            : [],
        )
      : [];
    this.at = this.matches.length
      ? Math.max(
          0,
          this.matches.findIndex((row) => row >= top),
        )
      : -1;
  }
  next(reverse = false): void {
    if (this.matches.length)
      this.at =
        (this.at + (reverse ? -1 : 1) + this.matches.length) %
        this.matches.length;
  }
  updateRows(rows: string[]): void {
    const current = this.row;
    this.refresh(rows, current ?? 0);
    if (current !== undefined && this.matches.includes(current))
      this.at = this.matches.indexOf(current);
  }
  get row(): number | undefined {
    return this.matches[this.at];
  }
  get status(): string {
    return `find: ${this.query}▏${this.query ? `  ${this.matches.length ? `${this.at + 1}/${this.matches.length}` : 'no matches'}` : ''} · enter next · shift+enter previous · esc closes`;
  }
}
export function highlightMatches(row: string, query: string): string {
  if (!query.trim()) return row;
  // Preserve locally generated SGR spans while matching the visible text.
  const plain = stripAnsi(row);
  const words = query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(words.join('\\s+'), 'giu');
  const ranges: [number, number][] = [];
  for (const match of plain.matchAll(pattern))
    ranges.push([match.index, match.index + match[0].length]);
  if (!ranges.length) return row;
  let offset = 0;
  let result = '';
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      result += part;
      if (ranges.some(([a, b]) => offset >= a && offset < b))
        result += '\x1b[7m';
      continue;
    }
    for (const char of part) {
      if (ranges.some(([a]) => offset === a)) result += '\x1b[7m';
      result += char;
      offset += char.length;
      if (ranges.some(([, b]) => offset === b)) result += '\x1b[27m';
    }
  }
  return result + '\x1b[27m';
}
