import { desktopHost, openNativeWorkspace } from '../host';
import { usePlugins } from '../plugins/context';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Plus,
  Folder,
  ChevronDown,
  Search,
  Settings2,
  Blocks,
  Plug,
  BookOpen,
  Command,
  ShieldCheck,
  MessagesSquare,
  ChevronRight,
  Terminal,
  Check,
  ChevronsUpDown,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { Button, IconButton, Modal } from './common';
export const NAVIGATION = [
  { id: 'models', label: 'models', icon: Blocks },
  { id: 'skills', label: 'skills', icon: BookOpen },
  { id: 'commands', label: 'commands', icon: Command },
  { id: 'mcp', label: 'mcp servers', icon: Plug },
  { id: 'extensions', label: 'extensions', icon: Blocks },
  { id: 'tools', label: 'tools', icon: Terminal },
  { id: 'approvals', label: 'approvals', icon: ShieldCheck },
  { id: 'settings', label: 'settings', icon: Settings2 },
] as const;
export function Sidebar({
  onSearch,
  onNavigate,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const navigate = useNavigate();
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const current = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === current.workspaceId,
  )!;
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const goSession = (id: string) => {
    runtime.selectSession(id);
    navigate(`/session/${id}`);
    onNavigate?.();
  };
  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="circle-logo" />
        <strong>circle</strong>
        <span>workbench</span>
      </header>
      <button
        className="workspace-switch"
        onClick={() => setWorkspacesOpen(true)}
      >
        <span className="workspace-icon">
          <Folder size={17} />
        </span>
        <span>
          <strong>{workspace.name}</strong>
          <small>{workspace.branch}</small>
        </span>
        <ChevronsUpDown size={12} />
      </button>
      <div className="sidebar-actions">
        <Button
          className="new-session"
          onClick={() => {
            const id = runtime.newSession();
            navigate(`/session/${id}`);
            onNavigate?.();
          }}
        >
          <Plus size={15} />
          new session
        </Button>
        <IconButton label="search workbench" onClick={onSearch}>
          <Search size={16} />
        </IconButton>
      </div>
      <div className="session-list">
        <div className="section-label">
          <span>sessions</span>
          <button
            onClick={() => {
              navigate('/page/sessions');
              onNavigate?.();
            }}
          >
            all
            <ChevronRight size={11} />
          </button>
        </div>
        {snapshot.sessions
          .filter((session) => session.workspaceId === current.workspaceId)
          .sort((a, b) => Number(b.pinned) - Number(a.pinned))
          .map((session) => (
            <NavLink
              key={session.id}
              className={({ isActive }) =>
                isActive ? 'session-link active' : 'session-link'
              }
              to={`/session/${session.id}`}
              onClick={() => {
                runtime.selectSession(session.id);
                onNavigate?.();
              }}
            >
              <MessagesSquare size={13} />
              <span>{session.title}</span>
              {session.state === 'waiting' && <i className="running-dot" />}
              {session.state === 'paused' && <span className="small">Ⅱ</span>}
            </NavLink>
          ))}
      </div>
      <nav className="sidebar-nav">
        {pluginPages.length > 0 && (
          <div className="section-label">
            <span>platform</span>
          </div>
        )}
        {pluginPages.map(({ plugin, page }) => (
          <NavLink key={page.id} to={`/page/${page.id}`} onClick={onNavigate}>
            <page.icon size={15} />
            <span>{page.title}</span>
          </NavLink>
        ))}
        {pluginPages.length > 0 && (
          <div className="section-label">
            <span>circle</span>
          </div>
        )}
        {NAVIGATION.map((item) => (
          <NavLink key={item.id} to={`/page/${item.id}`} onClick={onNavigate}>
            <item.icon size={15} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <span>
          <i />
          frontend preview
        </span>
        <button
          aria-label="help"
          onClick={() => {
            navigate('/page/help');
            onNavigate?.();
          }}
        >
          ?
        </button>
      </footer>
      <Modal
        open={workspacesOpen}
        onOpenChange={setWorkspacesOpen}
        title="workspaces"
      >
        {snapshot.workspaces.map((item) => (
          <button
            className="workspace-choice"
            key={item.id}
            onClick={() => {
              const session = snapshot.sessions.find(
                (candidate) => candidate.workspaceId === item.id,
              );
              const id = session?.id ?? runtime.newSession(item.id);
              goSession(id);
              setWorkspacesOpen(false);
            }}
          >
            <Folder size={18} />
            <span>
              <strong>{item.name}</strong>
              <small>{item.path}</small>
            </span>
            {workspace.id === item.id && <Check size={14} />}
          </button>
        ))}
        {desktopHost() && (
          <Button
            onClick={async () => {
              try {
                const selected = await openNativeWorkspace(runtime);
                if (selected) {
                  navigate('/session/' + runtime.getSnapshot().activeSessionId);
                  setWorkspacesOpen(false);
                  onNavigate?.();
                }
              } catch (error) {
                notify(
                  error instanceof Error
                    ? error.message
                    : 'folder could not be opened',
                );
              }
            }}
          >
            <Folder size={14} />
            open folder
          </Button>
        )}
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newPath.trim()) return;
            perform(() => {
              const id = crypto.randomUUID();
              runtime.change((state) =>
                state.workspaces.push({
                  id,
                  name: newPath.split('/').filter(Boolean).at(-1) ?? newPath,
                  path: newPath,
                  branch: 'not connected',
                  trusted: false,
                  instructions: [],
                }),
              );
              const sessionId = runtime.newSession(id);
              navigate(`/session/${sessionId}`);
              setWorkspacesOpen(false);
              setNewPath('');
            });
          }}
        >
          <label>
            workspace path
            <input
              aria-label="workspace path"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="/path/to/project"
            />
          </label>
          <p className="panel-note">
            Adds a local preview entry. No directory is read.
          </p>
          <Button type="submit">add workspace preview</Button>
        </form>
      </Modal>
    </aside>
  );
}
