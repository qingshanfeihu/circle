export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
}
export const BUILTIN_SLASH: SlashCommand[] = [
  { name: 'help', description: 'List slash commands' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  {
    name: 'login',
    description: 'Sign in or change the endpoint, key and model',
    aliases: ['connect'],
  },
  { name: 'logout', description: 'Clear saved credentials' },
  { name: 'init', description: 'Analyze repo and write AGENTS.md' },
  { name: 'trust', description: 'Trust this workspace' },
  { name: 'settings', description: 'Show current settings' },
  { name: 'themes', description: 'Show or set auto, dark, or light theme' },
  { name: 'mcp', description: 'List or reload MCP servers and tools' },
  {
    name: 'extensions',
    description: 'List or reload extensions',
    aliases: ['ext'],
  },
  { name: 'approvals', description: 'Session approval rules' },
  { name: 'new', description: 'Start a new session', aliases: ['clear'] },
  {
    name: 'resume',
    description: 'Choose a session to open',
    aliases: ['sessions'],
  },
  { name: 'continue', description: 'Resume previous session' },
  { name: 'name', description: 'Set session title' },
  { name: 'session', description: 'Show session facts' },
  { name: 'models', description: 'Choose a model', aliases: ['model'] },
  { name: 'compact', description: 'Summarize context', aliases: ['summarize'] },
  {
    name: 'plan',
    description: 'Toggle read-only mode',
    aliases: ['plan-mode'],
  },
  { name: 'skill', description: 'List or load a skill', aliases: ['skills'] },
  { name: 'tree', description: 'Go back to an earlier message' },
  { name: 'fork', description: 'New session before one of your messages' },
  { name: 'clone', description: 'Clone the active branch' },
  { name: 'undo', description: 'Hide last turn on screen' },
  { name: 'redo', description: 'Restore hidden turn' },
  { name: 'thinking', description: 'Show or hide thinking' },
  { name: 'effort', description: 'Choose thinking depth' },
  { name: 'details', description: 'Expand or collapse tools' },
  { name: 'copy', description: 'Copy last answer' },
  { name: 'export', description: 'Export as Markdown, HTML, or JSONL' },
  { name: 'import', description: 'Start a session from an export' },
  { name: 'share', description: 'Save local share copy' },
  { name: 'unshare', description: 'Delete local share copy' },
  { name: 'editor', description: 'Edit draft externally' },
  { name: 'reload', description: 'Reload settings and integrations' },
  { name: 'yolo', description: 'Enable auto mode', aliases: ['auto'] },
  { name: 'exit', description: 'Quit', aliases: ['quit', 'q'] },
];
export function parseSlash(
  text: string,
): { name: string; args: string } | undefined {
  const match = text.match(/^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const raw = match[1]!.toLowerCase();
  const command = BUILTIN_SLASH.find(
    (command) => command.name === raw || command.aliases?.includes(raw),
  );
  return { name: command?.name || raw, args: match[2] || '' };
}
