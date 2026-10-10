export const KEY_ACTIONS = {
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
  newline: 'ctrl+j',
  'job.background': 'ctrl+b',
} as const;
export type KeyAction = keyof typeof KEY_ACTIONS;
export function validateKeybindings(
  value: unknown,
): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('keybindings must be an object');
  for (const [action, keys] of Object.entries(value)) {
    if (!(action in KEY_ACTIONS)) throw Error('unknown key action: ' + action);
    if (!(
      typeof keys === 'string' ||
      (Array.isArray(keys) && keys.every((key) => typeof key === 'string'))
    ))
      throw Error('keys must be a string or list of strings');
    for (const key of typeof keys === 'string' ? [keys] : keys)
      if (
        !/^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|escape|up|down|left|right|enter|tab|backspace|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/.test(
          key,
        )
      )
        throw Error('invalid key: ' + key);
  }
  return value as Record<string, string | string[]>;
}
export function matchingAction(
  event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
  bindings: Record<string, string | string[]>,
): KeyAction | undefined {
  const key =
    (
      {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        Escape: 'escape',
      } as Record<string, string>
    )[event.key] ?? event.key.toLowerCase();
  const chord =
    (event.ctrlKey ? 'ctrl+' : '') +
    (event.altKey ? 'alt+' : '') +
    (event.shiftKey ? 'shift+' : '') +
    (event.metaKey ? 'meta+' : '') +
    key;
  for (const [action, keys] of Object.entries(bindings)) {
    if ((typeof keys === 'string' ? [keys] : keys).includes(chord))
      return action as KeyAction;
  }
  return undefined;
}
