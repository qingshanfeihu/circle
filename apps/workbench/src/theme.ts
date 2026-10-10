import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  hexToRgb,
  mix,
  palette,
  setPalette,
} from '../../../src/ink/theme';
import type { Theme } from './model/types';
/** Browser tokens are derived from Circle's existing palette, never a second color table. */
export function applyTheme(choice: Theme, uiSize = 13, codeSize = 13) {
  const dark =
    choice === 'auto'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : choice === 'dark';
  setPalette(buildPalette(...(dark ? DEFAULT_DARK : DEFAULT_LIGHT)));
  const p = palette();
  const rgb = (color: string) => `rgb(${hexToRgb(color).join(' ')})`;
  const values: Record<string, string> = {
    bg: p.bg_hex,
    fg: p.fg_hex,
    sidebar: mix(p.bg_hex, p.fg_hex, 0.035),
    surface: mix(p.bg_hex, p.fg_hex, 0.045),
    hover: mix(p.bg_hex, p.fg_hex, 0.085),
    active: mix(p.bg_hex, p.fg_hex, 0.12),
    border: mix(p.bg_hex, p.fg_hex, 0.15),
    secondary: mix(p.fg_hex, p.bg_hex, 0.22),
    muted: mix(p.fg_hex, p.bg_hex, 0.39),
    subtle: mix(p.bg_hex, p.fg_hex, 0.025),
    'read-bg': p.read_bg_hex,
    'write-bg': p.write_bg_hex,
    'think-bg': p.think_bg_hex,
    'agent-bg': p.agent_bg_hex,
  };
  const root = document.documentElement;
  for (const [key, value] of Object.entries(values))
    root.style.setProperty('--' + key, rgb(value));
  root.style.setProperty(
    '--accent',
    `rgb(${p.rainbow_stops[0]![1].join(' ')})`,
  );
  root.style.setProperty(
    '--negative',
    `rgb(${p.rainbow_stops[2]![1].join(' ')})`,
  );
  root.style.setProperty(
    '--logo-gradient',
    `conic-gradient(${p.rainbow_stops.map(([at, value]) => `rgb(${value.join(' ')}) ${at * 100}%`).join(',')})`,
  );
  root.style.setProperty(
    '--ui-size',
    Math.min(18, Math.max(11, uiSize)) + 'px',
  );
  root.style.setProperty(
    '--code-size',
    Math.min(20, Math.max(11, codeSize)) + 'px',
  );
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}
