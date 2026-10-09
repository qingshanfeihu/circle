// The welcome block: the first thing in every session's transcript, the folder's home page.
//
// The logo (`docs/images/logo.svg`) on the left: the frame's rainbow closed into a ring,
// blue at the top, then purple, red and orange clockwise, in its own colours on any
// background. Beside it Circle's version, the model and where it runs, and the folder.
// Under it what the folder brings, each with a lamp, and the folder's recent sessions.
//
// It is drawn, never stored: the session asks for the rows again on every repaint, so no
// colour outlives a theme change (ported from circle/ink/components/welcome.py).
import {
  GRADIENT_STOPS,
  palette,
  rgbSgr,
  statusLight,
  type LampState,
  type RGB,
} from '../theme.js';
import { stringWidth, truncate } from '../string_width.js';

export const LOGO_ROWS = 6; // the ring is this tall and twice as many columns wide
export const LOGO_MIN_WIDTH = 50; // narrower than this, the welcome is text only
const RING_INNER = 0.66; // inner radius / outer radius, thickened for the coarse grid
// The logo's own stops: the frame's colours at the quarters, as logo.svg draws them.
const LOGO_STOPS: [number, RGB][] = [
  ...[0, 1, 2, 3].map((index): [number, RGB] => [
    index / 4,
    GRADIENT_STOPS[index]![1],
  ]),
  [1, GRADIENT_STOPS[0]![1]],
];
// Quadrant blocks by which sub-cells are on: top-left 8, top-right 4, bottom-left 2,
// bottom-right 1.
const QUADRANTS: Record<number, string> = {
  8: '▘',
  4: '▝',
  2: '▖',
  1: '▗',
  12: '▀',
  3: '▄',
  10: '▌',
  5: '▐',
  9: '▚',
  6: '▞',
  14: '▛',
  13: '▜',
  11: '▙',
  7: '▟',
  15: '█',
};

function gradient(u: number): RGB {
  const at = ((u % 1) + 1) % 1;
  for (let index = 1; index < LOGO_STOPS.length; index++) {
    const [p0, c0] = LOGO_STOPS[index - 1]!;
    const [p1, c1] = LOGO_STOPS[index]!;
    if (at <= p1) {
      const t = (at - p0) / (p1 - p0);
      return c0.map((channel, i) => channel + (c1[i]! - channel) * t) as RGB;
    }
  }
  return LOGO_STOPS.at(-1)![1];
}

let ring: { bits: number; colour?: RGB }[][] | undefined;
// The ring as quadrant cells. A cell is about twice as tall as it is wide, so a grid twice
// as wide as it is tall draws a round ring.
function ringCells(): { bits: number; colour?: RGB }[][] {
  if (ring) return ring;
  const rows = LOGO_ROWS;
  const cols = LOGO_ROWS * 2;
  const samples = 8;
  ring = [];
  for (let r = 0; r < rows; r++) {
    const line: { bits: number; colour?: RGB }[] = [];
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      const colours: RGB[] = [];
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].forEach(([qx, qy], quadrant) => {
        let hit = 0;
        const sum = [0, 0, 0];
        for (let sy = 0; sy < samples; sy++)
          for (let sx = 0; sx < samples; sx++) {
            const x = -1 + (2 * c + qx! + (sx + 0.5) / samples) / cols;
            const y = -1 + (2 * r + qy! + (sy + 0.5) / samples) / rows;
            const radius = Math.hypot(x, y);
            if (radius >= RING_INNER && radius <= 1) {
              hit++;
              const rgb = gradient(Math.atan2(x, -y) / (2 * Math.PI));
              for (let k = 0; k < 3; k++) sum[k]! += rgb[k]!;
            }
          }
        if (hit * 2 >= samples * samples) {
          bits |= 8 >> quadrant;
          colours.push(sum.map((value) => value / hit) as RGB);
        }
      });
      line.push({
        bits,
        colour: colours.length
          ? ([0, 1, 2].map((k) =>
              Math.round(
                colours.reduce((total, rgb) => total + rgb[k]!, 0) /
                  colours.length,
              ),
            ) as RGB)
          : undefined,
      });
    }
    ring.push(line);
  }
  return ring;
}

