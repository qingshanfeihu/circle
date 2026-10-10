import {
  BUILTIN_SLASH,
  closeMatch,
  commandWord,
  parseSlash,
} from '../../../../src/tui/slash_commands.ts';
import type {
  CommandResult,
  Effort,
  Message,
  RuntimePort,
  Session,
  WorkbenchSnapshot,
} from './types.ts';
import { createFixtures } from '../preview/fixtures.ts';
export const STORAGE_KEY = 'circle.workbench.preview.v1';
export const EFFORTS: Effort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
export const COMMAND_UI: Record<string, string> = {
  help: 'help',
  hotkeys: 'hotkeys',
  login: 'connect',
  logout: 'connect',
  init: 'request',
  trust: 'trust',
  settings: 'settings',
  themes: 'settings',
  mcp: 'mcp',
  extensions: 'extensions',
  approvals: 'approvals',
  jobs: 'activity',
  new: 'sessions',
  resume: 'sessions',
  continue: 'sessions',
  name: 'rename',
  session: 'session',
  models: 'models',
  compact: 'compact',
  plan: 'mode',
  skill: 'skills',
  tree: 'tree',
  fork: 'fork',
  clone: 'sessions',
  undo: 'transcript',
  redo: 'transcript',
  thinking: 'transcript',
  effort: 'models',
  details: 'transcript',
  copy: 'copy',
  export: 'export',
  import: 'import',
  share: 'export',
  unshare: 'export',
  editor: 'editor',
  reload: 'request',
  yolo: 'mode',
  exit: 'exit',
};
export function currentSession(snapshot: WorkbenchSnapshot): Session {
  return (
    snapshot.sessions.find(
      (session) => session.id === snapshot.activeSessionId,
    ) ?? snapshot.sessions[0]!
  );
}
export function branchMessages(session: Session): Message[] {
  const messages = new Map(
    session.messages.map((message) => [message.id, message]),
  );
  const result: Message[] = [];
  const seen = new Set<string>();
  let id = session.leafId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const message = messages.get(id);
    if (!message) break;
    result.unshift(message);
    id = message.parentId;
  }
  return result;
}
export function visibleMessages(session: Session) {
  return branchMessages(session).filter(
    (message) => !session.hiddenIds.includes(message.id),
  );
}
export function sessionText(session: Session) {
  return visibleMessages(session)
    .map(
      (message) =>
        `## ${message.role}\n\n${message.text}${message.tool ? '\n\n' + JSON.stringify({ input: message.tool.input, output: message.tool.output }, null, 2) : ''}`,
    )
    .join('\n\n');
}
function freshSession(
  snapshot: WorkbenchSnapshot,
  workspaceId: string,
): Session {
  return {
    id: crypto.randomUUID(),
    title: 'new session',
    workspaceId,
    model: snapshot.settings.defaultModel,
    effort: snapshot.settings.defaultEffort,
    draft: '',
    messages: [],
    leafId: null,
    hiddenIds: [],
    undoStack: [],
    attachments: [],
    queue: [],
    state: 'idle',
    readOnly: false,
    auto: false,
    showThinking: !snapshot.settings.hideThinking,
    expandTools: false,
    todos: [],
    pinned: false,
    shared: false,
    updatedAt: 'now',
  };
}
interface StoragePort {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}
/** A browser-only model for exercising UI behavior. It never runs the Circle runtime. */
export class PreviewRuntime implements RuntimePort {
  readonly mode = 'preview' as const;
  private snapshot: WorkbenchSnapshot;
  private listeners = new Set<() => void>();
  private storage?: StoragePort;
  constructor(storage?: StoragePort) {
    this.storage = storage;
    let value: WorkbenchSnapshot | undefined;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (
          data.version === 1 &&
          [
            'sessions',
            'workspaces',
            'files',
            'jobs',
            'agents',
            'interactions',
            'requests',
            'skills',
            'models',
            'mcp',
            'extensions',
            'commands',
            'approvalRules',
            'uiPlugins',
          ].every((key) => Array.isArray(data[key])) &&
          data.sessions.length &&
          data.settings
        )
          value = data;
      }
    } catch {
      /* Fall back to isolated sample data. */
    }
    this.snapshot = value ?? createFixtures();
    for (const session of this.snapshot.sessions) {
      session.auto = false;
      session.hiddenIds = [];
      session.undoStack = [];
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  change = (update: (draft: WorkbenchSnapshot) => void) => {
    const next = structuredClone(this.snapshot);
    update(next);
    this.snapshot = next;
    let storageError = false;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      storageError = true;
    }
    for (const listener of this.listeners) listener();
    if (storageError)
      throw Error('local storage is full; changes are only kept in this tab');
  };
  newSession = (workspaceId = currentSession(this.snapshot).workspaceId) => {
    const session = freshSession(this.snapshot, workspaceId);
    this.change((state) => {
      state.previousSessionId = state.activeSessionId;
      state.activeSessionId = session.id;
      state.sessions.unshift(session);
    });
    return session.id;
  };
  selectSession = (id: string) => {
    if (id === this.snapshot.activeSessionId) return;
    if (!this.snapshot.sessions.some((session) => session.id === id))
      throw Error('session not found');
    this.change((state) => {
      state.previousSessionId = state.activeSessionId;
      state.activeSessionId = id;
    });
  };
  deleteSession = (id: string) => {
    if (id === this.snapshot.activeSessionId)
      throw Error('the open session cannot be deleted');
    this.change((state) => {
      state.sessions = state.sessions.filter((session) => session.id !== id);
      if (state.previousSessionId === id) state.previousSessionId = null;
    });
  };
  request = (kind: string, payload: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    this.change((state) => {
      state.requests.unshift({
        id,
        kind,
        sessionId: state.activeSessionId,
        payload: structuredClone(payload),
        at: new Date().toISOString(),
        status: 'not sent',
      });
      if (kind === 'stop-job') {
        const job = state.jobs.find((item) => item.id === payload.id);
        if (job) job.stopRequested = true;
      }
    });
    return id;
  };
  send = (kind: 'steering' | 'follow-up' = 'steering'): CommandResult => {
    const session = currentSession(this.snapshot);
    const text = session.draft;
    if (!text.trim()) return {};
    const word = commandWord(text);
    if (word) {
      const parsed = parseSlash(
        text,
        new Set(this.snapshot.commands.map((item) => item.name)),
      );
      if (!parsed) {
        const hint = closeMatch(
          word,
          BUILTIN_SLASH.map((item) => item.name),
        );
        return {
          notice: `unknown command /${word}${hint ? `; did you mean /${hint}?` : ''}`,
        };
      }
      this.change((state) => {
        currentSession(state).draft = '';
      });
      return this.command(parsed.name, parsed.args);
    }
    if (text === '/') return { page: 'help' };
    if (text.startsWith('!')) {
      this.request('execute', { command: text.slice(1) });
      this.change((state) => {
        currentSession(state).draft = '';
      });
      return { notice: 'shell request recorded; no command was executed' };
    }
    const workspace = this.snapshot.workspaces.find(
      (item) => item.id === session.workspaceId,
    );
    if (!workspace?.trusted) return { dialog: 'trust' };
    this.change((state) => {
      const target = currentSession(state);
      if (target.state === 'waiting') {
        target.queue.push({ id: crypto.randomUUID(), text, kind });
      } else {
        const message: Message = {
          id: crypto.randomUUID(),
          parentId: target.leafId,
          role: 'user',
          text,
          at: new Date().toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          attachments: structuredClone(target.attachments),
        };
        target.messages.push(message);
        target.leafId = message.id;
        target.hiddenIds = [];
        if (target.title === 'new session')
          target.title = text.split('\n')[0]!.slice(0, 60);
        target.state = 'waiting';
      }
      target.draft = '';
      target.updatedAt = 'now';
    });
    return {
      notice:
        session.state === 'waiting'
          ? `${kind} saved locally; runtime not connected`
          : 'message saved; runtime not connected',
    };
  };
  branch = (messageId: string, kind: 'tree' | 'fork') => {
    const session = currentSession(this.snapshot);
    const message = session.messages.find((item) => item.id === messageId);
    if (!message) throw Error('message not found');
    if (kind === 'fork' && message.role !== 'user')
      throw Error('choose a user message to fork');
    if (kind === 'tree') {
      this.change((state) => {
        const target = currentSession(state);
        target.leafId = messageId;
        target.hiddenIds = [];
        target.undoStack = [];
        target.state = 'paused';
      });
      this.request('select-branch', { messageId });
    } else {
      const path = branchMessages({ ...session, leafId: message.parentId });
      const next = freshSession(this.snapshot, session.workspaceId);
      Object.assign(next, {
        title: `fork · ${session.title}`,
        messages: structuredClone(path),
        leafId: path.at(-1)?.id ?? null,
        draft: message.text,
        attachments: structuredClone(session.attachments),
        model: session.model,
        effort: session.effort,
      });
      this.change((state) => {
        state.previousSessionId = state.activeSessionId;
        state.activeSessionId = next.id;
        state.sessions.unshift(next);
      });
    }
  };
  answer = (id: string, revision: number, answer: string) => {
    const item = this.snapshot.interactions.find(
      (interaction) => interaction.id === id,
    );
    if (!item || item.revision !== revision || item.status !== 'pending')
      throw Error('this request has changed or was already answered');
    const safeAnswer =
      item.kind === 'secret' ? 'secret input discarded by preview' : answer;
    this.change((state) => {
      const interaction = state.interactions.find(
        (candidate) => candidate.id === id,
      )!;
      interaction.status = 'recorded';
      interaction.decision = safeAnswer;
      if (answer === 'allow for this session' && item.kind === 'approval')
        state.approvalRules.push({
          id: crypto.randomUUID(),
          sessionId: item.sessionId,
          kind: 'command',
          description: item.command ?? item.tool ?? item.title,
        });
    });
    this.request('interaction-response', {
      requestId: id,
      revision,
      answer: safeAnswer,
    });
  };
  command = (rawName: string, args = ''): CommandResult => {
    const parsed = parseSlash('/' + rawName);
    const name = parsed?.name ?? rawName;
    const session = currentSession(this.snapshot);
    const busy = session.state === 'waiting';
    const waitCommands = new Set([
      'new',
      'continue',
      'clone',
      'fork',
      'compact',
      'models',
      'effort',
      'reload',
      'init',
    ]);
    if (
      busy &&
      (waitCommands.has(name) ||
        (name === 'skill' && !!args) ||
        (['mcp', 'extensions'].includes(name) && args === 'reload'))
    )
      return {
        notice: 'wait for the current turn, or pause the local conversation',
      };
    const dialogs: Record<string, CommandResult['dialog']> = {
      hotkeys: 'hotkeys',
      login: 'connect',
      name: 'rename',
      session: 'session',
      compact: 'compact',
      tree: 'tree',
      fork: 'fork',
      export: 'export',
      share: 'export',
      editor: 'editor',
      trust: 'trust',
      exit: 'exit',
    };
    if (name === 'new') {
      this.newSession();
      return { openSession: true };
    }
    if (name === 'resume') {
      const sessions = this.snapshot.sessions;
      const found = args
        ? /^\d+$/.test(args)
          ? sessions[Number(args) - 1]
          : sessions.find((item) => item.id.endsWith(args))
        : undefined;
      if (found) {
        this.selectSession(found.id);
        return { openSession: true };
      }
      return {
        page: 'sessions',
        notice: args ? 'session not found' : undefined,
      };
    }
    if (name === 'continue') {
      if (this.snapshot.previousSessionId)
        this.selectSession(this.snapshot.previousSessionId);
      return { openSession: true };
    }
    if (name === 'clone') {
      const next = freshSession(this.snapshot, session.workspaceId);
      Object.assign(next, {
        title: `copy · ${session.title}`,
        messages: structuredClone(branchMessages(session)),
        leafId: session.leafId,
        attachments: structuredClone(session.attachments),
        model: session.model,
        effort: session.effort,
      });
      this.change((state) => {
        state.previousSessionId = state.activeSessionId;
        state.activeSessionId = next.id;
        state.sessions.unshift(next);
      });
      return { openSession: true };
    }
    if (name === 'name' && args.trim()) {
      this.change((state) => {
        currentSession(state).title = args.trim().slice(0, 100);
      });
      return { notice: 'session renamed' };
    }
    if (name === 'undo') {
      this.change((state) => {
        const target = currentSession(state);
        const visible = visibleMessages(target);
        const lastUser = visible.findLastIndex(
          (message) => message.role === 'user',
        );
        if (lastUser >= 0) {
          target.undoStack.push([...target.hiddenIds]);
          target.hiddenIds.push(
            ...visible.slice(lastUser).map((message) => message.id),
          );
        }
      });
      return { notice: 'last turn hidden; history and files are unchanged' };
    }
    if (name === 'redo') {
      if (!session.undoStack.length) return { notice: 'nothing to redo' };
      this.change((state) => {
        const target = currentSession(state);
        const previous = target.undoStack.pop();
        if (previous) target.hiddenIds = previous;
      });
      return { notice: 'transcript restored' };
    }
    if (name === 'plan') {
      this.change((state) => {
        const target = currentSession(state);
        target.readOnly =
          args === 'on' ? true : args === 'off' ? false : !target.readOnly;
      });
      this.request('set-plan-mode', {
        enabled: currentSession(this.snapshot).readOnly,
      });
      return { notice: 'preview mode changed; runtime not connected' };
    }
    if (name === 'yolo') {
      this.change((state) => {
        currentSession(state).auto = args !== 'off';
      });
      return { notice: 'auto applies only to this preview session' };
    }
    if (name === 'thinking' && !args) {
      this.change((state) => {
        currentSession(state).showThinking =
          !currentSession(state).showThinking;
      });
      return {};
    }
    if ((name === 'effort' || name === 'thinking') && args) {
      if (!EFFORTS.includes(args as Effort))
        return { notice: 'choose minimal, low, medium, high, xhigh or max' };
      this.change((state) => {
        currentSession(state).effort = args as Effort;
      });
      return { notice: `thinking depth · ${args}` };
    }
    if (name === 'details') {
      this.change((state) => {
        currentSession(state).expandTools = !currentSession(state).expandTools;
      });
      return {};
    }
    if (name === 'models' && args) {
      this.change((state) => {
        currentSession(state).model = args;
      });
      return { notice: `model · ${args}` };
    }
    if (name === 'themes' && args) {
      if (!['auto', 'dark', 'light'].includes(args))
        return { notice: 'choose auto, dark or light' };
      this.change((state) => {
        state.settings.theme = args as 'auto' | 'dark' | 'light';
      });
      return {};
    }
    if (name === 'skill' && args) {
      const [skillName] = args.split(/\s/);
      const skill = this.snapshot.skills.find(
        (item) => item.name === skillName,
      );
      if (!skill) return { notice: 'skill not found' };
      this.change((state) => {
        const target = currentSession(state);
        if (
          !target.attachments.some((attachment) => attachment.id === skill.id)
        )
          target.attachments.push({
            id: skill.id,
            name: skill.name,
            kind: 'skill',
            content: skill.content,
          });
      });
      return { notice: 'skill added to the next message context' };
    }
    if (name === 'approvals' && args.startsWith('revoke ')) {
      const rules = this.snapshot.approvalRules.filter(
        (rule) => rule.sessionId === session.id,
      );
      const rule = rules[Number(args.slice(7)) - 1];
      if (rule)
        this.change((state) => {
          state.approvalRules = state.approvalRules.filter(
            (item) => item.id !== rule.id,
          );
        });
      return {
        page: 'approvals',
        notice: rule ? 'preview rule revoked' : 'rule not found',
      };
    }
    if (name === 'copy') return { effect: 'copy' };
    if (name === 'import') return { effect: 'import' };
    if (name === 'unshare') {
      this.change((state) => {
        currentSession(state).shared = false;
      });
      return { notice: 'preview share removed; no upload was made' };
    }
    if (name === 'logout') {
      this.change((state) => {
        state.settings.endpoint = '';
      });
      this.request('logout');
      return {
        dialog: 'connect',
        notice: 'connection draft cleared; real credentials were not accessed',
      };
    }
    if (name === 'jobs') return { panel: 'activity', selection: args };
    if (
      ['reload', 'init'].includes(name) ||
      (['mcp', 'extensions'].includes(name) && args === 'reload')
    ) {
      this.request(name, { args });
      return { notice: 'request recorded; runtime not connected' };
    }
    if (dialogs[name])
      return { dialog: dialogs[name], selection: args || undefined };
    const pages: Record<string, CommandResult['page']> = {
      help: 'help',
      settings: 'settings',
      themes: 'settings',
      mcp: 'mcp',
      extensions: 'extensions',
      approvals: 'approvals',
      models: 'models',
      effort: 'models',
      skill: 'skills',
    };
    if (pages[name]) return { page: pages[name] };
    const custom = this.snapshot.commands.find((item) => item.name === name);
    if (custom) {
      this.request('custom-command', { name, args, template: custom.template });
      return {
        notice: 'command saved as a request; shell snippets were not executed',
      };
    }
    return { notice: `unknown command /${name}` };
  };
  reset = () => {
    this.snapshot = createFixtures();
    this.storage?.removeItem(STORAGE_KEY);
    for (const listener of this.listeners) listener();
  };
}
