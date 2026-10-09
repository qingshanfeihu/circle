import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { circleHome } from './paths.js';
import { readJson, isRecord } from './settings.js';
export const ACTIONS: Record<string, string> = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  suspend: 'ctrl+z',
  'model.select': 'ctrl+l',
  'model.cycle': 'ctrl+p',
  'thinking.cycle': 'shift+tab',
  'thinking.toggle': 'ctrl+t',
  'tools.expand': 'ctrl+o',
  'editor.external': 'ctrl+g',
  'message.copy': 'ctrl+x',
  'message.dequeue': 'alt+up',
  'message.followup': 'ctrl+q',
  find: 'ctrl+f',
  'history.search': 'ctrl+r',
  'secret.enter': 'ctrl+s',
  'job.background': 'ctrl+b',
  newline: 'ctrl+j',
};
// Names development builds used before they matched the Python releases.
const ALIASES: Record<string, string> = {
  'command.background': 'job.background',
};
export function loadRemap(home = circleHome()): {
  remap: Record<string, string>;
  problems: string[];
} {
  const remap: Record<string, string> = {};
  const problems: string[] = [];
  const path = join(home, 'keybindings.json');
  if (!existsSync(path)) return { remap, problems };
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (error) {
    return {
      remap,
      problems: [`keybindings.json could not be read: ${error}`],
    };
  }
  if (!isRecord(raw))
    return {
      remap,
      problems: ['keybindings.json should be an object of action: key'],
    };
  for (const [action, value] of Object.entries(raw)) {
    const key = ACTIONS[ALIASES[action] ?? action];
    if (!key) {
      problems.push(`unknown action '${action}' in keybindings.json`);
      continue;
    }
    const keys = typeof value === 'string' ? [value] : value;
    if (
      !Array.isArray(keys) ||
      !keys.every((value) => typeof value === 'string' && value.trim())
    ) {
      problems.push(`${action}: give a key name or a list of them`);
      continue;
    }
    for (const pressed of keys as string[]) {
      const name = pressed.trim().toLowerCase();
      if (name !== key) remap[name] = key;
    }
  }
  return { remap, problems };
}
