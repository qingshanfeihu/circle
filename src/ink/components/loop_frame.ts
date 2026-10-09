// The input box's frame says whose turn it is. While the model works one rainbow travels
// round the rounded rectangle, and the busy word sits on the top edge from column 3 taking
// its colour from the same sweep. Otherwise the frame is still, faint, or in `border` (the
// card's yellow). The mode word (`read-only` / `auto`) sits at the bottom-right corner in its
// own colour, never the rainbow (ported from dialog_frame.py). `CIRCLE_TUI_SHIMMER=0` keeps
// the frame still while the model works.
import { palette, rainbowAt } from '../theme.js';
import { stringWidth, stripAnsi, truncate } from '../string_width.js';

export interface LoopFrame {
  top: string;
  left: string;
  right: string;
  bottom: string;
}
export interface LoopFrameOptions {
  // Seconds since the model's turn began; undefined draws a still frame.
  elapsed?: number;
  label?: string;
  mode?: string;
  modeSgr?: string;
  border?: string;
}

export function shimmerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CIRCLE_TUI_SHIMMER ?? '').trim() !== '0';
}

// The colour of perimeter cell `index`: the gradient turns once round the frame and flows
// clockwise, a full turn in about eight seconds. The frame counts as three rows tall.
function colorAt(index: number, perimeter: number, elapsed: number): string {
  const flow = (elapsed * 0.12) % 1;
  return rainbowAt(index / Math.max(perimeter, 1) + flow);
}

function fitLabel(label: string, width: number): string {
  const plain = stripAnsi(label);
  const room = Math.max(0, width - 6);
  if (!plain || !room) return '';
  return stringWidth(plain) <= room
    ? plain
    : room > 1
      ? truncate(plain, room)
      : '';
}

function modeBottom(
  width: number,
  mode: string,
  modeSgr: string,
  border: string,
  elapsed?: number,
): string {
  const p = palette();
  const label = ` ${mode} `;
  const labelAt = width - 2 - stringWidth(label);
  const perimeter = 2 * (width + 1);
  let out = '';
  for (let col = 0; col < width;) {
    if (col === labelAt && labelAt > 1) {
      out += p.reset + modeSgr + label;
      col += stringWidth(label);
      continue;
    }
    const glyph = col === 0 ? '╰' : col === width - 1 ? '╯' : '─';
    out +=
      (elapsed === undefined
        ? border
        : colorAt(2 * width - col, perimeter, elapsed)) + glyph;
    col++;
  }
  return out + p.reset;
}

export function loopFrame(
  frameWidth: number,
  options: LoopFrameOptions = {},
): LoopFrame {
  const p = palette();
  const width = Math.max(4, Math.floor(frameWidth));
  const label = fitLabel(options.label ?? '', width);
  const mode = options.mode ? fitLabel(options.mode, width) : '';
  const modeSgr = options.modeSgr || p.faint;
  const { elapsed } = options;
  if (elapsed === undefined || !shimmerEnabled()) {
    const edge = options.border || p.faint;
    const top = label
      ? `${edge}╭──${label}${'─'.repeat(Math.max(0, width - 4 - stringWidth(label)))}╮${p.reset}`
      : `${edge}╭${'─'.repeat(width - 2)}╮${p.reset}`;
    const bottom = mode
      ? modeBottom(width, mode, modeSgr, edge)
      : `${edge}╰${'─'.repeat(width - 2)}╯${p.reset}`;
    const side = `${edge}│${p.reset}`;
    return { top, left: side, right: side, bottom };
  }
  const perimeter = 2 * (width + 1);
  const labelAt = 3;
  const shown = label && labelAt + stringWidth(label) <= width - 3 ? label : '';
  let top = '';
  let col = 0;
  const edge = (): void => {
    const glyph = col === 0 ? '╭' : col === width - 1 ? '╮' : '─';
    top += colorAt(col, perimeter, elapsed) + glyph;
    col++;
  };
  while (col < (shown ? labelAt : width)) edge();
  if (shown) {
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(shown)) {
      top += colorAt(col, perimeter, elapsed) + segment;
      col += stringWidth(segment);
    }
    while (col < width) edge();
  }
  top += p.reset;
  let bottom: string;
  if (mode) bottom = modeBottom(width, mode, modeSgr, p.faint, elapsed);
  else {
    bottom = '';
    for (let at = 0; at < width; at++)
      bottom +=
        colorAt(2 * width - at, perimeter, elapsed) +
        (at === 0 ? '╰' : at === width - 1 ? '╯' : '─');
    bottom += p.reset;
  }
  return {
    top,
    left: colorAt(2 * width + 1, perimeter, elapsed) + '│' + p.reset,
    right: colorAt(width, perimeter, elapsed) + '│' + p.reset,
    bottom,
  };
}
