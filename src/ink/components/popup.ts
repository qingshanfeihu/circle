import { palette, sgrJoin } from '../theme.js';
import { stringWidth } from '../string_width.js';

export interface PopupItem {
  label: string;
  meta?: string;
  current?: boolean;
}
/** `text` in at most `columns` columns, ending in "…" when it was cut. */
function fit(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text;
  let kept = '';
  let used = 0;
  for (const char of text) {
    const count = stringWidth(char);
    if (used + count > columns - 1) break;
    kept += char;
    used += count;
  }
  return kept + '…';
}
/** Segments in order, cut at `width`, padded with the background to the full width. */
function compose(
  width: number,
  segments: [text: string, style: string][],
  background: string,
): string {
  const p = palette();
  let out = '';
  let used = 0;
  for (let [text, style] of segments) {
    const room = width - used;
    if (room <= 0) break;
    text = fit(text, room);
    used += stringWidth(text);
    const code = sgrJoin(background, style);
    out += (code || p.reset) + text;
  }
  if (used < width) out += (background || p.reset) + ' '.repeat(width - used);
  return out + p.reset;
}
/**
 * A list that does not stop the turn, above the input box: rows on the panel background,
 * no border, the focused row on `sel_bg`. Every row is `width` columns wide.
 */
export function popupRows(
  title: string,
  items: PopupItem[],
  focus: number,
  width: number,
): string[] {
  const p = palette();
  width = Math.max(12, width);
  const rows = [
    compose(
      width,
      [
        [' ', ''],
        [title, p.faint],
      ],
      p.panel_bg,
    ),
  ];
  const tags = items.map(
    (item) => (item.meta ?? '') + (item.current ? ' · current' : ''),
  );
  // A long label is cut, not the row: the column on the right stays
  const room = Math.max(
    8,
    width - 6 - Math.max(0, ...tags.map((tag) => stringWidth(tag))),
  );
  const labels = items.map((item) => fit(item.label, room));
  const nameWidth =
    Math.max(0, ...labels.map((label) => stringWidth(label))) + 3;
  labels.forEach((label, index) => {
    const gap = ' '.repeat(Math.max(0, nameWidth - stringWidth(label)));
    rows.push(
      index === focus
        ? compose(
            width,
            [[`   ${label}${gap}${tags[index]}`, sgrJoin(p.sel_bg, p.em)]],
            p.sel_bg,
          )
        : compose(
            width,
            [
              ['   ', ''],
              [label + gap, p.text],
              [tags[index]!, p.dim],
            ],
            p.panel_bg,
          ),
    );
  });
  return rows;
}
