import { extensionStatusText } from '../model/extension-status';
import { desktopHost, folderOpenMessage, openNativeWorkspace } from '../host';
import { openHome } from '../features/home-selection';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { NavLink, useLocation, useMatch, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Settings2,
  Blocks,
  Plug,
  BookOpen,
  Command,
  ShieldCheck,
  MessagesSquare,
  Terminal,
  FolderPlus,
  Folder,
  FolderOpen,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { useRuntime } from '../app/context';
import { usePlugins } from '../plugins/context';
import { currentSession, sessionTitle } from '../model/state';
import { workspaceLabel } from '../model/workspace-label';
import {
  disambiguatedSessionTitle,
  orderedProjects,
  projectFolders,
  RECENT_SHOWN,
  recentDetails,
  recentSessions,
  sessionActivityAt,
  sidebarTasks,
  topLevelSessions,
  visibleSessions,
  type ActivityAge,
  type SidebarTask,
} from '../model/session-management';
import { agentActivityText, agentState } from '../model/activity';
import { selectedHomeProject } from '../features/home-selection';
import type { DialogId, Session } from '../model/types';
import { platformTitle } from '../plugins/labels';
import { armComposerFocus } from '../model/composer-focus';
import {
  afterSidebarChromeMove,
  afterSidebarPointerLeave,
  pointerOnSidebarChrome,
  runControlAction,
  selectRenameText,
  sessionCardVisible,
  sessionMenuTipOpen,
  shouldOpenSession,
} from '../model/session-row';
import { IconButton } from './common';
import { t, tn } from '../i18n';
import { UpdateChip } from '../features/Update';
import { SessionMenu, WorkspaceMenu } from './SessionMenus';
// The labels are functions so they follow the interface language when it changes.
export const NAVIGATION = [
  { id: 'models', label: () => t('models'), icon: Blocks },
  { id: 'skills', label: () => t('skills'), icon: BookOpen },
  { id: 'commands', label: () => t('commands'), icon: Command },
  { id: 'mcp', label: () => t('mcp servers'), icon: Plug },
  { id: 'extensions', label: () => t('extensions'), icon: Blocks },
  { id: 'tools', label: () => t('tools'), icon: Terminal },
  { id: 'approvals', label: () => t('approvals'), icon: ShieldCheck },
  { id: 'settings', label: () => t('settings'), icon: Settings2 },
] as const;
/** The pages under customize, as Claude gathers skills, connectors and tools. */
export const CUSTOMIZE = [
  'skills',
  'commands',
  'mcp',
  'extensions',
  'tools',
  'approvals',
] as const;
const SHOWN = 8;
/** Collapse state for the recent list. It is not a workspace id. */
const RECENT = 'recent';

function RenameField({
  label,
  defaultValue,
  onCommit,
  onCancel,
}: {
  label: string;
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    selectRenameText(input);
    // Focus can place a caret after this effect. Select again once it has.
    const frame = requestAnimationFrame(() => {
      if (ref.current) selectRenameText(ref.current);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <input
      ref={ref}
      className="session-rename"
      aria-label={label}
      defaultValue={defaultValue}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  );
}

export function Sidebar({
  onSearch,
  onNavigate,
  onDialog,
  renaming = false,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
  /** The rename dialog is open, so a recent hover must not stay up over it. */
  renaming?: boolean;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  // The pages of the extensions that are on, such as hub's
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const navigate = useNavigate();
  const location = useLocation();
  const current = currentSession(snapshot);
  const [all, setAll] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Task lists under a conversation, opened or closed by hand. Unset, a list
  // is open only while one of its tasks is the open session.
  const [taskFold, setTaskFold] = useState<Record<string, boolean>>({});
  const [roving, setRoving] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLAnchorElement>());
  const listRef = useRef<HTMLDivElement>(null);
  // The row at the top of the list, and how far it sits from that edge.
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  // The list's scroll before the latest update. A render must not throw it away.
  const scrollTop = useRef(0);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [menuFocus, setMenuFocus] = useState<string | null>(null);
  const menuFocusRef = useRef<string | null>(null);
  // A scroll closes popups. They stay closed until the pointer actually moves,
  // so the scroll itself cannot pin a tip over the search box.
  const [scrollClosed, setScrollClosed] = useState(false);
  const scrollClosedRef = useRef(false);
  const pointerAtScroll = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const ignoreScrollClose = useRef(false);
  // Only a real scroll (wheel, touch, or the scrollbar) dismisses a popup.
  // Focusing a row or opening a session can nudge scrollTop, and that must
  // not hide the card under a pointer that has not moved.
  const scrollGesture = useRef(false);
  const seenOrder = useRef<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  // A page change, or a press that started outside the sidebar, hides the
  // session card until the pointer really moves. The flag stays set through
  // the click, so a card that unmounts under the pointer cannot land that
  // click on a session row.
  const routeHold = useRef(false);
  const pressOutside = useRef(false);
  const pointerOpening = useRef(false);
  const openedOnPress = useRef(false);
  // Pointer leave, and moving onto the controls above the list, hide the
  // hover card without counting as a scroll, so a focused session ⋯ button
  // can still show its tip.
  const [cardSuppressed, setCardSuppressed] = useState(false);
  const path = `${location.pathname}${location.search}`;
  const pathRef = useRef(path);
  useEffect(() => {
    if (pathRef.current === path) return;
    pathRef.current = path;
    routeHold.current = true;
    setHoveredKey(null);
    pointerAtScroll.current = lastPointer.current;
    scrollClosedRef.current = true;
    setScrollClosed(true);
  }, [path]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      const inside =
        target instanceof Node && !!asideRef.current?.contains(target);
      pressOutside.current = !inside;
      if (inside) return;
      routeHold.current = true;
      setHoveredKey(null);
      pointerAtScroll.current = { x: event.clientX, y: event.clientY };
      scrollClosedRef.current = true;
      setScrollClosed(true);
    };
    // Bubble, so a row's click still sees a press that started outside.
    const onClick = () => {
      pressOutside.current = false;
    };
    // Enter activates the focused row after this. A key clears the flag first.
    const onKey = () => {
      pressOutside.current = false;
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  // The row whose title is being edited in place (F2 or rename). A session can
  // be in recent and under its folder; only one of those rows becomes a field.
  const [editing, setEditing] = useState<string | null>(null);
  const editDone = useRef(false);
  const rowKeysRef = useRef<string[]>([]);
  const beginRename = (rowKey: string) => {
    editDone.current = false;
    setEditing(rowKey);
  };
  const commitRename = (sessionId: string, value: string, previous: string) => {
    if (editDone.current) return;
    editDone.current = true;
    setEditing(null);
    const title = value.trim();
    if (!title || title === previous) return;
    perform(() =>
      runtime.change((state) => {
        const target = state.sessions.find((item) => item.id === sessionId);
        if (target) target.title = title;
      }),
    );
  };
  const cancelRename = () => {
    editDone.current = true;
    setEditing(null);
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'F2' || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (document.querySelector('[role="dialog"]')) return;
      if (document.documentElement.dataset.keyCapture) return;
      const target = event.target;
      // The composer may have focus. F2 still renames the open session.
      // The rename field itself keeps Escape and typing.
      if (target instanceof HTMLElement && target.closest('.session-rename'))
        return;
      const rowKey = rowKeysRef.current.find((key) =>
        key.endsWith(`:${snapshot.activeSessionId}`),
      );
      if (!rowKey) return;
      event.preventDefault();
      beginRename(rowKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot.activeSessionId]);
  // The route follows a session once the runtime has selected it. A slow
  // selection must not pull the person back from a page or a session they
  // opened meanwhile. The address changes as soon as they navigate, before
  // the router renders the new page, so compare the address itself.
  const sessionChoice = useRef(0);
  const goSession = async (id: string) => {
    const choice = ++sessionChoice.current;
    const address = window.location.href;
    await runtime.selectSession(id);
    if (choice !== sessionChoice.current || window.location.href !== address)
      return;
    navigate(`/session/${id}`);
    onNavigate?.();
  };
  const newSession = (workspaceId?: string) => {
    // Before the route changes, while the click or the row still owns the
    // keyboard: keys typed during the switch land in the home composer.
    armComposerFocus();
    openHome(navigate, `${location.pathname}${location.search}`, workspaceId);
    onNavigate?.();
  };
  const activityAt = (session: Session) =>
    Date.parse(sessionActivityAt(session)) || 0;
  // A home composer open for a project is that project's pending new session:
  // its folder stays on the bar, and wears the highlight until the first
  // message creates the session, which then carries it.
  const onHome = location.pathname === '/home';
  const homeParams = new URLSearchParams(location.search);
  const homeRequested = onHome
    ? homeParams.has('workspace')
      ? (homeParams.get('workspace') ?? '')
      : null
    : null;
  const aimed = onHome
    ? selectedHomeProject(
        snapshot.workspaces,
        snapshot.sessions,
        current.id,
        homeRequested,
      )
    : undefined;
  // Task and reviewer conversations fold under the conversation that started
  // them, as Claude keeps sub-agents with their parent: they are not recent
  // rows, and their worktrees are not folders.
  const topSessions = topLevelSessions(snapshot.sessions, snapshot.agents);
  const tasks = sidebarTasks(snapshot.sessions, snapshot.agents);
  const projects = projectFolders(
    snapshot.workspaces,
    topSessions,
    aimed?.id ?? null,
  );
  const recent = recentSessions(topSessions);
  const recentShown = collapsed.includes(RECENT)
    ? []
    : all.includes(RECENT)
      ? recent
      : recent.slice(0, RECENT_SHOWN);
  const groups = projects.map((workspace) => {
    const sessions = visibleSessions(topSessions)
      .filter(
        (session) =>
          session.workspaceId === workspace.id && !session.archivedAt,
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          activityAt(b) - activityAt(a) ||
          a.id.localeCompare(b.id),
      );
    const shown = collapsed.includes(workspace.id)
      ? []
      : all.includes(workspace.id)
        ? sessions
        : sessions.slice(0, SHOWN);
    return { workspace, sessions, shown };
  });
  const taskKey = (prefix: string, owner: string) => `${prefix}:${owner}`;
  const tasksOpen = (prefix: string, owner: string) =>
    taskFold[taskKey(prefix, owner)] ??
    (tasks.get(owner) ?? []).some((task) =>
      task.sessionIds.includes(current.id),
    );
  const keysFor = (sessions: Session[], prefix: string) =>
    sessions.flatMap((session) => [
      `${prefix}:${session.id}`,
      ...(tasksOpen(prefix, session.id)
        ? (tasks.get(session.id) ?? []).map(
            (task) => `${prefix}:${session.id}/task:${task.session.id}`,
          )
        : []),
    ]);
  const rowKeys = [
    ...keysFor(recentShown, RECENT),
    ...groups.flatMap((group) => keysFor(group.shown, group.workspace.id)),
  ];
  rowKeysRef.current = rowKeys;
  const orderKey = rowKeys.join('\n');
  // A new message moves rows. Keep the row that was at the top of the view there.
  // Hovering must not run this: a scroll event would close the card that just opened.
  useLayoutEffect(() => {
    const focused = menuFocusRef.current;
    if (focused && !rowKeys.includes(focused)) {
      menuFocusRef.current = null;
      setMenuFocus(null);
    }
    const list = listRef.current;
    const previous = seenOrder.current;
    seenOrder.current = orderKey;
    const saved = anchor.current;
    const remember = () => {
      if (list) scrollTop.current = list.scrollTop;
    };
    if (list && previous !== null && previous !== orderKey) {
      // Stay with the newest row when the list was already at the top.
      // Otherwise put back a position the update cleared.
      if (scrollTop.current <= 1) list.scrollTop = 0;
      else if (list.scrollTop === 0) list.scrollTop = scrollTop.current;
    }
    if (previous === null || previous === orderKey || !list || !saved) {
      remember();
      return;
    }
    if (list.scrollTop <= 1) {
      anchor.current = listAnchor(list);
      remember();
      return;
    }
    const row = [...list.querySelectorAll<HTMLElement>('[data-row-key]')].find(
      (item) => item.dataset.rowKey === saved.key,
    );
    if (!row) return;
    const delta =
      row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const error = delta - saved.delta;
    if (Math.abs(error) > 1) list.scrollTop += error;
    anchor.current = listAnchor(list);
    remember();
  });
  const tabKey =
    roving && rowKeys.includes(roving)
      ? roving
      : (rowKeys.find((key) => key === `recent:${current.id}`) ??
        rowKeys.find((key) => key.endsWith(`:${current.id}`)) ??
        rowKeys[0]);
  const onRowKeyDown = (
    rowKey: string,
    event: KeyboardEvent<HTMLAnchorElement>,
  ) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const next =
      rowKeys[rowKeys.indexOf(rowKey) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    setRoving(next);
    revealRow(next);
  };
  const revealRow = (key: string) => {
    const link = anchors.current.get(key);
    const list = listRef.current;
    link?.focus({ preventScroll: true });
    if (!link || !list) return;
    const row = link.closest('.session-row') ?? link;
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    ignoreScrollClose.current = true;
    if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom)
      list.scrollTop += rowBox.bottom - listBox.bottom;
    ignoreScrollClose.current = false;
    anchor.current = listAnchor(list);
  };
  const pointRow = (key: string, point: { x: number; y: number }) => {
    lastPointer.current = point;
    const origin = pointerAtScroll.current;
    if (scrollClosedRef.current && origin) {
      const moved = Math.hypot(point.x - origin.x, point.y - origin.y);
      if (moved < 4) return;
    }
    pointerAtScroll.current = null;
    scrollClosedRef.current = false;
    routeHold.current = false;
    setScrollClosed(false);
    setCardSuppressed(false);
    setHoveredKey(key);
  };
  const leaveRow = (key: string) => {
    setHoveredKey((current) => (current === key ? null : current));
  };
  const claimMenu = (key: string | null) => {
    menuFocusRef.current = key;
    setMenuFocus(key);
    if (!key) return;
    // Focus takes ownership from a pointer resting over a different row.
    // A later pointer movement can still hand the popup back to that row.
    setHoveredKey(null);
    pointerAtScroll.current = null;
    scrollClosedRef.current = false;
    setScrollClosed(false);
    setCardSuppressed(false);
  };
  // The pointer is still on a row after a click. Put that row's card back if
  // the click's render dropped it.
  const keepHover = () => {
    requestAnimationFrame(() => {
      if (routeHold.current) return;
      const point = lastPointer.current;
      if (!point || menuFocusRef.current) return;
      const hit = document.elementFromPoint(point.x, point.y);
      const key =
        hit instanceof Element
          ? hit.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey
          : undefined;
      if (!key) return;
      pointerAtScroll.current = null;
      scrollClosedRef.current = false;
      setScrollClosed(false);
      setHoveredKey(key);
    });
  };
  const waiting = new Set(
    snapshot.interactions
      .filter((item) => item.status === 'pending')
      .map((item) => item.sessionId),
  );
  const toggle = (id: string, list: string[], set: (ids: string[]) => void) =>
    set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const sessionRow = (session: Session, rowKey: string, task?: SidebarTask) => {
    const base = recentDetails(session, snapshot.workspaces);
    return (
      <SessionRow
        key={rowKey}
        rowKey={rowKey}
        session={session}
        // A task row says the task's name, as the tasks panel does. Short ids
        // that tell same-titled conversations apart are not shown for tasks.
        label={
          task?.agent.name.trim() ||
          disambiguatedSessionTitle(session, snapshot.sessions)
        }
        tabIndex={rowKey === tabKey ? 0 : -1}
        // A task row says its state on hover; its worktree is not a folder to name.
        details={
          task
            ? {
                ...base,
                project: undefined,
                state: agentActivityText(task.agent),
              }
            : base
        }
        task={task ? agentState(task.agent) : undefined}
        renaming={renaming}
        editing={editing === rowKey}
        onRename={() => beginRename(rowKey)}
        onRenameCommit={(value) =>
          commitRename(session.id, value, session.title)
        }
        onRenameCancel={cancelRename}
        attention={
          task
            ? task.sessionIds.some((id) => waiting.has(id))
            : waiting.has(session.id)
        }
        running={session.state === 'waiting'}
        onOpen={(id) => {
          perform(async () => {
            await goSession(id);
          });
        }}
        onKeyDown={(event) => onRowKeyDown(rowKey, event)}
        onFocusRow={() => {
          setRoving(rowKey);
          // The press that opens a row focuses it too. That focus must not
          // bring the card back over the page the press just opened.
          if (pointerOpening.current) return;
          routeHold.current = false;
          scrollClosedRef.current = false;
          setScrollClosed(false);
          setCardSuppressed(false);
        }}
        pressOutside={pressOutside}
        pointerOpening={pointerOpening}
        hovered={hoveredKey === rowKey}
        hoveredKey={hoveredKey}
        menuFocus={menuFocus}
        scrollClosed={scrollClosed}
        cardSuppressed={cardSuppressed}
        listRef={listRef}
        onPoint={(point) => pointRow(rowKey, point)}
        onPointerLeave={() => leaveRow(rowKey)}
        onMenuFocus={claimMenu}
        onKeepHover={keepHover}
        linkRef={(node) => {
          if (node) anchors.current.set(rowKey, node);
          else anchors.current.delete(rowKey);
        }}
        onDialog={onDialog}
      />
    );
  };
  const sessionRows = (sessions: Session[], prefix: string) =>
    sessions.map((session) => {
      const rowKey = `${prefix}:${session.id}`;
      const owned = tasks.get(session.id) ?? [];
      if (!owned.length) return sessionRow(session, rowKey);
      const open = tasksOpen(prefix, session.id);
      const asking = owned.some((task) =>
        task.sessionIds.some((id) => waiting.has(id)),
      );
      const working = owned.some((task) =>
        ['running', 'preparing', 'queued', 'cancelling'].includes(
          agentState(task.agent),
        ),
      );
      return (
        <div className="session-with-tasks" key={rowKey}>
          {sessionRow(session, rowKey)}
          <button
            type="button"
            className="session-tasks-toggle"
            aria-expanded={open}
            onClick={() =>
              setTaskFold((fold) => ({
                ...fold,
                [taskKey(prefix, session.id)]: !open,
              }))
            }
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{tn(owned.length, '{n} task', '{n} tasks')}</span>
            {asking ? (
              <i className="attention-dot" />
            ) : working ? (
              <i className="running-dot" />
            ) : null}
          </button>
          {open && (
            <div
              className="session-tasks"
              role="group"
              aria-label={t('tasks of {name}', {
                name: disambiguatedSessionTitle(session, snapshot.sessions),
              })}
            >
              {owned.map((task) =>
                sessionRow(
                  task.session,
                  `${rowKey}/task:${task.session.id}`,
                  task,
                ),
              )}
            </div>
          )}
        </div>
      );
    });
  const customizing = CUSTOMIZE.some(
    (id) => location.pathname === '/page/' + id,
  );
  const connection =
    runtime.mode !== 'live'
      ? 'preview'
      : !snapshot.runtime?.connected
        ? 'stopped'
        : snapshot.runtime.configured
          ? 'ready'
          : 'not-configured';
  return (
    <aside
      ref={asideRef}
      className="sidebar"
      onPointerMove={(event) => {
        // Moving onto 新会话 while a session card is open used to spend the
        // first click closing that card. Fold the card before the press.
        // This is not a scroll, and it does not blur the row: a focused ⋯
        // tip stays open.
        if (!pointerOnSidebarChrome(event.target)) return;
        const next = afterSidebarChromeMove(scrollClosedRef.current);
        if (next.scrollClosed !== scrollClosedRef.current) {
          scrollClosedRef.current = next.scrollClosed;
          setScrollClosed(next.scrollClosed);
        }
        if (hoveredKey === null && cardSuppressed) return;
        setHoveredKey(null);
        setCardSuppressed(next.suppressCard);
      }}
      onPointerLeave={() => {
        // The card is drawn over the page. Leaving the sidebar drops it,
        // including when the row stays focused. This is not a scroll: a
        // focused ⋯ button keeps its tip.
        const next = afterSidebarPointerLeave(scrollClosedRef.current);
        routeHold.current = true;
        setHoveredKey(null);
        if (lastPointer.current) pointerAtScroll.current = lastPointer.current;
        setCardSuppressed(next.suppressCard);
        if (next.scrollClosed !== scrollClosedRef.current) {
          scrollClosedRef.current = next.scrollClosed;
          setScrollClosed(next.scrollClosed);
        }
      }}
    >
      <header className="brand">
        <span className="circle-logo" />
        <strong>circle</strong>
      </header>
      <button className="sidebar-search" onClick={onSearch}>
        <Search size={14} />
        <span>{t('search')}</span>
      </button>
      <nav className="sidebar-primary">
        <button
          className="sidebar-item"
          onPointerDown={(event) => {
            if (
              !runControlAction({
                kind: 'press',
                button: event.button,
                actedOnPress: false,
              })
            )
              return;
            openedOnPress.current = true;
            newSession();
          }}
          onClick={() => {
            const again = runControlAction({
              kind: 'click',
              button: 0,
              actedOnPress: openedOnPress.current,
            });
            openedOnPress.current = false;
            if (again) newSession();
          }}
        >
          <Plus size={15} />
          <span>{t('new session')}</span>
        </button>
        <NavLink
          to="/page/skills"
          className={customizing ? 'sidebar-item active' : 'sidebar-item'}
          onClick={onNavigate}
        >
          <SlidersHorizontal size={15} />
          <span>{t('customize')}</span>
        </NavLink>
        <NavLink
          to="/page/sessions"
          className={({ isActive }) =>
            isActive ? 'sidebar-item active' : 'sidebar-item'
          }
          onClick={onNavigate}
        >
          <MessagesSquare size={15} />
          <span>{t('all sessions')}</span>
        </NavLink>
      </nav>
      {pluginPages.length > 0 && (
        <nav className="sidebar-primary" aria-label={t('platform')}>
          <div className="section-label">
            <span>{t('platform')}</span>
          </div>
          {pluginPages.map(({ page }) => (
            <NavLink
              key={page.id}
              to={`/page/${page.id}`}
              className={({ isActive }) =>
                isActive ? 'sidebar-item active' : 'sidebar-item'
              }
              onClick={onNavigate}
            >
              <page.icon size={15} />
              <span>{platformTitle(page.id, page.title)}</span>
            </NavLink>
          ))}
        </nav>
      )}
      <div
        className="project-list"
        ref={listRef}
        onPointerMove={(event) => {
          lastPointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget)
            scrollGesture.current = true;
        }}
        onWheel={() => {
          scrollGesture.current = true;
        }}
        onTouchMove={() => {
          scrollGesture.current = true;
        }}
        onScroll={(event) => {
          scrollTop.current = event.currentTarget.scrollTop;
          anchor.current = listAnchor(event.currentTarget);
          if (
            ignoreScrollClose.current ||
            !scrollGesture.current ||
            scrollClosedRef.current
          )
            return;
          scrollGesture.current = false;
          pointerAtScroll.current = lastPointer.current;
          scrollClosedRef.current = true;
          setScrollClosed(true);
          setHoveredKey(null);
        }}
      >
        {recent.length > 0 && (
          <section className="project">
            <div className="project-header">
              <button
                className="project-name"
                aria-expanded={!collapsed.includes(RECENT)}
                onClick={() => toggle(RECENT, collapsed, setCollapsed)}
              >
                {t('recent')}
              </button>
            </div>
            {sessionRows(recentShown, RECENT)}
            {!collapsed.includes(RECENT) && recent.length > RECENT_SHOWN && (
              <button
                className="text-button show-more"
                onClick={() => toggle(RECENT, all, setAll)}
              >
                {all.includes(RECENT)
                  ? t('show less')
                  : t('show {n} more', { n: recent.length - RECENT_SHOWN })}
              </button>
            )}
          </section>
        )}
        {groups.map(({ workspace, sessions, shown }) => {
          const label = workspaceLabel(workspace, snapshot.agents);
          const open = all.includes(workspace.id);
          const isAimed = aimed?.id === workspace.id;
          const folded = collapsed.includes(workspace.id);
          return (
            <section className="project" key={workspace.id}>
              <div
                className={`project-header${isAimed ? ' aimed' : ''}`}
                title={workspace.path}
                onPointerMove={(event) =>
                  pointRow('header', { x: event.clientX, y: event.clientY })
                }
                onPointerLeave={() => leaveRow('header')}
              >
                <button
                  className="project-name"
                  aria-expanded={!folded}
                  onClick={() => toggle(workspace.id, collapsed, setCollapsed)}
                >
                  {/* The folder opens with the group, the way a file list does. */}
                  {folded ? <Folder size={13} /> : <FolderOpen size={13} />}
                  <span>{label}</span>
                </button>
                <div className="project-actions">
                  <IconButton
                    label={t('new session in {name}', { name: label })}
                    tipOpen={scrollClosed ? false : undefined}
                    onClick={() => newSession(workspace.id)}
                  >
                    <Plus size={13} />
                  </IconButton>
                  <WorkspaceMenu
                    workspace={{ ...workspace, name: label }}
                    tipOpen={scrollClosed ? false : undefined}
                    onNew={() => newSession(workspace.id)}
                    onCollapseAll={() =>
                      setCollapsed([
                        ...(recent.length > 0 ? [RECENT] : []),
                        ...projects.map((item) => item.id),
                      ])
                    }
                  />
                </div>
              </div>
              {sessionRows(shown, workspace.id)}
              {!collapsed.includes(workspace.id) && sessions.length > SHOWN && (
                <button
                  className="text-button show-more"
                  onClick={() => toggle(workspace.id, all, setAll)}
                >
                  {open
                    ? t('show less')
                    : t('show {n} more', { n: sessions.length - SHOWN })}
                </button>
              )}
            </section>
          );
        })}
        {desktopHost() && (
          <button
            className="sidebar-item"
            onClick={async () => {
              try {
                const selected = await openNativeWorkspace(runtime);
                if (selected) {
                  openHome(
                    navigate,
                    `${location.pathname}${location.search}`,
                    selected,
                  );
                  onNavigate?.();
                }
              } catch (error) {
                notify(folderOpenMessage(error));
              }
            }}
          >
            <FolderPlus size={15} />
            <span>{t('open folder')}</span>
          </button>
        )}
      </div>
      <UpdateChip />
      {snapshot.extensions.some((item) => item.status) && (
        <div className="extension-status" aria-label={t('extension status')}>
          {snapshot.extensions.map((item) =>
            item.status ? (
              <span
                key={item.id}
                className={`status extension-lamp-${item.status.lamp}`}
                title={item.name}
              >
                <i />
                {extensionStatusText(item)}
              </span>
            ) : null,
          )}
        </div>
      )}
      <footer className="sidebar-footer">
        <button
          className="connection-status"
          data-state={connection}
          onClick={() => {
            if (connection === 'ready') navigate('/page/models');
            else onDialog?.(connection === 'preview' ? 'preview' : 'connect');
            onNavigate?.();
          }}
        >
          <i />
          <span>
            {connection === 'preview'
              ? t('frontend preview')
              : connection === 'stopped'
                ? t('runtime stopped')
                : connection === 'not-configured'
                  ? t('connect a model')
                  : current.model}
          </span>
        </button>
        <button
          type="button"
          className="sidebar-settings"
          onClick={() => {
            navigate('/page/settings');
            onNavigate?.();
          }}
        >
          <Settings2 size={15} />
          <span>{t('settings')}</span>
        </button>
      </footer>
    </aside>
  );
}

function SessionRow({
  rowKey,
  session,
  label,
  tabIndex,
  details,
  renaming,
  editing,
  onRename,
  onRenameCommit,
  onRenameCancel,
  attention,
  running,
  task,
  onOpen,
  onKeyDown,
  onFocusRow,
  hovered,
  hoveredKey,
  menuFocus,
  scrollClosed,
  cardSuppressed,
  listRef,
  onPoint,
  onPointerLeave,
  onMenuFocus,
  onKeepHover,
  linkRef,
  onDialog,
  pressOutside,
  pointerOpening,
}: {
  rowKey: string;
  session: Session;
  label: string;
  tabIndex: number;
  details: RowDetails;
  renaming: boolean;
  /** The title is being edited in place, so the row is a text field. */
  editing: boolean;
  onRename: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  attention: boolean;
  running: boolean;
  /** The row is a task under its conversation, in this state. */
  task?: string;
  onOpen: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => void;
  onFocusRow: () => void;
  hovered: boolean;
  hoveredKey: string | null;
  menuFocus: string | null;
  scrollClosed: boolean;
  cardSuppressed: boolean;
  listRef: { current: HTMLDivElement | null };
  onPoint: (point: { x: number; y: number }) => void;
  onPointerLeave: () => void;
  onMenuFocus: (key: string | null) => void;
  onKeepHover: () => void;
  linkRef: (node: HTMLAnchorElement | null) => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
  pressOutside: { current: boolean };
  pointerOpening: { current: boolean };
}) {
  // A function class would be stringified by the tooltip trigger, so the
  // active row would lose its highlight. The same path is used in a project
  // group, and both rows highlight together.
  const active = useMatch({ path: `/session/${session.id}`, end: true });
  const menuButton = useRef<HTMLButtonElement>(null);
  const linkNode = useRef<HTMLAnchorElement>(null);
  // The press already opened the row. The click that follows must not do it again.
  const pressed = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkFocused, setLinkFocused] = useState(false);
  const [inView, setInView] = useState(true);
  useLayoutEffect(() => {
    const row = menuButton.current?.closest('.session-row') ?? null;
    const visible = rowInView(row, listRef.current);
    setInView((current) => (current === visible ? current : visible));
  });
  const aim = (event: { clientX: number; clientY: number }) =>
    onPoint({ x: event.clientX, y: event.clientY });
  // The card follows the pointer. The tooltip library drops the hover that
  // arrives just after another tip closes, so it cannot be the thing that opens it.
  // The focused … button owns the popup while the pointer rests on its row
  // or nowhere. Moving onto another row lets that row's card replace the tip.
  const keyboardOwns =
    menuFocus !== null && (hoveredKey === null || hoveredKey === menuFocus);
  const cardOpen = sessionCardVisible({
    renaming,
    editing,
    menuOpen,
    keyboardOwns,
    suppressed: scrollClosed || cardSuppressed,
    hovered,
    focused: linkFocused,
    pointerIdle: hoveredKey === null,
  });
  const openFromPointer = (event: {
    button: number;
    detail: number;
    clientX: number;
    clientY: number;
    target: EventTarget | null;
    currentTarget: HTMLAnchorElement;
  }) =>
    !pressOutside.current &&
    shouldOpenSession({
      button: event.button,
      detail: event.detail,
      clientX: event.clientX,
      clientY: event.clientY,
      targetInside:
        event.target instanceof Node &&
        event.currentTarget.contains(event.target),
      rect: event.currentTarget.getBoundingClientRect(),
    });
  const tipOpen = sessionMenuTipOpen({
    keyboardOwns,
    menuFocused: menuFocus === rowKey,
    editing,
    menuOpen,
    scrollClosed,
    inView,
  });
  const row = (
    <div
      className={task ? 'session-row task-row' : 'session-row'}
      data-row-key={rowKey}
      onPointerEnter={aim}
      onPointerMove={aim}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {editing ? (
        <>
          <RenameField
            label={t('rename session')}
            defaultValue={session.title === 'new session' ? '' : session.title}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
          <span className="session-menu-gap" aria-hidden="true" />
        </>
      ) : (
        <>
          <NavLink
            ref={(node) => {
              linkNode.current = node;
              linkRef(node);
            }}
            tabIndex={tabIndex}
            className={active ? 'session-link active' : 'session-link'}
            end
            to={`/session/${session.id}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const target = event.target;
              if (target instanceof Element && target.closest('button')) return;
              if (!openFromPointer(event)) return;
              // Open on the press. A re-render between press and click used to
              // drop the first click, so the row looked like it ignored it.
              pointerOpening.current = true;
              linkNode.current?.focus({ preventScroll: true });
              pressed.current = true;
              onOpen(session.id);
              pointerOpening.current = false;
            }}
            onClick={(event) => {
              event.preventDefault();
              const open = openFromPointer(event);
              if (!pressed.current && open) onOpen(session.id);
              pressed.current = false;
              if (open) onKeepHover();
            }}
            onFocus={() => {
              setLinkFocused(true);
              onFocusRow();
            }}
            onBlur={() => setLinkFocused(false)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowRight' &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                menuButton.current?.focus({ preventScroll: true });
              } else if (menuKey(event)) {
                event.preventDefault();
                setMenuOpen(true);
              } else onKeyDown(event);
            }}
          >
            <span>{label}</span>
            {attention ? (
              <i className="attention-dot" />
            ) : task ? (
              <i className="task-dot" data-state={task} />
            ) : running ? (
              <i className="running-dot" />
            ) : null}
          </NavLink>
          <SessionMenu
            session={session}
            buttonRef={menuButton}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            tipOpen={tipOpen}
            onFocus={() => onMenuFocus(rowKey)}
            onBlur={() => onMenuFocus(null)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowLeft' &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                linkNode.current?.focus({ preventScroll: true });
              } else if (menuKey(event)) {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
            onRename={onRename}
            onDialog={(dialog, selection) => onDialog?.(dialog, selection)}
          />
        </>
      )}
    </div>
  );
  return (
    <RecentHover details={details} open={cardOpen}>
      {row}
    </RecentHover>
  );
}

function listAnchor(list: HTMLElement) {
  const listTop = list.getBoundingClientRect().top;
  let chosen: HTMLElement | null = null;
  let delta = 0;
  for (const row of list.querySelectorAll<HTMLElement>('[data-row-key]')) {
    const next = row.getBoundingClientRect().top - listTop;
    if (next <= 1) {
      chosen = row;
      delta = next;
    } else if (!chosen) {
      chosen = row;
      delta = next;
      break;
    } else break;
  }
  const key = chosen?.dataset.rowKey;
  return key ? { key, delta } : null;
}

function rowInView(row: Element | null, list: HTMLElement | null) {
  if (!row || !list) return false;
  const listBox = list.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  return rowBox.bottom > listBox.top + 1 && rowBox.top < listBox.bottom - 1;
}

function menuKey(event: { key: string; shiftKey: boolean }) {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

function activityLabel(age: ActivityAge): string {
  if (age.kind === 'raw') return age.text;
  if (age.kind === 'just now') return t('just now');
  if (age.kind === 'minutes')
    return tn(age.n, '{n} minute ago', '{n} minutes ago');
  if (age.kind === 'hours') return tn(age.n, '{n} hour ago', '{n} hours ago');
  return tn(age.n, '{n} day ago', '{n} days ago');
}

type RowDetails = {
  project?: string;
  age: ActivityAge;
  absolute?: string;
  /** A task's state, in words. */
  state?: string;
};

function RecentHover({
  details,
  open,
  children,
}: {
  details: RowDetails;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root open={open} onOpenChange={() => {}} disableHoverableContent>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="tooltip session-hover"
          side="right"
          align="start"
          sideOffset={8}
          avoidCollisions={false}
        >
          {details.project ? <span>{details.project}</span> : null}
          {details.state ? <span>{details.state}</span> : null}
          <span>{activityLabel(details.age)}</span>
          {details.absolute ? <span>{details.absolute}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
