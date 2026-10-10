import {
  desktopHost,
  copyText,
  nativeAttachment,
  openNativeWorkspace,
  readNativeFile,
} from '../host';
import { parsePreviewBundle } from '../model/transfer';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Tooltip } from 'radix-ui';
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
} from 'lucide-react';
import { useRuntime } from './context';
import { currentSession, sessionText } from '../model/state';
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
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolMessage } from '../components/ToolMessage';
import { Conversation } from '../features/Conversation';
import { Inspector, TerminalPanel } from '../features/Panels';
import { FileViewer } from '../features/FileViewer';
import { ManagementPage } from '../features/Pages';
import { DialogHost, InteractionDialog } from '../features/Dialogs';
import { applyTheme } from '../theme';
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
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const narrow = useNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(!narrow);
  useEffect(() => {
    if (narrow) setInspectorOpen(false);
  }, [narrow]);
  const [panel, setPanel] = useState<PanelId>('files');
  const [selection, setSelection] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [dialogSelection, setDialogSelection] = useState('');
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const page = location.pathname.startsWith('/page/')
    ? (location.pathname.slice(6) as PageId)
    : null;
  const inspectorVisible = inspectorOpen && !page;
  const onSession = () => {
    setFile(null);
    setAgent(null);
    navigate(`/session/${runtime.getSnapshot().activeSessionId}`);
  };
  const onDialog = (kind: DialogId, choice = '') => {
    setDialogSelection(choice);
    setDialog(kind);
  };
  const onPanel = (kind: PanelId, choice = '') => {
    setPanel(kind);
    setSelection(choice);
    setInspectorOpen(true);
  };
  const onFile = async (path: string) => {
    try {
      await readNativeFile(runtime, path);
      setFile(path);
      setAgent(null);
      if (narrow) setInspectorOpen(false);
      onSessionRoute();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'file could not be opened',
      );
    }
  };
  const onSessionRoute = () =>
    navigate(`/session/${runtime.getSnapshot().activeSessionId}`);
  useEffect(() => {
    if (location.pathname === '/')
      navigate(`/session/${session.id}`, { replace: true });
    const id = location.pathname.startsWith('/session/')
      ? location.pathname.slice(9)
      : undefined;
    if (id && id !== session.id) {
      if (snapshot.sessions.some((item) => item.id === id))
        runtime.selectSession(id);
      else navigate(`/session/${session.id}`, { replace: true });
    }
  }, [location.pathname]);
  useEffect(() => {
    setFile(null);
    setAgent(null);
  }, [session.id]);
  useEffect(() => {
    const apply = () =>
      applyTheme(
        snapshot.settings.theme,
        snapshot.settings.uiFontSize,
        snapshot.settings.codeFontSize,
      );
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [
    snapshot.settings.theme,
    snapshot.settings.uiFontSize,
    snapshot.settings.codeFontSize,
  ]);
  const pickFiles = async (importing = false) => {
    if (desktopHost()) {
      try {
        const files = await desktopHost()!.chooseFiles(
          importing ? 'import' : 'attach',
        );
        for (const item of files) {
          if (importing) {
            if (item.name.endsWith('.json')) {
              const value = JSON.parse(item.content);
              if (value.schema === 'circle-workbench-preview/v1') {
                const imported = parsePreviewBundle(
                  item.content,
                  currentSession(runtime.getSnapshot()),
                );
                const id = runtime.newSession();
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
            const id = runtime.newSession();
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
          } else
            runtime.change((state) =>
              currentSession(state).attachments.push(nativeAttachment(item)),
            );
        }
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : 'native file selection failed',
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
                const id = runtime.newSession();
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
            const id = runtime.newSession();
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
              reader.onerror = () => reject(Error('file could not be read'));
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
          runtime.change((state) =>
            currentSession(state).attachments.push(attachment),
          );
        }
      } catch (error) {
        notify(
          error instanceof Error ? error.message : 'file could not be imported',
        );
      }
    };
    input.click();
  };
  setRouter((result) => {
    if (result.openSession) onSession();
    if (result.page) navigate('/page/' + result.page);
    if (result.dialog) onDialog(result.dialog, result.selection);
    if (result.panel) onPanel(result.panel, result.selection);
    if (result.effect === 'copy') {
      const answer = [...currentSession(runtime.getSnapshot()).messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      copyText(answer?.text ?? '').then(
        () => notify('copied'),
        () => notify('clipboard unavailable'),
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
            if (selected) onSession();
          })
          .catch((error) => notify(String(error)));
      } else if (action === 'settings') navigate('/page/settings');
      else if (action === 'help') navigate('/page/help');
      else act(() => runtime.command(action));
    });
  }, [runtime]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        ((event.metaKey && event.key === 'k') ||
          ((event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === 'p')) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    addEventListener('keydown', handle);
    return () => removeEventListener('keydown', handle);
  }, []);
  const activeAgent = snapshot.agents.find((item) => item.id === agent);
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
      <h3>plugin disabled</h3>
      <p>Records and execution state have been preserved.</p>
      <Button onClick={() => navigate('/page/extensions')}>
        manage interface components
      </Button>
    </div>
  ) : page ? (
    <ManagementPage
      page={page}
      onSession={onSession}
      onDialog={onDialog}
      onPanel={onPanel}
    />
  ) : file ? (
    <FileViewer path={file} onClose={() => setFile(null)} />
  ) : activeAgent ? (
    <section className="agent-record">
      <header>
        <Button onClick={() => setAgent(null)}>
          <ChevronLeft size={13} />
          main
        </Button>
        <strong>{activeAgent.name}</strong>
        <Status value={activeAgent.status} />
      </header>
      <div className="agent-record-body">
        <h2>{activeAgent.description}</h2>
        <Facts
          values={{
            model: activeAgent.model,
            tokens: activeAgent.tokens,
            record: activeAgent.id,
          }}
        />
        {activeAgent.messages.map((message) =>
          message.tool ? (
            <ToolMessage
              key={message.id}
              tool={message.tool}
              expanded
              onAgent={setAgent}
              onFile={onFile}
            />
          ) : (
            <div className="message" key={message.id}>
              <Markdown text={message.text} />
            </div>
          ),
        )}
      </div>
    </section>
  ) : (
    <Conversation
      onDialog={onDialog}
      onPanel={onPanel}
      onAgent={setAgent}
      onFile={onFile}
      onAttach={() => pickFiles()}
      onCommand={() => {
        setSearch('');
        setSearchOpen(true);
      }}
    />
  );
  const inspector = (
    <Inspector
      panel={panel}
      selection={selection}
      onPanel={onPanel}
      onClose={() => setInspectorOpen(false)}
      onFile={onFile}
      onAgent={setAgent}
      onDialog={onDialog}
      onInteraction={(item) => {
        if (item.kind === 'secret') {
          onDialog('secret');
        } else setInteraction(item);
      }}
    />
  );
  const searchItems = [
    ...pluginPages.map(({ page }) => ({
      id: 'plugin-' + page.id,
      label: page.title,
      detail: 'platform plugin',
      run: () => navigate('/page/' + page.id),
    })),
    ...snapshot.sessions.map((item) => ({
      id: item.id,
      label: item.title,
      detail:
        'session · ' +
        snapshot.workspaces.find(
          (workspace) => workspace.id === item.workspaceId,
        )?.name,
      run: () => {
        runtime.selectSession(item.id);
        onSession();
      },
    })),
    ...NAVIGATION.map((item) => ({
      id: item.id,
      label: item.label,
      detail: 'page',
      run: () => navigate('/page/' + item.id),
    })),
    ...snapshot.files
      .filter((item) => item.workspaceId === session.workspaceId)
      .map((item) => ({
        id: item.id,
        label: item.path,
        detail: 'file',
        run: () => onFile(item.path),
      })),
    ...snapshot.sessions.flatMap((item) =>
      item.messages
        .filter((message) => message.role === 'user')
        .map((message) => ({
          id: message.id,
          label: message.text,
          detail: 'message history',
          run: () => {
            runtime.change((state) => {
              currentSession(state).draft = message.text;
            });
            onSession();
          },
        })),
    ),
  ].filter((item) =>
    (item.label + ' ' + item.detail)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="workbench">
        {desktopHost() && <div className="desktop-drag-region" />}
        <div className="desktop-sidebar">
          <Sidebar onSearch={() => setSearchOpen(true)} />
        </div>
        <main className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <span className="mobile-only">
                <IconButton
                  label="open navigation"
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeft size={16} />
                </IconButton>
              </span>
              <Folder size={14} />
              <span>{workspace.name}</span>
              <span className="branch">
                <GitBranch size={12} />
                {workspace.branch}
              </span>
              {page && (
                <>
                  <ChevronRight size={12} />
                  <strong>{page}</strong>
                </>
              )}
            </div>
            <div className="topbar-actions">
              <IconButton label="search" onClick={() => setSearchOpen(true)}>
                <Search size={15} />
              </IconButton>
              <button
                className="preview-status"
                onClick={() => onDialog('preview')}
              >
                <i />
                preview
              </button>
              <IconButton
                label="toggle theme"
                onClick={() =>
                  perform(() =>
                    runtime.change((state) => {
                      state.settings.theme =
                        document.documentElement.dataset.theme === 'dark'
                          ? 'light'
                          : 'dark';
                    }),
                  )
                }
              >
                {document.documentElement.dataset.theme === 'dark' ? (
                  <Sun size={15} />
                ) : (
                  <Moon size={15} />
                )}
              </IconButton>
              <IconButton
                label="toggle terminal"
                onClick={() => setTerminalOpen(!terminalOpen)}
              >
                <Terminal size={16} />
              </IconButton>
              <IconButton
                label="toggle inspector"
                disabled={!!page}
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                <PanelRight size={16} />
              </IconButton>
            </div>
          </header>
          <div className="workspace-content">
            <Group orientation="horizontal" id="workbench-columns">
              <Panel
                id="main"
                defaultSize={inspectorVisible && !narrow ? '68%' : '100%'}
                minSize="38%"
              >
                <div className="main-stack">
                  {content}
                  {terminalOpen && (
                    <TerminalPanel onClose={() => setTerminalOpen(false)} />
                  )}
                </div>
              </Panel>
              {inspectorVisible && !narrow && (
                <>
                  <Separator
                    className="resize-handle"
                    aria-label="resize inspector"
                  />
                  <Panel
                    id="inspector"
                    minSize={290}
                    maxSize="50%"
                    defaultSize="32%"
                  >
                    {inspector}
                  </Panel>
                </>
              )}
            </Group>
          </div>
        </main>
        <Modal
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          title="navigation"
        >
          <Sidebar
            onSearch={() => {
              setSidebarOpen(false);
              setSearchOpen(true);
            }}
            onNavigate={() => setSidebarOpen(false)}
          />
        </Modal>
        <Modal
          open={narrow && inspectorVisible}
          onOpenChange={setInspectorOpen}
          title="inspector"
        >
          {inspector}
        </Modal>
        <Modal open={searchOpen} onOpenChange={setSearchOpen} title="search">
          <SearchInput
            value={search}
            onChange={setSearch}
            label="global search"
            placeholder="sessions, files, pages or past messages"
          />
          <div className="search-results">
            {searchItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
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
            ))}
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
          onClose={() => setInteraction(null)}
        />
        {notice && (
          <div className="toast" role="status">
            {notice}
          </div>
        )}
      </div>
    </Tooltip.Provider>
  );
}