// The ring, `LOGO_ROWS` rows of `2 * LOGO_ROWS` columns.
export function logoRows(): string[] {
  const reset = palette().reset;
  return ringCells().map(
    (line) =>
      line
        .map(({ bits, colour }) =>
          bits && colour ? rgbSgr(colour) + QUADRANTS[bits] : reset + ' ',
        )
        .join('') + reset,
  );
}

// One row of what the folder brings.
export interface WelcomeItem {
  kind: string;
  text: string;
  state: LampState; // none until trusted, running while it loads, ok, error
  errors?: string[]; // under the row, in red, when it failed
}
export interface WelcomeInfo {
  version: string;
  model: string; // '' until setup has connected a model
  endpoint: string;
  folder: string;
  branch: string;
  items: WelcomeItem[];
  recent: [title: string, age: string][];
  more: number; // recent sessions not listed
}

// `3m`, `5h`, `2d`: how long ago, for lists.
export function age(updated: number, now = Date.now()): string {
  const gone = Math.max(0, (now - updated) / 1000);
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const)
    if (gone >= size) return `${Math.floor(gone / size)}${unit}`;
  return 'now';
}

// The block's rows for a transcript `width` columns wide, ending in one blank row.
export function welcomeRows(width: number, info: WelcomeInfo): string[] {
  const p = palette();
  width = Math.max(20, Math.floor(width));
  const withLogo = width >= LOGO_MIN_WIDTH;
  const indent = withLogo ? 2 + LOGO_ROWS * 2 + 3 : 1;
  const room = Math.max(8, width - indent - 1);
  let connection: string;
  if (info.model) {
    const host = info.endpoint ? ` · ${info.endpoint}` : '';
    const model = truncate(info.model, room);
    connection = `${p.text}${model}${p.reset}${p.dim}${truncate(host, room - stringWidth(model))}${p.reset}`;
  } else connection = `${p.faint}not connected yet${p.reset}`;
  const branch = info.branch ? ` (${info.branch})` : '';
  const folder = truncate(
    info.folder,
    Math.max(4, room - stringWidth(branch)),
    true,
  );
  const identity = [
    `${p.em}circle${p.reset} ${p.faint}${info.version}${p.reset}`,
    connection,
    `${p.text}${folder}${p.reset}${p.dim}${branch}${p.reset}`,
  ];
  const rows: string[] = [];
  if (withLogo) {
    const beside = ['', ...identity];
    logoRows().forEach((logo, index) => {
      const text = beside[index] ?? '';
      rows.push(text ? `  ${logo}   ${text}` : `  ${logo}`);
    });
  } else rows.push(...identity.map((text) => ` ${text}`));
  if (info.items.length) {
    rows.push('');
    const nameW =
      Math.max(...info.items.map((item) => stringWidth(item.kind))) + 2;
    const valueW = Math.max(4, width - 3 - nameW - 1);
    for (const item of info.items) {
      const lit = item.state !== 'none';
      rows.push(
        ` ${statusLight(item.state)} ${lit ? p.dim : p.faint}${item.kind.padEnd(nameW)}${p.reset}` +
          `${lit ? p.text : p.faint}${truncate(item.text, valueW)}${p.reset}`,
      );
      if (item.state === 'error')
        for (const error of item.errors ?? [])
          rows.push(
            `   ${' '.repeat(nameW)}${p.red}${truncate(error, valueW)}${p.reset}`,
          );
    }
  }
  if (info.recent.length) {
    rows.push('', `   ${p.faint}recent${p.reset}`);
    const ages = Math.max(...info.recent.map(([, when]) => stringWidth(when)));
    const titleRoom = Math.max(8, width - 3 - 3 - ages - 1);
    const titles = info.recent.map(([title]) => truncate(title, titleRoom));
    const titleW = Math.max(...titles.map((title) => stringWidth(title))) + 3;
    titles.forEach((title, index) => {
      const when = info.recent[index]![1];
      rows.push(
        `   ${p.text}${title}${p.reset}${' '.repeat(titleW - stringWidth(title))}` +
          `${p.dim}${when.padStart(ages)}${p.reset}`,
      );
    });
    if (info.more > 0)
      rows.push(`   ${p.dim}… +${info.more} more · /resume${p.reset}`);
  }
  rows.push('');
  return rows;
}
