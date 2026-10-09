export const RESET = '\x1b[0m';
export const COLOR_QUERY =
  '\x1b]10;?\x07\x1b]11;?\x07' +
  [2, 4, 5, 14].map((slot) => `\x1b]4;${slot};?\x07`).join('');
export type RGB = [number, number, number];
export const DEFAULT_DARK: [string, string] = ['#d6dee6', '#10151a'];
export const DEFAULT_LIGHT: [string, string] = ['#3c4148', '#f7f8fa'];
export function hexToRgb(value: string): RGB {
  const match = value.trim().match(/^#?([0-9a-f]+)$/i);
  const digits = match?.[1];
  if (!digits || digits.length % 3 || digits.length < 3 || digits.length > 12)
    throw new Error('not a hex color');
  const size = digits.length / 3;
  const scale = 2 ** (4 * size) - 1;
  return [0, 1, 2].map((index) =>
    Math.round(
      (parseInt(digits.slice(index * size, (index + 1) * size), 16) * 255) /
        scale,
    ),
  ) as RGB;
}
export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((channel) =>
        Math.max(0, Math.min(255, Math.round(channel)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function parseColorSpec(spec: string): string | undefined {
  try {
    const value = spec.trim();
    if (value.startsWith('rgb:'))
      return rgbToHex(hexToRgb('#' + value.slice(4).replaceAll('/', '')));
    return rgbToHex(hexToRgb(value));
  } catch {
    return undefined;
  }
}
export function mix(a: string, b: string, amount: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  const ratio = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    from.map(
      (channel, index) => channel + (to[index]! - channel) * ratio,
    ) as RGB,
  );
}
export function relativeLuminance(color: string): number {
  const [r, g, b] = hexToRgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function mixWithFloor(
  fg: string,
  bg: string,
  amount: number,
  floor: number,
  surfaces: string[] = [],
): string {
  for (
    let ratio = amount;
    ratio > 0;
    ratio = Math.round((ratio - 0.05) * 10000) / 10000
  ) {
    const color = mix(fg, bg, ratio);
    if (
      [bg, ...surfaces].every(
        (surface) => contrastRatio(color, surface) >= floor,
      )
    )
      return color;
  }
  return rgbToHex(hexToRgb(fg));
}
export function fgSgr(color: string): string {
  return `\x1b[38;2;${hexToRgb(color).join(';')}m`;
}
export function bgSgr(color: string): string {
  return `\x1b[48;2;${hexToRgb(color).join(';')}m`;
}
export function sgrJoin(...codes: string[]): string {
  const parameters = codes
    .filter((code) => /^\x1b\[[\d;]*m$/.test(code))
    .map((code) => code.slice(2, -1))
    .filter(Boolean);
  return parameters.length ? '\x1b[' + parameters.join(';') + 'm' : '';
}
// The rainbow: blue → purple → red → orange, then back to blue. The frame runs it round
// the input box while the model works; the welcome's logo is the same ring, standing still.
export const GRADIENT_STOPS: readonly [number, RGB][] = [
  [0, [8, 148, 255]],
  [0.3, [201, 89, 221]],
  [0.65, [255, 46, 84]],
  [0.9, [255, 144, 4]],
  [1, [8, 148, 255]],
];
// The stops for the frame on `bg`: each one is mixed toward black, 5% at a time and at most
// 60%, until it reads at 3:1. On a dark background they stay as they are.
export function frameStops(bg: string): [number, RGB][] {
  return GRADIENT_STOPS.map(([at, rgb]) => {
    const own = rgbToHex(rgb);
    let colour = own;
    let amount = 0;
    while (amount < 0.6 && contrastRatio(colour, bg) < 3) {
      amount = Math.round((amount + 0.05) * 10000) / 10000;
      colour = mix(own, '#000000', amount);
    }
    return [at, hexToRgb(colour)];
  });
}
// The colour at `u` (0–1, wrapping) along `stops`, channels truncated as in the Python version.
export function gradientAt(stops: readonly [number, RGB][], u: number): RGB {
  const at = ((u % 1) + 1) % 1;
  for (let index = 1; index < stops.length; index++) {
    const [p0, c0] = stops[index - 1]!;
    const [p1, c1] = stops[index]!;
    if (at <= p1) {
      const t = p1 > p0 ? (at - p0) / (p1 - p0) : 0;
      return c0.map((channel, i) =>
        Math.trunc(channel + (c1[i]! - channel) * t),
      ) as RGB;
    }
  }
  return stops.at(-1)![1];
}
// The frame's colour at `u` round its perimeter, on the current background.
export function rainbowAt(u: number): string {
  return fgSgr(rgbToHex(gradientAt(palette().rainbow_stops, u)));
}
// A colour given as RGB channels, such as a cell of the logo.
export function rgbSgr(rgb: RGB): string {
  return fgSgr(rgbToHex(rgb));
}
// `COLORFGBG` names the background's colour slot last ("15;0"): 0–6 and 8 are dark.
export function colorfgbgIsLight(raw: string | undefined): boolean {
  const last = (raw ?? '').split(';').at(-1)?.trim() ?? '';
  if (!/^\d+$/.test(last)) return false;
  return ![0, 1, 2, 3, 4, 5, 6, 8].includes(Number(last));
}
// The built-in pair when the terminal cannot be asked: COLORFGBG, then dark.
export function fallbackColors(
  env: NodeJS.ProcessEnv = process.env,
): [string, string] {
  return colorfgbgIsLight(env.COLORFGBG) ? DEFAULT_LIGHT : DEFAULT_DARK;
}
export interface Palette {
  text: string;
  dim: string;
  faint: string;
  em: string;
  panel_bg: string;
  sel_bg: string;
  line: string;
  outline: string;
  fg_hex: string;
  bg_hex: string;
  is_dark: boolean;
  green: string;
  yellow: string;
  red: string;
  blue: string;
  reset: string;
  read_bg: string;
  write_bg: string;
  think_bg: string;
  agent_bg: string;
  read_bg_hex: string;
  write_bg_hex: string;
  think_bg_hex: string;
  agent_bg_hex: string;
  // Thinking rows: blue, the terminal's own slot; dimmed for an expanded header.
  reason: string;
  reason_dim: string;
  reason_hi: string;
  // A call the model can fix itself: no lamp, dim and struck through.
  muted_strike: string;
  // The frame's rainbow: the gradient stops as drawn on this background.
  rainbow: string[];
  rainbow_stops: [number, RGB][];
}
export function buildPalette(
  fgHex: string,
  bgHex: string,
  slots: Record<number, RGB> = {},
): Palette {
  const fg = rgbToHex(hexToRgb(fgHex));
  const bg = rgbToHex(hexToRgb(bgHex));
  const dark = relativeLuminance(bg) < 0.5;
  const tints = {
    read_bg: mix(bg, rgbToHex(slots[4] ?? [92, 120, 255]), 0.15),
    write_bg: mix(bg, rgbToHex(slots[2] ?? [60, 160, 90]), 0.15),
    think_bg: mix(bg, rgbToHex(slots[5] ?? [175, 95, 175]), 0.15),
    agent_bg: mix(bg, rgbToHex(slots[14] ?? [0, 205, 205]), 0.15),
  };
  const panel = mix(bg, fg, 0.06);
  const surfaces = [panel, ...Object.values(tints)];
  const rainbowStops = frameStops(bg);
  return {
    text: fgSgr(fg),
    dim: fgSgr(mixWithFloor(fg, bg, 0.35, 4.5, surfaces)),
    faint: fgSgr(mixWithFloor(fg, bg, 0.55, 3, surfaces)),
    em: fgSgr(mix(fg, dark ? '#ffffff' : '#000000', 0.45)),
    panel_bg: bgSgr(panel),
    sel_bg: bgSgr(mix(bg, fg, 0.16)),
    line: fgSgr(mix(bg, fg, 0.22)),
    outline: fgSgr(mix(bg, fg, 0.4)),
    fg_hex: fg,
    bg_hex: bg,
    is_dark: dark,
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[36m',
    reset: RESET,
    read_bg: bgSgr(tints.read_bg),
    write_bg: bgSgr(tints.write_bg),
    think_bg: bgSgr(tints.think_bg),
    agent_bg: bgSgr(tints.agent_bg),
    read_bg_hex: tints.read_bg,
    write_bg_hex: tints.write_bg,
    think_bg_hex: tints.think_bg,
    agent_bg_hex: tints.agent_bg,
    reason: '\x1b[34m',
    reason_dim: '\x1b[2;34m',
    reason_hi: '\x1b[94m',
    muted_strike: '\x1b[2;9m',
    rainbow: rainbowStops.slice(0, -1).map(([, rgb]) => fgSgr(rgbToHex(rgb))),
    rainbow_stops: rainbowStops,
  };
}
let current = buildPalette(...DEFAULT_DARK);
// Bumped on every palette swap, so caches of painted rows know to drop their entries.
let paletteEpoch = 0;
export function palette(): Palette {
  return current;
}
export function paletteRev(): number {
  return paletteEpoch;
}
export function setPalette(value: Palette): void {
  current = value;
  paletteEpoch++;
}
export type LampState = 'running' | 'ok' | 'error' | 'wait' | 'none';
// The lamp's colour alone, so a tinted row can put its background in the same SGR
// (`sgrJoin(bg, lampSgr(state))`); '' for a lamp that is not lit.
export function lampSgr(state: LampState, now = Date.now()): string {
  const p = palette();
  return state === 'running'
    ? Math.floor(now / 575) % 2
      ? sgrJoin('\x1b[2m', p.yellow)
      : p.yellow
    : state === 'ok'
      ? p.green
      : state === 'error'
        ? p.red
        : state === 'wait'
          ? p.blue
          : '';
}
// One lamp: yellow and blinking while it runs, green done, red failed, cyan waiting for
// you. A lamp that is not lit is a blank that keeps the column.
export function statusLight(state: LampState, now = Date.now()): string {
  const sgr = lampSgr(state, now);
  return sgr ? sgr + '●' + palette().reset : ' ';
}
