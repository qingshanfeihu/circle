import { palette } from '../theme.js';
import { truncate } from '../string_width.js';
export function welcomeRows(
  width: number,
  info: {
    version: string;
    model: string;
    endpoint: string;
    workspace: string;
    branch: string;
    resources: string[];
    recent: string[];
  },
): string[] {
  const p = palette();
  const logo = [
    '  ▄▟████▙▄',
    '▗██▀    ▀██▖',
    '██▘      ▝██',
    '██▖      ▗██',
    '▝██▄    ▄██▘',
    '  ▀▜████▛▀',
  ];
  const facts = [
    `circle ${info.version}`,
    `${info.model} · ${info.endpoint}`,
    info.workspace + (info.branch ? ` (${info.branch})` : ''),
  ];
  const rows = logo.map(
    (line, index) =>
      '  ' +
      p.rainbow[index % p.rainbow.length] +
      line.padEnd(14) +
      p.reset +
      ' ' +
      p.text +
      truncate(facts[index] || '', Math.max(0, width - 19)) +
      p.reset,
  );
  rows.push(
    '',
    ...info.resources.map((text) => ' ' + p.green + '●' + p.reset + ' ' + text),
  );
  if (info.recent.length)
    rows.push(
      '',
      '   ' + p.faint + 'recent' + p.reset,
      ...info.recent
        .slice(0, 3)
        .map(
          (text) =>
            '   ' + p.dim + truncate(text, Math.max(1, width - 4)) + p.reset,
        ),
    );
  return rows;
}
