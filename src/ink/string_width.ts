import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
export { stringWidth, stripAnsi };
export function truncate(
  text: string,
  width: number,
  fromLeft = false,
): string {
  const plain = stripAnsi(text);
  if (stringWidth(plain) <= width) return plain;
  if (width <= 0) return '';
  if (width === 1) return '…';
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      plain,
    ),
  ].map((item) => item.segment);
  if (fromLeft) graphemes.reverse();
  let result = '';
  let used = 0;
  for (const glyph of graphemes) {
    const count = stringWidth(glyph);
    if (used + count > width - 1) break;
    result = fromLeft ? glyph + result : result + glyph;
    used += count;
  }
  return fromLeft ? '…' + result : result + '…';
}
export function wrap(text: string, width: number): string[] {
  const result: string[] = [];
  const columns = Math.max(1, width);
  for (const source of stripAnsi(text).replace(/\t/g, '    ').split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(source)) {
      const count = stringWidth(segment);
      if (used + count > columns && line) {
        result.push(line);
        line = '';
        used = 0;
      }
      line += segment;
      used += count;
    }
    result.push(line);
  }
  return result;
}
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
// A row with colour codes cut to `width` columns: the codes are kept, `…` marks the cut and
// the colours are reset after it.
export function truncateStyled(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 0) return '';
  const code = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
  let out = '';
  let used = 0;
  for (let index = 0; index < text.length;) {
    code.lastIndex = index;
    const found = code.exec(text);
    if (found) {
      out += found[0];
      index += found[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const size = stringWidth(char);
    if (used + size > width - 1) break;
    out += char;
    used += size;
    index += char.length;
  }
  return out + '…\x1b[0m';
}
