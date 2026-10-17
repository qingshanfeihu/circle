import { CommandTerminalNavigation } from '../components/CommandTerminalNavigation';
import type {
  CommandTerminalResolution,
  CommandTerminalResolveRequest,
} from '../command-terminal-target';
import {
  commandTerminalUnavailable,
  type CommandTerminalView,
} from '../model/command-terminal-client';
import {
  desktopHost,
  copyText,
  folderOpenMessage,
  nativeAttachment,
  openNativeWorkspace,
  readNativeFile,
} from '../host';
import { parsePreviewBundle } from '../model/transfer';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { DropdownMenu, Tooltip } from 'radix-ui';
import {
  Folder,
  GitBranch,
  PanelLeft,
  PanelRight,
  Terminal,
  Search,
  ChevronRight,
  ArrowUpRight,
  Sun,
  Moon,
  X,
  ChevronLeft,
  Users,
  FileText,
  Command,
  ChevronDown,
  MoreHorizontal,
} from 'lucide-react';
import { useRuntime } from './context';
import { currentSession, sessionText, sessionTitle } from '../model/state';
import {
  historyMessages,
  taskWorkspaceIds,
  visibleSessions,
} from '../model/session-management';
import { workspaceLabel } from '../model/workspace-label';
import type {
  Attachment,
  DialogId,
  Interaction,
  PageId,
  PanelId,
} from '../model/types';
import { Sidebar, NAVIGATION } from '../components/Sidebar';
import {
  Button,
  IconButton,
  Modal,
  SearchInput,
  Status,
  Facts,
  DataBlock,
  EmptyState,
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolMessage } from '../components/ToolMessage';
import { Conversation } from '../features/Conversation';
import { Home } from '../features/Home';
import { homePath, openHome, startPath } from '../features/home-selection';
import '../styles/developer-workbench.css';
import '../styles/panes.css';
import {
  sourceLocation,
  workspaceRelativePath,
} from '../model/source-navigation';
import { SourceOpenCoordinator } from '../model/source-open';
import {
  connectWorkspaceStreams,
  workspaceCall,
} from '../model/workspace-client';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { SourceNavigation } from '../components/SourceNavigation';
import { agentState } from '../model/activity';
import {
  agentSourceOwner,
  type SourceResourceOwner,
} from '../model/source-resource-owner';
import { Inspector, PanelButtons } from '../features/Panels';
const FileViewer = lazy(() =>
  import('../features/FileViewer').then((module) => ({
    default: module.FileViewer,
  })),
);
import { ManagementPage } from '../features/Pages';
import { DialogHost, InteractionDialog } from '../features/Dialogs';
import { applyTheme } from '../theme';
import { t } from '../i18n';
import { platformTitle, shellPageTitle } from '../plugins/labels';
import { isSessionBrowser } from '../model/browser';
import { armComposerFocus, sealComposerFocus } from '../model/composer-focus';
import {
  effectiveBindings,
  DESKTOP_SEARCH_CHORD,
  DESKTOP_SETTINGS_CHORD,
  formatChord,
  isDesktopNewSession,
  isDesktopSearch,
  isDesktopSettings,
  matchingAction,
} from '../model/shortcuts';
function useNarrow() {
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia('(max-width: 1050px)');
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => matchMedia('(max-width: 1050px)').matches,
  );
}
export function App() {
  const { snapshot, runtime, perform, notify, notice, setRouter, act } =
    useRuntime();
  const navigate = useNavigate();
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const location = useLocation();
  const session = currentSession(snapshot);
  useEffect(
    () =>
      runtime.mode === 'live' && snapshot.runtime?.connected
        ? connectWorkspaceStreams(session.workspaceId, session.id, (error) =>
            notify(String(error)),
          )
        : undefined,
    [runtime, session.id, session.workspaceId, snapshot.runtime?.connected],
  );
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const narrow = useNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = () => {
    if (narrow) setSidebarOpen((open) => !open);
    else setSidebarCollapsed((closed) => !closed);
  };
  // Closed at first, as Claude's side panel; the top bar's icons open it.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (narrow) setInspectorOpen(false);
  }, [narrow]);
  const [panel, setPanel] = useState<PanelId>('files');
  // A panel the person wants to see whole, for as long as they want it there.
  const [fullView, setFullView] = useState(false);
  const [selection, setSelection] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [fileOwner, setFileOwner] = useState<SourceResourceOwner>();
  const sourceOpener = useRef(
    new SourceOpenCoordinator(() => runtime.getSnapshot().activeSessionId),
  );
  const [sourceLine, setSourceLine] = useState<number | undefined>();
  const [sourceColumn, setSourceColumn] = useState<number | undefined>();
  const [debugSourceRequest, setDebugSourceRequest] = useState<{
    id: string;
    sessionId: string;
    path: string;
    line?: number;
  }>();
  const [quickOpen, setQuickOpen] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [commandTerminal, setCommandTerminal] = useState<CommandTerminalView>();
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    id: string;
    epoch: string;
    requestId: string;
    sessionId: string;
  }>();
  const commandRequest = useRef(0);
  const commandReturnFocus = useRef<
    { origin: string; trigger: HTMLElement } | undefined
  >(undefined);
  const commandOrigin = useRef('');
  commandOrigin.current = JSON.stringify([
    session.id,
    agent,
    location.pathname,
    file,
  ]);
  useEffect(() => {
    commandRequest.current++;
    setCommandTerminal(undefined);
  }, [session.id, agent]);
  const openOriginalCommandTerminal = async (
    source: CommandTerminalResolveRequest,
    trigger?: HTMLElement,
  ) => {
    const request = ++commandRequest.current;
    const origin = commandOrigin.current;
    const viewSessionId = session.id;
    let reply: CommandTerminalResolution;
    try {
      reply = await workspaceCall<CommandTerminalResolution>(
        viewSessionId,
        'terminal',
        'resolveCommand',
        source,
      );
    } catch {
      if (
        request !== commandRequest.current ||
        origin !== commandOrigin.current
      )
        return;
      throw Error(t('command terminal could not be opened; try again'));
    }
    if (request !== commandRequest.current || origin !== commandOrigin.current)
      return;
    if (!reply.available) throw Error(commandTerminalUnavailable(reply.reason));
    if (
      reply.target.executionSessionId !== source.sourceSessionId ||
      (source.userShellId !== undefined
        ? reply.target.origin !== 'user-shell' ||
          reply.target.userShellId !== source.userShellId
        : reply.target.origin !== undefined ||
          reply.target.toolCallId !== source.toolCallId)
    )
      throw Error(t('command terminal source changed; open it again'));
    commandReturnFocus.current = trigger ? { origin, trigger } : undefined;
    setCommandTerminal({ viewSessionId, requestId: request, resolved: reply });
    setPanel('terminal');
    setSelection('');
    setInspectorOpen(true);
  };
  const openCommandTerminal = (
    sourceSessionId: string,
    toolCallId: string,
    trigger?: HTMLElement,
  ) => openOriginalCommandTerminal({ sourceSessionId, toolCallId }, trigger);
  const openUserShellTerminal = (
    sourceSessionId: string,
    userShellId: string,
    trigger?: HTMLElement,
  ) => openOriginalCommandTerminal({ sourceSessionId, userShellId }, trigger);

  const selectAgent = (id: string | null) => {
    commandRequest.current++;
    sourceOpener.current.cancel();
    setFile(null);
    setFileOwner(undefined);
    setAgent(id);
    if (narrow) setInspectorOpen(false);
  };
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [dialogSelection, setDialogSelection] = useState('');
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const restoreSearchFocus = useRef(false);
  const [finding, setFinding] = useState(false);
  const [search, setSearch] = useState('');
  const [searchCursor, setSearchCursor] = useState(0);
  useEffect(() => setSearchCursor(0), [search, searchOpen, quickOpen]);
  const page = location.pathname.startsWith('/page/')
    ? (location.pathname.slice(6) as PageId)
    : null;
  // The first route, `/`, already shows the view it is about to become. Its
  // redirect then keeps that same view, and so whatever was typed into it.
  const home =
    location.pathname === '/home' ||
    (location.pathname === '/' && startPath(snapshot) === homePath());
  const homeQuery = new URLSearchParams(location.search);
  // No query keeps the current project. An empty value is "work without a project".
  const homeRequested = homeQuery.has('workspace')
    ? (homeQuery.get('workspace') ?? '')
    : null;
  const inspectorVisible = inspectorOpen && !page;
  // Only a panel worth the whole workspace offers it: the browser's page and the shell,
  // plus any component that says so on its own panel.
  const canBeWhole =
    !narrow &&
    (panel === 'terminal' ||
      registry
        .active(enabled)
        .flatMap((plugin) => plugin.panels ?? [])
        .some((item) => item.id === panel && item.fullView));
  const whole = inspectorVisible && canBeWhole && fullView;
  // A panel that cannot fill the workspace, or a panel that is gone, ends the view.
  useEffect(() => {
    if (!canBeWhole || !inspectorVisible) setFullView(false);
  }, [canBeWhole, inspectorVisible]);
  // The view takes the focus when it opens, so Escape is one keystroke away, and the way
  // out is always in its own header as well.
  const wholeBox = useRef<HTMLDivElement>(null);
  const splitInspectorBox = useRef<HTMLDivElement>(null);
  // One original resource host moves between the split and the full-view surface.
  // The portal target stays identical, so native sessions and panel drafts stay mounted.
  const [inspectorHost] = useState(() => {
    const host = document.createElement('div');
    host.className = 'inspector-resource-host';
    return host;
  });
  useLayoutEffect(() => {
    const destination = whole ? wholeBox.current : splitInspectorBox.current;
    if (destination && inspectorHost.parentElement !== destination)
      destination.appendChild(inspectorHost);
  }, [whole, inspectorHost]);
  useEffect(() => () => inspectorHost.remove(), [inspectorHost]);
  useEffect(() => {
    if (whole) wholeBox.current?.focus();
  }, [whole]);
  // Escape leaves the full view from anywhere in the window. The panel's own
  // handler only hears keys while the panel itself is focused.
  useEffect(() => {
    if (!whole) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      // A dialog or a menu takes Escape itself, and so do the browser's address and
      // find fields
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (
        event.target instanceof Element &&
        event.target.closest('.native-browser input')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setFullView(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [whole]);
  const sessionSelection = useRef({ revision: 0, pending: Promise.resolve() });
  const selectSessionAndNavigate = (id: string) => {
    const revision = ++sessionSelection.current.revision;
    // A page opened meanwhile, such as settings, also supersedes it. The
    // address changes before the router renders that page.
    const address = window.location.href;
    // A session switch can load trusted configuration asynchronously. Preserve user
    // selection order and let only the latest request choose the visible route.
    const pending = sessionSelection.current.pending
      .catch(() => {})
      .then(async () => {
        if (revision !== sessionSelection.current.revision) return;
        try {
          await runtime.selectSession(id);
        } catch (error) {
          if (revision === sessionSelection.current.revision) throw error;
          return;
        }
        if (
          revision !== sessionSelection.current.revision ||
          window.location.href !== address ||
          runtime.getSnapshot().activeSessionId !== id
        )
          return;
        sourceOpener.current.cancel();
        setFile(null);
        setFileOwner(undefined);
        setAgent(null);
        navigate(`/session/${id}`);
      });
    sessionSelection.current.pending = pending;
    return pending;
  };
  const onSession = (focusComposer = false) => {
    sourceOpener.current.cancel();
    setFile(null);
    setFileOwner(undefined);
    setAgent(null);
    navigate(
      `/session/${runtime.getSnapshot().activeSessionId}`,
      focusComposer
        ? { state: { focusComposer: performance.now() } }
        : undefined,
    );
  };
  // The first time, before anything is set up, the connection form opens by itself.
  useEffect(() => {
    if (runtime.mode === 'live' && snapshot.runtime?.configured === false)
      onDialog('connect');
  }, []);
  const onDialog = (kind: DialogId, choice = '') => {
    setDialogSelection(choice);
    setDialog(kind);
  };
  // A secret belongs to one session. Open it only in the live app, and only
  // while that session is the one on screen. The preview's sample request,
  // and a request for a session the home page is not showing, stay closed.
  const viewedSessionId = location.pathname.startsWith('/session/')
    ? location.pathname.slice(9)
    : undefined;
  const pendingSecret = snapshot.interactions.find(
    (item) =>
      runtime.mode === 'live' &&
      item.kind === 'secret' &&
      item.status === 'pending' &&
      item.sessionId === viewedSessionId,
  );
  useEffect(() => {
    if (pendingSecret) onDialog('secret');
  }, [pendingSecret?.id]);
  const onPanel = (kind: PanelId, choice = '') => {
    setPanel(kind);
    setSelection(choice);
    setInspectorOpen(true);
  };
  // When Circle starts using this conversation's browser, its panel opens so the person
  // sees it work: once per start, and never by taking the person away from another page.
  // A narrow window lays the panel over the conversation, where Circle's cards and the
  // input box are: there it stays closed until the person opens it.
  const browserOperating = useRef(false);
  const onPage = location.pathname.startsWith('/page/');
  useEffect(() => {
    const host = desktopHost();
    if (!host) return;
    browserOperating.current = false;
    const show = (state: Awaited<ReturnType<typeof host.browserState>>) => {
      if (!isSessionBrowser(state, session.id)) return;
      const started = !!state.operating && !browserOperating.current;
      browserOperating.current = !!state.operating;
      if (started && !onPage && !narrow) {
        setPanel('browser');
        setInspectorOpen(true);
      }
    };
    return host.onBrowserEvent(show);
  }, [session.id, onPage, narrow]);
  const openSource = async (
    path: string,
    line?: number,
    column?: number,
    sourceOwner?: SourceResourceOwner,
  ) => {
    commandRequest.current++;
    const sourceSessionId = session.id;
    const result = await sourceOpener.current.open(
      sourceSessionId,
      async () => {
        const target = /^file:/i.test(path) ? sourceLocation(path) : null;
        if (/^file:/i.test(path) && !target)
          throw Error('unsupported source path');
        let requested = target?.path ?? path;
        if (/^\/[A-Za-z]:[\\/]/.test(requested)) requested = requested.slice(1);
        const relative =
          runtime.mode === 'live'
            ? (
                await workspaceCall<{ path: string }>(
                  sourceOwner?.sessionId ?? sourceSessionId,
                  'documents',
                  'resolveSource',
                  { path: requested },
                )
              ).path
            : workspaceRelativePath(
                requested,
                snapshot.workspaces.find(
                  (item) =>
                    item.id ===
                    (sourceOwner?.workspaceId ?? session.workspaceId),
                )?.path ?? '',
              );
        if (runtime.mode !== 'live') await readNativeFile(runtime, relative);
        return {
          path: relative.replaceAll('\\', '/'),
          line: line ?? target?.line,
          column: column ?? target?.column,
        };
      },
    );
    if (result.status === 'superseded') return;
    if (result.status === 'failed') {
      const error = result.error;
      notify(
        error instanceof Error
          ? error.message === 'source is outside the workspace' ||
            error.message === 'source is outside the granted workspace'
            ? t('source is outside the workspace')
            : error.message === 'unsupported source path'
              ? t('unsupported source path')
              : error.message
          : t('file could not be opened'),
      );
      return;
    }
    setFileOwner(sourceOwner ?? undefined);
    setFile(result.source.path);
    setSourceLine(result.source.line);
    setSourceColumn(result.source.column);
    if (narrow) setInspectorOpen(false);
    navigate(`/session/${sourceSessionId}`);
  };

  const onFile = (path: string, line?: number, column?: number) =>
    openSource(path, line, column);
  const onAgentFile = (path: string, line?: number, column?: number) => {
    const origin = snapshot.agents.find(
      (item) => item.id === agent && item.sessionId === session.id,
    );
    const owner = origin && agentSourceOwner(origin);
    if (!owner) {
      notify(t('source workspace is not available'));
      return;
    }
    return openSource(path, line, column, owner);
  };
  const onSessionRoute = () =>
    navigate(`/session/${runtime.getSnapshot().activeSessionId}`);
  // A link an extension asked to open (api.openUrl): the browser panel opens it, once.
  const openedLink = useRef(snapshot.openUrl?.id);
  useEffect(() => {
    const request = snapshot.openUrl;
    if (
      !request ||
      request.id === openedLink.current ||
      request.sessionId !== session.id
    )
      return;
    openedLink.current = request.id;
    if (desktopHost() && enabled.includes('browser')) {
      // The browser panel sits beside the session: show the session, then the panel.
      onSessionRoute();
      onPanel('browser', request.url);
    }
    // Without the panel, the window's own handler hands it to the system browser.
    else window.open(request.url, '_blank', 'noopener');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.openUrl?.id, session.id]);
  useEffect(() => {
    if (location.pathname === '/') {
      navigate(startPath(snapshot), { replace: true });
      return;
    }
    if (location.pathname === '/home') {
      sourceOpener.current.cancel();
      setFile(null);
      setFileOwner(undefined);
      setAgent(null);
      return;
    }
    const id = location.pathname.startsWith('/session/')
      ? location.pathname.slice(9)
      : undefined;
    if (id && id !== session.id) {
      if (snapshot.sessions.some((item) => item.id === id))
        perform(() => runtime.selectSession(id));
      else navigate(`/session/${session.id}`, { replace: true });
    }
  }, [location.pathname]);
  useEffect(() => {
    sourceOpener.current.cancel();
    setFile(null);
    setFileOwner(undefined);
    setAgent(null);
    const id = location.pathname.startsWith('/session/')
      ? location.pathname.slice(9)
      : undefined;
    if (id && !snapshot.sessions.some((item) => item.id === id))
      navigate(`/session/${session.id}`, { replace: true });
  }, [session.id]);
  useEffect(() => {
    const apply = () => {
      applyTheme(snapshot.settings.theme, snapshot.settings.textSize);
      // The browser's own pages (a certificate warning) and its pointer use these colours
      void desktopHost()
        ?.setTheme(document.documentElement.dataset.theme === 'dark')
        .catch(() => {});
    };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [snapshot.settings.theme, snapshot.settings.textSize]);
  const pickFiles = async (
    importing = false,
    into?: (attachment: Attachment) => void,
  ) => {
    const originSessionId = runtime.getSnapshot().activeSessionId;
    if (desktopHost()) {
      try {
        const files = await desktopHost()!.chooseFiles(
          importing ? 'import' : 'attach',
        );
        for (const item of files) {
          if (importing) {
            if (runtime.mode === 'live') {
              await runtime.request(
                'import-native-session',
                {
                  content: item.content,
                },
                originSessionId,
              );
              onSession();
              continue;
            }
            if (item.name.endsWith('.json')) {
              const value = JSON.parse(item.content);
              if (value.schema === 'circle-workbench-preview/v1') {
                const imported = parsePreviewBundle(
                  item.content,
                  currentSession(runtime.getSnapshot()),
                );
                const id = await runtime.newSession();
                runtime.change((state) => {
                  const index = state.sessions.findIndex(
                    (session) => session.id === id,
                  );
                  state.sessions[index] = { ...imported, id };
                });
                onSession();
                continue;
              }
            }
            const id = await runtime.newSession();
            runtime.change((state) => {
              const target = currentSession(state);
              target.title = item.name;
              const messageId = crypto.randomUUID();
              target.messages = [
                {
                  id: messageId,
                  parentId: null,
                  role: 'user',
                  text: item.content,
                  at: 'imported',
                },
              ];
              target.leafId = messageId;
            });
            onSession();
          } else if (into) into(nativeAttachment(item));
          else {
            const target = runtime
              .getSnapshot()
              .sessions.find((session) => session.id === originSessionId);
            if (target && target.lifecycle !== 'deleting')
              runtime.updateSessionView(originSessionId, {
                attachments: [...target.attachments, nativeAttachment(item)],
              });
          }
        }
      } catch (error) {
        if (!into && runtime.getSnapshot().activeSessionId !== originSessionId)
          return;
        notify(
          error instanceof Error
            ? error.message
            : t('native file selection failed'),
        );
      }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !importing;
    input.accept = importing
      ? '.json,.jsonl,.md,.txt'
      : '.txt,.md,.ts,.tsx,.js,.json,.jsonl,.py,.log,.csv,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.pdf';
    input.onchange = async () => {
      try {
        for (const item of Array.from(input.files ?? [])) {
          if (item.size > 4_000_000) {
            notify('file exceeds the 4 MB preview limit');
            continue;
          }
          if (importing) {
            const text = await item.text();
            if (runtime.mode === 'live') {
              await runtime.request(
                'import-native-session',
                { content: text },
                originSessionId,
              );
              onSession();
              continue;
            }
            if (item.name.endsWith('.json')) {
              const value = JSON.parse(text);
              if (
                value.schema === 'circle-workbench-preview/v1' &&
                value.session?.messages?.length < 10000 &&
                Array.isArray(value.session.messages) &&
                Array.isArray(value.session.attachments)
              ) {
                const imported = parsePreviewBundle(
                  text,
                  currentSession(runtime.getSnapshot()),
                );
                const id = await runtime.newSession();
                runtime.change((state) => {
                  const index = state.sessions.findIndex(
                    (value) => value.id === id,
                  );
                  state.sessions[index] = { ...imported, id };
                });
                onSession();
                continue;
              }
            }
            const id = await runtime.newSession();
            runtime.change((state) => {
              const target = currentSession(state);
              target.title = item.name;
              const messageId = crypto.randomUUID();
              target.messages = [
                {
                  id: messageId,
                  parentId: null,
                  role: 'user',
                  text,
                  at: 'imported',
                },
              ];
              target.leafId = messageId;
            });
            if (item.name.endsWith('.jsonl'))
              runtime.request('import-native-session', { name: item.name });
            onSession();
            notify('file imported into local preview; no runtime was started');
            continue;
          }
          let kind: Attachment['kind'] = 'file';
          let content = '';
          if (/^image\/(png|jpeg|gif|webp)$/.test(item.type)) {
            kind = 'image';
            content = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(Error(t('file could not be read')));
              reader.readAsDataURL(item);
            });
          } else if (item.type === 'application/pdf') {
            kind = 'document';
            content =
              'PDF attachment metadata saved; binary delivery needs a runtime.';
          } else content = await item.slice(0, 256000).text();
          const attachment: Attachment = {
            id: crypto.randomUUID(),
            name: item.name,
            kind,
            content,
            mime: item.type,
            size: item.size,
            truncated: kind === 'file' && item.size > 256000,
          };
          if (into) into(attachment);
          else {
            const target = runtime
              .getSnapshot()
              .sessions.find((session) => session.id === originSessionId);
            if (target && target.lifecycle !== 'deleting')
              runtime.updateSessionView(originSessionId, {
                attachments: [...target.attachments, attachment],
              });
          }
        }
      } catch (error) {
        if (!into && runtime.getSnapshot().activeSessionId !== originSessionId)
          return;
        notify(
          error instanceof Error
            ? error.message
            : t('file could not be imported'),
        );
      }
    };
    input.click();
  };
  setRouter((result) => {
    if (result.openSession) onSession(result.focusComposer);
    if (result.focusComposer) sealComposerFocus();
    if (result.page) navigate('/page/' + result.page);
    if (result.dialog) onDialog(result.dialog, result.selection);
    if (result.panel) onPanel(result.panel, result.selection);
    if (result.effect === 'copy') {
      const answer = [...currentSession(runtime.getSnapshot()).messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      copyText(answer?.text ?? '').then(
        () => notify(t('copied')),
        () => notify(t('clipboard unavailable')),
      );
    }
    if (result.effect === 'import') pickFiles(true);
  });
  useEffect(() => {
    const host = desktopHost();
    return host?.onAction((action) => {
      if (action === 'open-folder') {
        void openNativeWorkspace(runtime)
          .then((selected) => {
            if (selected)
              openHome(
                navigate,
                `${location.pathname}${location.search}`,
                selected,
              );
          })
          .catch((error) => notify(folderOpenMessage(error)));
      } else if (action === 'new') {
        armComposerFocus();
        openHome(navigate, `${location.pathname}${location.search}`);
      } else if (action === 'settings') navigate('/page/settings');
      else if (action === 'help') navigate('/page/help');
      else act(() => runtime.command(action));
    });
  }, [runtime, navigate, location.pathname, location.search]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (document.documentElement.dataset.keyCapture) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isDesktopSearch(event)) {
        event.preventDefault();
        searchReturnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        restoreSearchFocus.current = true;
        setQuickOpen(false);
        setSearchOpen(true);
      } else if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'p' &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        searchReturnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        restoreSearchFocus.current = true;
        setQuickOpen(true);
        setSearch('');
        setSearchOpen(true);
        return;
      }
      // Capture, and no check of the focused field: the rename box and the
      // composer stop the bubble, and Linux has no menu accelerator for this.
      if (isDesktopSettings(event)) {
        event.preventDefault();
        navigate('/page/settings');
        return;
      }
      // The desktop File menu owns Ctrl+N and opens home. Handling it here as
      // well would open it twice. The preview has no menu, so the chord is here.
      if (!desktopHost() && isDesktopNewSession(event)) {
        event.preventDefault();
        armComposerFocus();
        openHome(navigate, `${location.pathname}${location.search}`);
        return;
      }
      if (
        matchingAction(
          event,
          effectiveBindings(snapshot.settings.keybindings),
        ) === 'sidebar.toggle'
      ) {
        event.preventDefault();
        if (narrow) setSidebarOpen((open) => !open);
        else setSidebarCollapsed((closed) => !closed);
      }
    };
    addEventListener('keydown', handle, true);
    return () => removeEventListener('keydown', handle, true);
  }, [
    act,
    narrow,
    navigate,
    runtime,
    snapshot.settings.keybindings,
    location.pathname,
    location.search,
  ]);
  const activeAgent = snapshot.agents.find(
    (item) => item.id === agent && item.sessionId === session.id,
  );
  const pluginPage = pluginPages.find((item) => item.page.id === page);
  const installedPage = registry.plugins.find((plugin) =>
    plugin.pages?.some((item) => item.id === page),
  );
  const content = pluginPage ? (
    <PluginBoundary key={pluginPage.page.id} name={pluginPage.plugin.title}>
      <pluginPage.page.component sessionId={session.id} />
    </PluginBoundary>
  ) : page && installedPage ? (
    <div className="empty-state">
      <h3>{t('plugin disabled')}</h3>
      <p>{t('Records and execution state have been preserved.')}</p>
      <Button onClick={() => navigate('/page/extensions')}>
        {t('manage interface components')}
      </Button>
    </div>
  ) : page ? (
    <ManagementPage
      page={page}
      onSession={onSession}
      onDialog={onDialog}
      onPanel={onPanel}
    />
  ) : home ? (
    <Home
      requestedId={homeRequested}
      onDialog={onDialog}
      onStarted={(id) => navigate(`/session/${id}`)}
      onAttach={(accept) => void pickFiles(false, accept)}
    />
  ) : (
    <div className="session-resource-stack">
      <div className="session-resource-view" hidden={!!file}>
        {activeAgent ? (
          <SourceNavigation onFile={onAgentFile}>
            <section className="agent-record">
              <header>
                <Button onClick={() => selectAgent(null)}>
                  <ChevronLeft size={13} />
                  {t('main')}
                </Button>
                <strong>{activeAgent.name}</strong>
                <Status value={agentState(activeAgent)} />
                {activeAgent.task &&
                  snapshot.sessions.some(
                    (item) => item.id === activeAgent.id,
                  ) && (
                    <IconButton
                      label={t('open task conversation')}
                      onClick={() =>
                        perform(() => selectSessionAndNavigate(activeAgent.id))
                      }
                    >
                      <ArrowUpRight size={14} />
                    </IconButton>
                  )}
              </header>
              <div className="agent-record-body">
                <h2>{activeAgent.description}</h2>
                <Facts
                  values={{
                    [t('model')]: activeAgent.model,
                    [t('tokens')]: activeAgent.tokens,
                    [t('record')]: activeAgent.id,
                  }}
                />
                {activeAgent.messages.map((message) =>
                  message.tool ? (
                    <ToolMessage
                      key={message.id}
                      tool={message.tool}
                      ownerSessionId={activeAgent.id}
                      expanded
                      onAgent={selectAgent}
                      onFile={onAgentFile}
                    />
                  ) : (
                    <div className="message" key={message.id}>
                      <Markdown text={message.text} />
                    </div>
                  ),
                )}
              </div>
            </section>
          </SourceNavigation>
        ) : (
          <NativeResourceBoundary
            name={t('conversation')}
            resetKey={session.id}
          >
            <Conversation
              focusComposer={
                location.pathname === `/session/${session.id}`
                  ? (location.state as { focusComposer?: number } | null)
                      ?.focusComposer
                  : undefined
              }
              onDialog={onDialog}
              onPanel={onPanel}
              onAgent={selectAgent}
              onFile={onFile}
              onAttach={() => pickFiles()}
              onCommand={() => {
                setSearch('');
                setSearchOpen(true);
              }}
              finding={finding}
              setFinding={setFinding}
            />
          </NativeResourceBoundary>
        )}
      </div>
      <div className="session-resource-view" hidden={!file}>
        {file && (
          <NativeResourceBoundary name={t('editor')} resetKey={file}>
            <Suspense fallback={<p role="status">{t('opening file…')}</p>}>
              <FileViewer
                path={file}
                line={sourceLine}
                column={sourceColumn}
                resourceOwner={fileOwner}
                onDebugSource={
                  runtime.mode === 'live'
                    ? (path, line) => {
                        const owner = fileOwner?.sessionId ?? session.id;
                        perform(async () => {
                          if (owner !== runtime.getSnapshot().activeSessionId)
                            await selectSessionAndNavigate(owner);
                          if (runtime.getSnapshot().activeSessionId !== owner)
                            return;
                          setDebugSourceRequest({
                            id: crypto.randomUUID(),
                            sessionId: owner,
                            path,
                            line,
                          });
                          onPanel('activity', 'debug');
                        });
                      }
                    : undefined
                }
                onNavigate={(path, line, column) =>
                  openSource(path, line, column, fileOwner)
                }
                onClose={() => {
                  sourceOpener.current.cancel();
                  setFile(null);
                  setFileOwner(undefined);
                }}
              />
            </Suspense>
          </NativeResourceBoundary>
        )}
      </div>
    </div>
  );
  // The session's own actions, under its title as Claude has them.
  const SESSION_ACTIONS = [
    [() => t('rename'), () => act(() => runtime.command('name'))],
    [() => t('session details'), () => onDialog('session')],
    [() => t('find in conversation'), () => setFinding(true)],
    [() => t('session tree'), () => onDialog('tree')],
    [() => t('fork'), () => act(() => runtime.command('fork'))],
    [() => t('clone'), () => act(() => runtime.command('clone'))],
    [() => t('compact context'), () => act(() => runtime.command('compact'))],
    [() => t('export'), () => act(() => runtime.command('export'))],
    [() => t('share locally'), () => act(() => runtime.command('share'))],
    [() => t('undo on screen'), () => act(() => runtime.command('undo'))],
    [() => t('redo on screen'), () => act(() => runtime.command('redo'))],
  ] as const;
  const inspector = (
    <NativeResourceBoundary name={t('inspector')} resetKey={panel}>
      <Inspector
        resourcesPaused={home}
        panel={panel}
        visible={inspectorVisible}
        commandTerminal={commandTerminal}
        terminalFocusRequest={
          terminalFocusRequest?.sessionId === session.id
            ? terminalFocusRequest
            : undefined
        }
        onOpenTerminal={(target) => {
          commandRequest.current++;
          setCommandTerminal(undefined);
          setTerminalFocusRequest({
            ...target,
            requestId: crypto.randomUUID(),
            sessionId: session.id,
          });
          onPanel('terminal');
        }}
        debugSourceRequest={
          debugSourceRequest?.sessionId === session.id
            ? debugSourceRequest
            : undefined
        }
        onExitCommandTerminal={() => {
          commandRequest.current++;
          commandReturnFocus.current = undefined;
          setCommandTerminal(undefined);
        }}
        onSession={(id) => {
          perform(() => selectSessionAndNavigate(id));
        }}
        whole={whole}
        canBeWhole={canBeWhole}
        onWhole={() => setFullView((on) => !on)}
        selection={selection}
        onPanel={onPanel}
        onClose={() => {
          commandRequest.current++;
          setInspectorOpen(false);
          const previous = commandReturnFocus.current;
          if (
            panel === 'terminal' &&
            commandTerminal &&
            previous?.origin === commandOrigin.current &&
            previous.trigger.isConnected
          )
            previous.trigger.focus({ preventScroll: true });
        }}
        onFile={onFile}
        onAgent={selectAgent}
        onDialog={onDialog}
        onInteraction={(item) => {
          if (item.kind === 'secret') {
            onDialog('secret');
          } else setInteraction(item);
        }}
      />
    </NativeResourceBoundary>
  );
  const searchItems = searchOpen
    ? [
        ...[
          { id: 'new', label: t('new session') },
          { id: 'compact', label: t('compact context') },
          { id: 'fork', label: t('fork') },
          { id: 'export', label: t('export') },
          { id: 'name', label: t('rename') },
        ].map((command) => ({
          id: 'command-' + command.id,
          label: command.label,
          detail: t('command'),
          // A new session starts from the home composer, as everywhere else.
          run: () =>
            command.id === 'new'
              ? openHome(navigate, `${location.pathname}${location.search}`)
              : act(() => runtime.command(command.id)),
        })),
        ...pluginPages.map(({ page }) => ({
          id: 'plugin-' + page.id,
          label: platformTitle(page.id, page.title),
          detail: t('platform plugin'),
          run: () => navigate('/page/' + page.id),
        })),
        ...visibleSessions(snapshot.sessions).map((item) => {
          const workspace = snapshot.workspaces.find(
            (entry) => entry.id === item.workspaceId,
          );
          return {
            id: `session:${item.id}`,
            label: sessionTitle(item.title),
            detail: workspace
              ? t('session · {workspace}', {
                  workspace: workspaceLabel(workspace, snapshot.agents),
                })
              : t('session'),
            run: () => perform(() => selectSessionAndNavigate(item.id)),
          };
        }),
        ...NAVIGATION.map((item) => ({
          id: `page:${item.id}`,
          label: item.label(),
          detail: t('page'),
          run: () => navigate('/page/' + item.id),
        })),
        ...snapshot.files
          .filter((item) => item.workspaceId === session.workspaceId)
          .map((item) => ({
            id: `file:${item.id}`,
            label: item.path,
            detail: t('file'),
            run: () => onFile(item.path),
          })),
        ...visibleSessions(snapshot.sessions).flatMap((item) =>
          historyMessages(item).map((message) => ({
            id: `message:${item.id}:${message.id}`,
            label: message.text,
            detail: t('message history'),
            run: () =>
              perform(() =>
                selectSessionAndNavigate(item.id).then(() => {
                  if (
                    message.role !== 'user' ||
                    runtime.getSnapshot().activeSessionId !== item.id
                  )
                    return;
                  runtime.change((state) => {
                    const target = state.sessions.find(
                      (session) => session.id === item.id,
                    );
                    if (target) target.draft = message.text;
                  });
                }),
              ),
          })),
        ),
      ].filter(
        (item) =>
          (!quickOpen || item.detail === t('file')) &&
          (item.label + ' ' + item.detail)
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : [];
  const surface = (
    <SourceNavigation onFile={onFile}>
      <Tooltip.Provider delayDuration={300}>
        <div
          className={`workbench${sidebarCollapsed && !narrow ? ' sidebar-collapsed' : ''}`}
        >
          {desktopHost() && <div className="desktop-drag-region" />}
          <div className="desktop-sidebar">
            <Sidebar
              onSearch={() => setSearchOpen(true)}
              onDialog={onDialog}
              renaming={dialog === 'rename'}
            />
          </div>
          <main className="workspace">
            <header className="topbar">
              <div className="topbar-title">
                <IconButton
                  label={t('show or hide the sidebar')}
                  onClick={toggleSidebar}
                >
                  <PanelLeft size={16} />
                </IconButton>
                {page || file || agent || home ? (
                  <span className="page-title">
                    {home
                      ? t('new session')
                      : page
                        ? shellPageTitle(page)
                        : file
                          ? file
                          : t('agent record')}
                  </span>
                ) : (
                  <DropdownMenu.Root>
                    <h1 className="session-title">
                      <DropdownMenu.Trigger asChild>
                        <button>
                          <span>{sessionTitle(session.title)}</span>
                          <ChevronDown size={14} />
                        </button>
                      </DropdownMenu.Trigger>
                    </h1>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="dropdown"
                        align="start"
                        sideOffset={6}
                      >
                        {SESSION_ACTIONS.map(([label, run]) => (
                          <DropdownMenu.Item key={label()} onSelect={run}>
                            {label()}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                {!home && (
                  <span
                    className="project-chip"
                    title={
                      taskWorkspaceIds(snapshot.sessions, snapshot.agents).has(
                        workspace.id,
                      )
                        ? undefined
                        : workspace.path
                    }
                  >
                    <Folder size={12} />
                    {workspaceLabel(workspace, snapshot.agents)}
                    {workspace.branch && (
                      <>
                        <GitBranch size={11} />
                        {workspace.branch}
                      </>
                    )}
                  </span>
                )}
              </div>
              <div className="topbar-actions">
                {!page && !home && (
                  <PanelButtons
                    panel={panel}
                    open={inspectorOpen}
                    onPanel={(id) => onPanel(id)}
                    onClose={() => setInspectorOpen(false)}
                  />
                )}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className="icon-button" aria-label={t('more')}>
                      <MoreHorizontal size={16} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="dropdown app-menu"
                      align="end"
                      sideOffset={6}
                    >
                      <DropdownMenu.Item onSelect={() => setSearchOpen(true)}>
                        <span>{t('search')}</span>
                        {/* A visible hint. The item is still named by its words. */}
                        <kbd aria-hidden="true">
                          {formatChord(DESKTOP_SEARCH_CHORD)}
                        </kbd>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => navigate('/page/settings')}
                      >
                        <span>{t('settings')}</span>
                        <kbd aria-hidden="true">
                          {formatChord(DESKTOP_SETTINGS_CHORD)}
                        </kbd>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() =>
                          perform(() =>
                            runtime.change((state) => {
                              state.settings.theme =
                                document.documentElement.dataset.theme ===
                                'dark'
                                  ? 'light'
                                  : 'dark';
                            }),
                          )
                        }
                      >
                        {document.documentElement.dataset.theme === 'dark'
                          ? t('light theme')
                          : t('dark theme')}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() =>
                          onDialog(
                            runtime.mode === 'live' ? 'connect' : 'preview',
                          )
                        }
                      >
                        {t('connection')}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => navigate('/page/help')}
                      >
                        {t('help')}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </header>
            <div
              className={
                whole ? 'workspace-content whole' : 'workspace-content'
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  if (whole) setFullView(false);
                  else if (inspectorVisible) setInspectorOpen(false);
                }
              }}
            >
              {whole && (
                <div className="inspector-full" ref={wholeBox} tabIndex={-1} />
              )}
              <div className={whole ? 'columns whole-under' : 'columns'}>
                <Group
                  orientation="horizontal"
                  id="workbench-columns"
                  disabled={!inspectorVisible || narrow || whole}
                  data-inspector-mode={
                    inspectorVisible && !whole
                      ? narrow
                        ? 'overlay'
                        : 'split'
                      : 'closed'
                  }
                >
                  <Panel id="main" defaultSize="68%" minSize="38%">
                    <div className="main-stack">{content}</div>
                  </Panel>
                  <Separator
                    className="resize-handle"
                    style={{
                      display:
                        inspectorVisible && !narrow && !whole
                          ? undefined
                          : 'none',
                    }}
                    aria-label={t('resize inspector')}
                  />
                  <Panel
                    id="inspector"
                    minSize={narrow ? 0 : 290}
                    maxSize={narrow ? '100%' : '50%'}
                    defaultSize="32%"
                    className={
                      narrow
                        ? 'inspector-column inspector-overlay'
                        : 'inspector-column'
                    }
                    style={{
                      display: inspectorVisible && !whole ? undefined : 'none',
                    }}
                  >
                    <div
                      ref={splitInspectorBox}
                      className="inspector-resource-host"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setInspectorOpen(false);
                      }}
                    />
                  </Panel>
                </Group>
              </div>
              {createPortal(inspector, inspectorHost)}
            </div>
          </main>
          <Modal
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            title={t('navigation')}
          >
            <Sidebar
              onSearch={() => {
                setSidebarOpen(false);
                setSearchOpen(true);
              }}
              onNavigate={() => setSidebarOpen(false)}
              onDialog={onDialog}
              renaming={dialog === 'rename'}
            />
          </Modal>
          <Modal
            open={searchOpen}
            onOpenChange={setSearchOpen}
            title={quickOpen ? t('quick open') : t('search')}
            onCloseAutoFocus={(event) => {
              const target = searchReturnFocus.current;
              if (restoreSearchFocus.current && target?.isConnected) {
                event.preventDefault();
                target.focus({ preventScroll: true });
              }
              restoreSearchFocus.current = false;
              searchReturnFocus.current = null;
            }}
          >
            <SearchInput
              autoFocus
              value={search}
              onChange={setSearch}
              label={t('global search')}
              inputProps={{
                onKeyDown: (event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSearchCursor((value) =>
                      Math.max(
                        0,
                        Math.min(
                          searchItems.length - 1,
                          value + (event.key === 'ArrowDown' ? 1 : -1),
                        ),
                      ),
                    );
                  } else if (
                    event.key === 'Enter' &&
                    searchItems[searchCursor]
                  ) {
                    event.preventDefault();
                    restoreSearchFocus.current = false;
                    searchItems[searchCursor]!.run();
                    setSearchOpen(false);
                    setSearch('');
                  }
                },
              }}
              placeholder={
                quickOpen
                  ? t('search workspace files')
                  : t('sessions, files, pages or past messages')
              }
            />
            <div className="search-results">
              {search.trim() && searchItems.length === 0 ? (
                <EmptyState title={t('no results')} />
              ) : (
                searchItems.map((item, index) => (
                  <button
                    key={item.id}
                    className={index === searchCursor ? 'selected' : undefined}
                    onMouseEnter={() => setSearchCursor(index)}
                    onClick={() => {
                      restoreSearchFocus.current = false;
                      item.run();
                      setSearchOpen(false);
                      setSearch('');
                    }}
                  >
                    <Search size={14} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <ArrowUpRight size={12} />
                  </button>
                ))
              )}
            </div>
          </Modal>
          <DialogHost
            dialog={dialog}
            selection={dialogSelection}
            onClose={() => setDialog(null)}
            onSession={onSession}
          />
          <InteractionDialog
            item={
              interaction
                ? (snapshot.interactions.find(
                    (item) => item.id === interaction.id,
                  ) ?? null)
                : null
            }
            onClose={() => {
              setInteraction(null);
              if (narrow) setInspectorOpen(false);
            }}
          />
          {notice && (
            <div className="toast" role="status">
              {notice}
            </div>
          )}
        </div>
      </Tooltip.Provider>
    </SourceNavigation>
  );
  return (
    <CommandTerminalNavigation
      onOpen={runtime.mode === 'live' ? openCommandTerminal : undefined}
      onOpenUserShell={
        runtime.mode === 'live' ? openUserShellTerminal : undefined
      }
    >
      {surface}
    </CommandTerminalNavigation>
  );
}
